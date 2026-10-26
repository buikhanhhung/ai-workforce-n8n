// Workflow A — CEO Planning:
// Webhook -> Validate Request -> Load Employee Catalog -> CEO Planner Agent (structured output)
// -> Validate Task Plan (ids, employees, dependencies, cycles) -> Save Plan -> Start Dispatcher -> 202
// Invalid plans are stored as 'rejected' with explicit errors and never executed.
const { WorkflowBuilder } = require('../lib/n8n-builders');
const { WORKFLOW_IDS, WORKFLOW_NAMES } = require('../lib/ids');

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    task_id: { type: 'string', description: 'Short unique id, e.g. T1' },
    task_name: { type: 'string' },
    description: { type: 'string' },
    assigned_employee_id: { type: 'string' },
    department_id: { type: 'string' },
    input_data: { type: 'object', description: 'Task-specific parameters for the employee' },
    depends_on: { type: 'array', items: { type: 'string' } },
    expected_output: { type: 'string' },
    acceptance_criteria: { type: 'array', items: { type: 'string' } },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    requires_approval: { type: 'boolean' },
    max_retries: { type: 'integer' },
  },
  required: ['task_id', 'task_name', 'description', 'assigned_employee_id', 'department_id', 'input_data',
             'depends_on', 'expected_output', 'acceptance_criteria', 'priority'],
};

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    plan_summary: { type: 'string' },
    tasks: { type: 'array', items: TASK_SCHEMA },
    out_of_scope: {
      type: 'array',
      description: 'Parts of the objective that no listed employee is qualified to do (not planned)',
      items: { type: 'object', properties: { request: { type: 'string' }, reason: { type: 'string' },
                                             suggested_department: { type: 'string' } }, required: ['request', 'reason'] },
    },
  },
  required: ['plan_summary', 'tasks', 'out_of_scope'],
};

const PLANNER_SYSTEM = [
  'You are the CEO Planner of an AI company. You plan; you never execute work yourself.',
  'Given a business objective and the employee catalog, produce the smallest task plan that fully achieves it.',
  'Rules:',
  '1. Only assign employees from the catalog, using their exact employee_id and department_id.',
  '2. Each task is one employee doing one job matching its skills. Do not create tasks that no employee can do.',
  '3. depends_on lists task_ids whose OUTPUT the task needs. Independent tasks must have no dependencies so they run in parallel.',
  '4. No circular dependencies. task_ids must be unique (T1, T2, ...).',
  '5. Do NOT create review, approval, aggregation or "return final deliverables" tasks: the CEO Reviewer and a human approver do that automatically after all tasks finish.',
  '6. Every task automatically receives the full shared request context (transcripts, brand guidelines, data). Never copy',
  '   context text into input_data. To pass a context entry under a different parameter name, use the exact string',
  '   "context.<key>" (e.g. "source_text": "context.transcript"); it is resolved to the real value before execution.',
  '7. Put task-specific parameters in input_data (e.g. formats, dimensions, style, question).',
  '8. acceptance_criteria are concrete, checkable statements. expected_output describes the deliverable.',
  '9. requires_approval is normally false: final deliverables ALWAYS get human approval after the CEO review. Set it true only',
  '   when a later task would itself send or publish the output externally (no current employee publishes anything).',
  '10. Avoid unnecessary or unrelated tasks. Typical plans have 1-6 tasks.',
  '11. Never give a task to an employee whose skills do not fit it. If part of the objective needs a skill no listed',
  '    employee has, leave it out of tasks and describe it in out_of_scope (with the department that should do it).',
  '    If nothing can be done by the listed employees, return tasks = [] and explain everything in out_of_scope.',
  '12. If the requester asks WHO should do a job or WHICH employee/skill fits (staffing advice, "not sure who to assign"),',
  '    the deliverable is the recommendation, not the job: assign it to the employee whose skills cover task analysis and',
  '    capability matching, and do not also create tasks that perform the job itself.',
].join('\n');

