// Workflow B — Task Dispatcher. Woken by planning, by every finished task (task runner) and by a
// 1-minute schedule (safety net for missed wakeups, stuck executions and stalled reviews).
// All decisions come from PostgreSQL state: refresh_plan evaluates dependencies, claim_ready_tasks
// atomically moves ready -> running, and each claimed task is started fire-and-forget so
// independent tasks really run concurrently.
const { WorkflowBuilder } = require('../lib/n8n-builders');
const { WORKFLOW_IDS, WORKFLOW_NAMES, MAX_RUNNING_PER_PLAN } = require('../lib/ids');

module.exports = function buildDispatcherWorkflow() {
  const wb = new WorkflowBuilder(WORKFLOW_IDS.dispatcher, WORKFLOW_NAMES[WORKFLOW_IDS.dispatcher], { executionTimeout: 120 });

  wb.subworkflowTrigger('Dispatch Request', [0, 0]);
  wb.code('Normalize Plan Id', function () {
    const ids = $input.all().map((i) => i.json.plan_id).filter((id) => /^[0-9a-f-]{36}$/i.test(String(id)));
    return [...new Set(ids)].map((plan_id) => ({ json: { plan_id } }));
  }, [220, 0]);

  wb.add('Every Minute', 'n8n-nodes-base.scheduleTrigger', 1.2, {
    rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] },
  }, [0, 300]);
  wb.pg('Poll Work', 'SELECT wf.poll_work() AS work', null, [220, 300]);
  wb.code('Plans To Dispatch', function () {
    return ($json.work.dispatch_plan_ids || []).map((plan_id) => ({ json: { plan_id } }));
  }, [440, 220]);
  wb.code('Stale Reviews', function () {
    return ($json.work.stale_review_plan_ids || []).map((plan_id) => ({ json: { plan_id } }));
  }, [440, 420]);
  wb.callWorkflow('Restart CEO Review', WORKFLOW_IDS.review, [660, 420], { wait: false, mode: 'each' });

  wb.pg('Refresh Plan', 'SELECT wf.refresh_plan($1::uuid) AS state', '={{ [$json.plan_id] }}', [660, 0],
    { onError: 'continueRegularOutput' });
  wb.add('Note', 'n8n-nodes-base.stickyNote', 1, {
    content: '## Dispatcher\nState lives in PostgreSQL. `claim_ready_tasks` locks the plan row and only moves tasks whose status is still `ready` → no duplicate dispatch even when several dispatcher runs overlap.',
    height: 200, width: 360,
  }, [600, -300]);

  wb.ifTrue('Review Needed?', '={{ $json.state && $json.state.review_needed }}', [880, 160]);
  wb.code('Review Payload', function () {
    return $input.all().map((i) => ({ json: { plan_id: i.json.state.plan_id } }));
  }, [1100, 160]);
  wb.callWorkflow('Start CEO Review', WORKFLOW_IDS.review, [1320, 160], { wait: false, mode: 'each' });

  // Company-wide queue: frees capacity anywhere -> next task across all plans (CEO work first),
  // respecting each employee's max_concurrent and the per-plan limit.
  wb.pg('Claim Ready Tasks', `SELECT * FROM wf.claim_next_tasks(${MAX_RUNNING_PER_PLAN})`, null, [880, -100],
    { executeOnce: true });
  wb.callWorkflow('Run Task', WORKFLOW_IDS.taskRunner, [1100, -100], { wait: false, mode: 'each' });

  wb.chain('Dispatch Request', 'Normalize Plan Id', 'Refresh Plan');
  wb.chain('Every Minute', 'Poll Work');
  wb.connect('Poll Work', 'Plans To Dispatch').connect('Poll Work', 'Stale Reviews');
  wb.connect('Plans To Dispatch', 'Refresh Plan');
  wb.connect('Stale Reviews', 'Restart CEO Review');
  wb.connect('Refresh Plan', 'Claim Ready Tasks').connect('Refresh Plan', 'Review Needed?');
  wb.connect('Review Needed?', 'Review Payload');
  wb.connect('Review Payload', 'Start CEO Review');
  wb.connect('Claim Ready Tasks', 'Run Task');
  return wb.toJSON();
};
