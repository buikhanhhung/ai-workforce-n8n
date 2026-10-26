// Workflow B2 — Task Runner: executes ONE claimed task. Loads the standardized payload, calls the
// assigned employee workflow (waits, bounded by the employee's execution timeout), records the
// result or failure (with bounded retries in PostgreSQL) and wakes the dispatcher.
const { WorkflowBuilder } = require('../lib/n8n-builders');
const { WORKFLOW_IDS, WORKFLOW_NAMES } = require('../lib/ids');

module.exports = function buildTaskRunnerWorkflow() {
  const wb = new WorkflowBuilder(WORKFLOW_IDS.taskRunner, WORKFLOW_NAMES[WORKFLOW_IDS.taskRunner], { executionTimeout: 900 });

  wb.subworkflowTrigger('Claimed Task', [0, 0]);
  wb.pg('Begin Task Run', 'SELECT wf.begin_task_run($1::uuid, $2) AS run',
    '={{ [$json.execution_id, $execution.id] }}', [220, 0]);
  wb.ifTrue('Still Running?', '={{ $json.run.ok }}', [440, 0]);

  wb.code('Build Employee Payload', function () {
    const run = $json.run;
    // input_data may point at shared context with the exact string "context.<key>": resolve it
    // here once, so employees always receive real values. Unknown keys are dropped (reported).
    const ctx = (run.plan && run.plan.context) || {};
    const REF = /^\s*(?:\{\{\s*)?\$?(?:plan\.)?context\.([A-Za-z0-9_-]+)\s*(?:\}\})?\s*$/;
    const unresolved = [];
    const resolve = (v) => {
      if (typeof v === 'string') {
        const m = REF.exec(v);
        if (!m) return v;
        if (Object.prototype.hasOwnProperty.call(ctx, m[1])) return ctx[m[1]];
        unresolved.push(v.trim());
        return undefined;
      }
      if (Array.isArray(v)) return v.map(resolve).filter((x) => x !== undefined);
      if (v && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]).filter(([, x]) => x !== undefined));
      }
      return v;
    };
    const task = { ...run.task, input_data: resolve(run.task.input_data || {}) };
    return [{ json: {
      task,
      unresolved_context_refs: unresolved,
      plan: run.plan,
      dependency_outputs: run.dependency_outputs,
      execution: { execution_id: run.execution_id, attempt: run.attempt },
      employee: run.employee,
    } }];
  }, [660, -100]);
  wb.callWorkflow('Call Employee Workflow', '={{ $json.employee.workflow_reference }}', [880, -100],
    { wait: true, onError: 'continueErrorOutput' });

  wb.code('Interpret Result', function () {
    const run = $('Begin Task Run').first().json.run;
    const r = $json || {};
    const meta = { ...(r.metadata || {}), employee_workflow: run.employee.workflow_reference,
                   runner_execution_id: $execution.id };
    if (r.status === 'completed' && r.output && typeof r.output === 'object') {
      return [{ json: { succeeded: true, execution_id: run.execution_id, plan_id: run.task.plan_id, output: r.output, metadata: meta } }];
    }
    let error;
    if (r.status === 'failed' && r.error && typeof r.error === 'object') {
      error = { code: r.error.code || 'employee_failed', message: String(r.error.message || '').slice(0, 2000),
                retryable: r.error.retryable !== false };
    } else {
      const message = String((r.error && (r.error.message || r.error)) || 'employee workflow returned no structured result').slice(0, 2000);
      error = { code: /timed? ?out/i.test(message) ? 'timeout' : 'employee_workflow_error', message, retryable: true };
    }
    return [{ json: { succeeded: false, execution_id: run.execution_id, plan_id: run.task.plan_id, error, metadata: meta } }];
  }, [1100, 0]);
  wb.ifTrue('Succeeded?', '={{ $json.succeeded }}', [1320, 0]);

  wb.pg('Record Completion', 'SELECT wf.complete_task($1::uuid, $2::jsonb, $3::jsonb) AS result',
    '={{ [$json.execution_id, JSON.stringify($json.output), JSON.stringify($json.metadata)] }}', [1540, -100]);
  wb.pg('Record Failure', 'SELECT wf.fail_task($1::uuid, $2::jsonb, $3::boolean, $4::jsonb) AS result',
    '={{ [$json.execution_id, JSON.stringify($json.error), $json.error.retryable, JSON.stringify($json.metadata)] }}', [1540, 100]);

  wb.code('Wake Payload', function () {
    return [{ json: { plan_id: $('Interpret Result').first().json.plan_id, recorded: $json.result } }];
  }, [1760, 0]);
  wb.callWorkflow('Wake Dispatcher', WORKFLOW_IDS.dispatcher, [1980, 0], { wait: false });

  wb.chain('Claimed Task', 'Begin Task Run', 'Still Running?', 'Build Employee Payload', 'Call Employee Workflow', 'Interpret Result', 'Succeeded?');
  wb.connect('Call Employee Workflow', 'Interpret Result', { output: 1 });
  wb.connect('Succeeded?', 'Record Completion').connect('Succeeded?', 'Record Failure', { output: 1 });
  wb.connect('Record Completion', 'Wake Payload').connect('Record Failure', 'Wake Payload');
  wb.connect('Wake Payload', 'Wake Dispatcher');
  return wb.toJSON();
};