module.exports = function buildPlanningWorkflow() {
  const wb = new WorkflowBuilder(WORKFLOW_IDS.planning, WORKFLOW_NAMES[WORKFLOW_IDS.planning], { executionTimeout: 300 });

  wb.webhook('Business Request', 'POST', 'workforce/requests', [0, 0]);

  wb.code('Validate Request', function () {
    const body = $json.body || {};
    const errors = [];
    const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
    if (objective.length < 10 || objective.length > 4000) errors.push('objective must be a string of 10-4000 characters');
    const context = body.context === undefined ? {} : body.context;
    if (typeof context !== 'object' || context === null || Array.isArray(context)) errors.push('context must be an object');
    else if (JSON.stringify(context).length > 300000) errors.push('context is larger than 300 KB; store large artifacts elsewhere and pass references');
    const maxRev = body.max_revision_cycles === undefined ? 1 : body.max_revision_cycles;
    if (!Number.isInteger(maxRev) || maxRev < 0 || maxRev > 3) errors.push('max_revision_cycles must be an integer 0-3');
    const requestedBy = body.requested_by === undefined ? 'api' : String(body.requested_by).slice(0, 200);
    // Set when a department manager sends the request: only that department's employees are planned.
    const departmentId = body.department_id === undefined || body.department_id === null || body.department_id === ''
      ? null : String(body.department_id);
    if (departmentId !== null && !/^[a-z][a-z0-9_]{2,63}$/.test(departmentId)) errors.push('department_id is invalid');
    // A YouTube link typed in the objective becomes shared context, so the video reaches the
    // employee deterministically instead of depending on the planner copying it.
    const links = objective.match(/https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)[\w-]{6,}[^\s,;)]*/g) || [];
    if (links.length && context && typeof context === 'object' && !Array.isArray(context) && !context.youtube_url) {
      context.youtube_url = links[0];
      if (links.length > 1) context.youtube_urls = links;
    }
    return [{ json: {
      valid: errors.length === 0,
      errors,
      request: { objective, context, requested_by: requestedBy, max_revision_cycles: maxRev, department_id: departmentId },
    } }];
  }, [220, 0]);
  wb.ifTrue('Request Valid?', '={{ $json.valid }}', [440, 0]);

  // The request becomes a 'planning' plan row right away (visible after F5 / in other tabs);
  // a second request while one is planning is refused (one planning plan at a time).
  wb.pg('Start Planning', 'SELECT wf.try_start_planning($1, $2::jsonb, $3::int, nullif($4, \'\')) AS result',
    "={{ [ $json.request.objective, JSON.stringify($json.request), $json.request.max_revision_cycles, $json.request.department_id || '' ] }}", [660, -100]);
  wb.ifTrue('CEO Free?', '={{ $json.result.ok }}', [880, -100]);
  wb.code('CEO Busy Response', function () {
    return [{ json: { status_code: 409, body: { ok: false, data: null, error: $json.result.error } } }];
  }, [1100, 100]);
  wb.pg('Load Employee Catalog', "SELECT wf.get_employee_catalog(nullif($1, '')) AS catalog, (SELECT jsonb_agg(jsonb_build_object('department_id', department_id, 'name', name, 'purpose', purpose) ORDER BY department_id) FROM wf.departments) AS departments",
    "={{ [ $('Validate Request').first().json.request.department_id || '' ] }}", [1100, -100]);

  wb.code('Build Planner Prompt', function () {
    const { request } = $('Validate Request').first().json;
    const catalog = $json.catalog;
    const contextSummary = Object.entries(request.context).map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return `- ${key} (${text.length} chars): ${text.slice(0, 300).replace(/\s+/g, ' ')}${text.length > 300 ? '…' : ''}`;
    });
    const prompt = [
      request.department_id
        ? `## Requester\nThe manager of department ${request.department_id}. Plan ONLY with the employees listed below (all from this department).\nCompany departments (use their names for out_of_scope.suggested_department, never invent one): ${($json.departments || []).map((d) => `${d.name} (${d.purpose})`).join('; ')}`
        : '',
      `## Business objective\n${request.objective}`,
      `## Shared request context (available to every task)\n${contextSummary.length ? contextSummary.join('\n') : 'none'}`,
      `## Employee catalog\n${JSON.stringify(catalog, null, 2)}`,
      'Produce the task plan as JSON.',
    ].filter(Boolean).join('\n\n');
    return [{ json: { prompt } }];
  }, [880, -100]);

  wb.aiAgent('CEO Planner Agent', {
    prompt: '={{ $json.prompt }}', systemMessage: PLANNER_SYSTEM, schema: PLAN_SCHEMA, temperature: 0.2,
  }, [1100, -100]);

  wb.code('Validate Task Plan', function () {
    const catalog = $('Load Employee Catalog').first().json.catalog;
    const raw = $json.output || {};
    const errors = [];
    const employees = new Map(catalog.map((e) => [e.employee_id, e]));
    const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
    const outOfScope = (Array.isArray(raw.out_of_scope) ? raw.out_of_scope : []).filter((o) => o && o.request)
      .map((o) => ({ request: String(o.request).slice(0, 300), reason: String(o.reason || '').slice(0, 300),
                     suggested_department: o.suggested_department ? String(o.suggested_department).slice(0, 80) : null }));
    if (!tasks.length) {
      errors.push(outOfScope.length
        ? `không nhân sự nào trong phạm vi này làm được yêu cầu: ${outOfScope.map((o) => `${o.request} (${o.reason}${o.suggested_department ? `; nên giao cho ${o.suggested_department}` : ''})`).join('; ')}`
        : 'plan has no tasks');
    }
    if (tasks.length > 15) errors.push(`plan has ${tasks.length} tasks; the limit is 15`);

    const ids = new Set();
    const normalized = tasks.map((t, i) => {
      const where = `task[${i}]${t && t.task_id ? ` (${t.task_id})` : ''}`;
      const id = String((t && t.task_id) || '');
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) errors.push(`${where}: task_id must match [A-Za-z0-9_-]{1,40}`);
      else if (ids.has(id)) errors.push(`${where}: duplicate task_id`);
      ids.add(id);
      for (const f of ['task_name', 'description', 'expected_output']) {
        if (typeof t[f] !== 'string' || !t[f].trim()) errors.push(`${where}: ${f} is required`);
      }
      const emp = employees.get(t.assigned_employee_id);
      if (!emp) errors.push(`${where}: unknown or unavailable employee "${t.assigned_employee_id}"`);
      else if (t.department_id !== emp.department_id) {
        errors.push(`${where}: employee ${emp.employee_id} belongs to ${emp.department_id}, not "${t.department_id}"`);
      }
      const criteria = Array.isArray(t.acceptance_criteria) ? t.acceptance_criteria.filter((c) => typeof c === 'string' && c.trim()) : [];
      if (!criteria.length) errors.push(`${where}: at least one acceptance criterion is required`);
      const deps = Array.isArray(t.depends_on) ? t.depends_on.map(String) : [];
      if (!Array.isArray(t.depends_on)) errors.push(`${where}: depends_on must be an array`);
      const priority = ['low', 'medium', 'high', 'critical'].includes(t.priority) ? t.priority : 'medium';
      const maxRetries = Number.isInteger(t.max_retries) ? Math.min(Math.max(t.max_retries, 0), 3) : 2;
      const input = t.input_data && typeof t.input_data === 'object' && !Array.isArray(t.input_data) ? t.input_data : {};
      // status / retry_count / plan_id are assigned by the system, never taken from the model
      return { task_id: id, task_name: t.task_name, description: t.description,
               assigned_employee_id: t.assigned_employee_id, department_id: t.department_id,
               input_data: input, depends_on: [...new Set(deps)], expected_output: t.expected_output,
               acceptance_criteria: criteria, priority, requires_approval: t.requires_approval === true,
               max_retries: maxRetries, status: 'pending', retry_count: 0 };
    });

    for (const t of normalized) {
      for (const d of t.depends_on) {
        if (d === t.task_id) errors.push(`${t.task_id}: depends on itself`);
        else if (!ids.has(d)) errors.push(`${t.task_id}: depends on unknown task "${d}"`);
      }
    }

    // Cycle detection (DFS with colors) over the declared dependency graph.
    const graph = new Map(normalized.map((t) => [t.task_id, t.depends_on.filter((d) => ids.has(d) && d !== t.task_id)]));
    const color = new Map();
    const stack = [];
    let cycle = null;
    const visit = (n) => {
      if (cycle) return;
      color.set(n, 1);
      stack.push(n);
      for (const d of graph.get(n) || []) {
        if (color.get(d) === 1) { cycle = [...stack.slice(stack.indexOf(d)), d]; return; }
        if (!color.get(d)) visit(d);
        if (cycle) return;
      }
      stack.pop();
      color.set(n, 2);
    };
    for (const n of graph.keys()) if (!color.get(n)) visit(n);
    if (cycle) errors.push(`circular dependency: ${cycle.join(' -> ')}`);

    const independent = normalized.filter((t) => !t.depends_on.length).map((t) => t.task_id);
    return [{ json: {
      valid: errors.length === 0,
      errors,
      plan: { plan_summary: String(raw.plan_summary || ''), tasks: normalized },
      out_of_scope: outOfScope,
      independent_tasks: independent,
      raw_plan: raw,
    } }];
  }, [1400, -180]);
  wb.ifTrue('Plan Valid?', '={{ $json.valid }}', [1620, -180]);

  // try_create_plan re-validates in the database (FKs, unique ids, cycles) and rolls back atomically.
  wb.pg('Save Plan',
    'SELECT wf.try_finish_planning($1::uuid, $2::jsonb) AS result',
    "={{ [ $('Start Planning').first().json.result.plan_id, JSON.stringify($json.plan) ] }}",
    [1840, -260]);
  wb.ifTrue('Plan Saved?', '={{ $json.result.ok }}', [2060, -260]);
  wb.code('Dispatch Payload', function () {
    return [{ json: { plan_id: $json.result.plan_id } }];
  }, [2280, -320]);
  wb.callWorkflow('Start Dispatcher', WORKFLOW_IDS.dispatcher, [2500, -320], { wait: false });
  wb.code('Accepted Response', function () {
    const saved = $('Save Plan').first().json.result;
    const v = $('Validate Task Plan').first().json;
    return [{ json: { status_code: 202, body: { ok: true, data: {
      plan_id: saved.plan_id, status: saved.status, task_count: saved.task_count,
      plan_summary: v.plan.plan_summary, independent_tasks: v.independent_tasks, out_of_scope: v.out_of_scope,
      tasks: v.plan.tasks.map((t) => ({ task_id: t.task_id, task_name: t.task_name,
        assigned_employee_id: t.assigned_employee_id, depends_on: t.depends_on, status: 'pending' })),
    }, error: null } } }];
  }, [2720, -320]);

  wb.code('Collect Rejection', function () {
    const v = $('Validate Task Plan').isExecuted ? $('Validate Task Plan').first().json : null;
    const saved = $('Save Plan').isExecuted ? $('Save Plan').first().json.result : null;
    const dbError = saved && !saved.ok ? [`database rejected the plan: ${saved.error.message}`] : [];
    const plannerError = !v ? [`planner failed: ${String(($json.error && ($json.error.message || $json.error)) || 'unknown error').slice(0, 500)}`] : [];
    const errors = [...(v && !v.valid ? v.errors : []), ...dbError, ...plannerError];
    return [{ json: { errors, raw_plan: v ? v.raw_plan : null, planner_failed: !v } }];
  }, [1840, 0]);
  wb.pg('Record Rejected Plan',
    'SELECT wf.reject_planning($1::uuid, $2::jsonb, $3::jsonb) AS result',
    "={{ [ $('Start Planning').first().json.result.plan_id, JSON.stringify($json.errors), JSON.stringify($json.raw_plan) ] }}",
    [2060, 0]);
  wb.code('Rejected Response', function () {
    const c = $('Collect Rejection').first().json;
    return [{ json: { status_code: c.planner_failed ? 502 : 422, body: { ok: false, data: { plan_id: $json.result.plan_id, status: 'rejected' },
      error: { code: c.planner_failed ? 'planner_failed' : 'invalid_plan', message: 'The task plan was rejected', details: c.errors } } } }];
  }, [2280, 0]);

  wb.code('Bad Request Response', function () {
    return [{ json: { status_code: 400, body: { ok: false, data: null,
      error: { code: 'invalid_request', message: 'Invalid request', details: $json.errors } } } }];
  }, [660, 200]);
  wb.respond('Respond', [2940, 0]);

  wb.chain('Business Request', 'Validate Request', 'Request Valid?');
  wb.connect('Request Valid?', 'Start Planning').connect('Request Valid?', 'Bad Request Response', { output: 1 });
  wb.chain('Start Planning', 'CEO Free?', 'Load Employee Catalog');
  wb.connect('CEO Free?', 'CEO Busy Response', { output: 1 }).connect('CEO Busy Response', 'Respond');
  wb.chain('Load Employee Catalog', 'Build Planner Prompt', 'CEO Planner Agent', 'Validate Task Plan', 'Plan Valid?');
  wb.connect('CEO Planner Agent', 'Collect Rejection', { output: 1 });
  wb.connect('Plan Valid?', 'Save Plan').connect('Plan Valid?', 'Collect Rejection', { output: 1 });
  wb.chain('Save Plan', 'Plan Saved?', 'Dispatch Payload', 'Start Dispatcher', 'Accepted Response', 'Respond');
  wb.connect('Plan Saved?', 'Collect Rejection', { output: 1 });
  wb.chain('Collect Rejection', 'Record Rejected Plan', 'Rejected Response', 'Respond');
  wb.connect('Bad Request Response', 'Respond');
  return wb.toJSON();
};
