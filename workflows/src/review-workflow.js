// Workflow D — CEO Review & Aggregation. Runs once all tasks completed (claimed atomically by
// refresh_plan). The reviewer checks acceptance criteria and evidence, then either adds bounded
// revision tasks or finalizes the report and requests human approval. It never marks a plan
// completed itself.
const { WorkflowBuilder } = require('../lib/n8n-builders');
const { WORKFLOW_IDS, WORKFLOW_NAMES } = require('../lib/ids');

const REVISION_TASK = {
  type: 'object',
  properties: {
    task_id: { type: 'string' },
    task_name: { type: 'string' },
    description: { type: 'string', description: 'What to change and why' },
    assigned_employee_id: { type: 'string' },
    department_id: { type: 'string' },
    input_data: { type: 'object', description: 'Include reviewer_feedback with concrete instructions' },
    depends_on: { type: 'array', items: { type: 'string' }, description: 'Existing task_ids whose outputs are needed' },
    expected_output: { type: 'string' },
    acceptance_criteria: { type: 'array', items: { type: 'string' } },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
  },
  required: ['task_id', 'task_name', 'description', 'assigned_employee_id', 'department_id', 'input_data',
             'depends_on', 'expected_output', 'acceptance_criteria', 'priority'],
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approved', 'changes_needed'] },
    summary: { type: 'string' },
    acceptance_checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { task_id: { type: 'string' }, criterion: { type: 'string' }, met: { type: 'boolean' }, evidence: { type: 'string' } },
        required: ['task_id', 'criterion', 'met', 'evidence'],
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: { severity: { type: 'string', enum: ['low', 'medium', 'high'] }, task_id: { type: 'string' }, description: { type: 'string' } },
        required: ['severity', 'description'],
      },
    },
    missing_deliverables: { type: 'array', items: { type: 'string' } },
    contradictions: { type: 'array', items: { type: 'string' } },
    unsupported_claims: { type: 'array', items: { type: 'string' } },
    revision_tasks: { type: 'array', items: REVISION_TASK },
    final_report: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        executive_summary: { type: 'string' },
        deliverables: {
          type: 'array',
          items: { type: 'object', properties: { task_id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } },
                   required: ['task_id', 'title', 'description'] },
        },
        publication_notes: { type: 'string' },
        next_steps: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'executive_summary', 'deliverables'],
    },
  },
  required: ['verdict', 'summary', 'acceptance_checks', 'issues', 'missing_deliverables', 'contradictions',
             'unsupported_claims', 'revision_tasks', 'final_report'],
};

const REVIEWER_SYSTEM = [
  'You are the CEO Reviewer of an AI company. Review the completed work against the business objective.',
  '- Check every acceptance criterion of every task (acceptance_checks), citing evidence from the outputs.',
  '- Identify missing deliverables, contradictions between outputs, and claims not supported by the source context.',
  '- verdict "approved" only if every criterion is met and nothing required is missing.',
  '- If changes are needed and revisions are allowed, add revision_tasks: assign them to catalog employees, depend on the',
  '  existing tasks whose output must be revised, and put precise reviewer_feedback in input_data. Otherwise return [].',
  '- final_report aggregates the deliverables (reference task_ids) for a human approver. Nothing is published automatically.',
].join('\n');

module.exports = function buildReviewWorkflow() {
  const wb = new WorkflowBuilder(WORKFLOW_IDS.review, WORKFLOW_NAMES[WORKFLOW_IDS.review], { executionTimeout: 300 });

  wb.subworkflowTrigger('Review Request', [0, 0]);
  wb.pg('Load Review Context', 'SELECT wf.get_review_context($1::uuid) AS ctx', '={{ [$json.plan_id] }}', [220, 0]);
  wb.ifTrue('Is Reviewing?', "={{ $json.ctx && $json.ctx.status === 'reviewing' }}", [440, 0]);

  wb.code('Build Review Prompt', function () {
    const ctx = $json.ctx;
    const clip = (v, n) => { const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2); return s.length > n ? `${s.slice(0, n)}…[truncated]` : s; };
    const revisionsLeft = ctx.max_revision_cycles - ctx.revision_cycle;
    const prompt = [
      `## Business objective\n${ctx.objective}`,
      `Plan summary: ${ctx.plan_summary || ''}`,
      `Revision cycle ${ctx.revision_cycle} of max ${ctx.max_revision_cycles}. ${revisionsLeft > 0 ? `You may add revision tasks (${revisionsLeft} cycle(s) left).` : 'No revisions allowed: revision_tasks must be [].'}`,
      `Available employees: ${ctx.employee_ids.join(', ')} (departments: ${JSON.stringify(ctx.employee_departments)})`,
      `## Source context\n${clip(ctx.context, 20000)}`,
      ...ctx.tasks.map((t) => [
        `## ${t.task_id}: ${t.task_name} (${t.assigned_employee_id}, status ${t.status}${t.revision_cycle ? `, revision ${t.revision_cycle}` : ''})`,
        `Expected: ${t.expected_output}`,
        `Acceptance criteria:\n- ${t.acceptance_criteria.join('\n- ')}`,
        `Depends on: ${t.depends_on.join(', ') || 'none'}`,
        `Output:\n${clip(t.output, 12000)}`,
      ].join('\n')),
    ].join('\n\n');
    return [{ json: { prompt } }];
  }, [660, -100]);

  wb.aiAgent('CEO Reviewer Agent', {
    prompt: '={{ $json.prompt }}', systemMessage: REVIEWER_SYSTEM, schema: REVIEW_SCHEMA, temperature: 0.1,
  }, [880, -100]);

  wb.code('Enforce Review Rules', function () {
    const ctx = $('Load Review Context').first().json.ctx;
    const review = { ...$json.output };
    const notes = [];
    const failedChecks = (review.acceptance_checks || []).filter((c) => !c.met);
    const missing = review.missing_deliverables || [];
    // A review with unmet criteria or missing deliverables can never be an approval.
    if (review.verdict === 'approved' && (failedChecks.length || missing.length)) {
      review.verdict = 'changes_needed';
      notes.push('verdict downgraded: unmet acceptance criteria or missing deliverables');
    }

    let revisionTasks = [];
    const canRevise = ctx.revision_cycle < ctx.max_revision_cycles;
    if (review.verdict === 'changes_needed' && canRevise && (review.revision_tasks || []).length) {
      const cycle = ctx.revision_cycle + 1;
      const existing = new Set(ctx.tasks.map((t) => t.task_id));
      const deptOf = ctx.employee_departments;
      const proposed = review.revision_tasks.slice(0, 5);
      // Revision ids are namespaced per cycle so they can never collide with existing tasks.
      const keyOf = (t, i) => String(t.task_id || `T${i + 1}`);
      const rename = new Map(proposed.map((t, i) => [keyOf(t, i), `R${cycle}-${keyOf(t, i).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 30) || i + 1}`]));
      const errors = [];
      revisionTasks = proposed.map((t, i) => {
        const id = rename.get(keyOf(t, i));
        if (!ctx.employee_ids.includes(t.assigned_employee_id)) errors.push(`${id}: unknown employee ${t.assigned_employee_id}`);
        const deps = (t.depends_on || []).map((d) => (rename.has(d) ? rename.get(d) : d));
        for (const d of deps) if (!existing.has(d) && ![...rename.values()].includes(d)) errors.push(`${id}: unknown dependency ${d}`);
        const criteria = (t.acceptance_criteria || []).filter((c) => typeof c === 'string' && c.trim());
        if (!criteria.length) errors.push(`${id}: no acceptance criteria`);
        return { ...t, task_id: id, department_id: deptOf[t.assigned_employee_id] || t.department_id,
                 depends_on: [...new Set(deps)], acceptance_criteria: criteria,
                 input_data: t.input_data && typeof t.input_data === 'object' ? t.input_data : {} };
      });
      if (errors.length) {
        notes.push(`revision tasks rejected: ${errors.join('; ')}`);
        revisionTasks = [];
      }
    } else if (review.verdict === 'changes_needed' && !canRevise) {
      notes.push('revision limit reached; a human must decide on the remaining issues');
    }

    const known = new Set(ctx.tasks.map((t) => t.task_id));
    const report = review.final_report || {};
    const finalReport = {
      ...report,
      verdict: review.verdict,
      deliverables: (report.deliverables || []).filter((d) => known.has(d.task_id)).map((d) => ({
        ...d, output_ref: `/webhook/workforce/plan/deliverables?plan_id=${ctx.plan_id}#${d.task_id}`,
      })),
      open_issues: review.issues || [],
      reviewer_notes: notes,
    };
    return [{ json: {
      action: revisionTasks.length ? 'revise' : 'finalize',
      plan_id: ctx.plan_id,
      review: { ...review, revision_tasks: revisionTasks, enforcement_notes: notes },
      revision_tasks: revisionTasks,
      final_report: finalReport,
    } }];
  }, [1180, -180]);
  wb.ifTrue('Revise?', "={{ $json.action === 'revise' }}", [1400, -180]);

  wb.pg('Add Revision Tasks', 'SELECT wf.try_add_revision_tasks($1::uuid, $2::jsonb, $3::jsonb) AS result',
    '={{ [$json.plan_id, JSON.stringify($json.revision_tasks), JSON.stringify($json.review)] }}', [1620, -280]);
  wb.ifTrue('Revision Saved?', '={{ $json.result.ok }}', [1840, -280]);
  wb.code('Wake Payload', function () {
    return [{ json: { plan_id: $json.result.plan_id } }];
  }, [2060, -340]);
  wb.callWorkflow('Wake Dispatcher', WORKFLOW_IDS.dispatcher, [2280, -340], { wait: false });

  // If the database rejects the revision tasks, finalize instead so the plan cannot loop.
  wb.code('Finalize Instead', function () {
    const e = $('Enforce Review Rules').first().json;
    const message = String(($json.result && $json.result.error && $json.result.error.message) || 'unknown error');
    return [{ json: { ...e, action: 'finalize',
      final_report: { ...e.final_report, reviewer_notes: [...e.final_report.reviewer_notes, `revision tasks rejected by database: ${message}`] } } }];
  }, [2060, -200]);
  wb.pg('Finalize Review', 'SELECT wf.finalize_review($1::uuid, $2::jsonb, $3::jsonb) AS result',
    '={{ [$json.plan_id, JSON.stringify($json.review), JSON.stringify($json.final_report)] }}', [2060, -100]);

  wb.pg('Mark Review Failed', 'SELECT wf.mark_review_failed($1::uuid, $2::jsonb) AS result',
    "={{ [$('Load Review Context').first().json.ctx.plan_id, JSON.stringify({ message: String(($json.error && ($json.error.message || $json.error)) || 'reviewer failed').slice(0, 1000) })] }}",
    [1180, 100]);

  wb.chain('Review Request', 'Load Review Context', 'Is Reviewing?', 'Build Review Prompt', 'CEO Reviewer Agent', 'Enforce Review Rules', 'Revise?');
  wb.connect('CEO Reviewer Agent', 'Mark Review Failed', { output: 1 });
  wb.connect('Revise?', 'Add Revision Tasks').connect('Revise?', 'Finalize Review', { output: 1 });
  wb.chain('Add Revision Tasks', 'Revision Saved?', 'Wake Payload', 'Wake Dispatcher');
  wb.connect('Revision Saved?', 'Finalize Instead', { output: 1 });
  wb.connect('Finalize Instead', 'Finalize Review');
  return wb.toJSON();
};
