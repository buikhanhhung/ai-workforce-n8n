// Workflow E — Dashboard API. Every endpoint is a Header-Auth (X-API-Key) webhook that calls
// wf.api(action, args) and returns { ok, data, error } JSON for the separate dashboard frontend.
// Paths are static (ids go in the query string or body): n8n only serves path-parameter
// webhooks behind a generated webhook-id prefix, which a dashboard should not depend on.
const { WorkflowBuilder } = require('../lib/n8n-builders');
const { WORKFLOW_IDS, WORKFLOW_NAMES } = require('../lib/ids');

// args: expression fragments building the JSON arguments from query string or body
const fromQuery = (...fields) => `{ ${fields.map((f) => `${f}: ($json.query || {}).${f} ?? null`).join(', ')} }`;
const fromBody = (...fields) => `{ ${fields.map((f) => `${f}: ($json.body || {}).${f} ?? null`).join(', ')} }`;

const ENDPOINTS = [
  { name: 'Get Organization', method: 'GET', path: 'workforce/organization', action: 'organization', args: '{}' },
  { name: 'List Plans', method: 'GET', path: 'workforce/plans', action: 'list_plans', args: fromQuery('limit', 'status', 'department_id') },
  { name: 'Get Plan', method: 'GET', path: 'workforce/plan', action: 'plan', args: fromQuery('plan_id') },
  { name: 'Get Plan History', method: 'GET', path: 'workforce/plan/history', action: 'plan_history', args: fromQuery('plan_id') },
  { name: 'Get Deliverables', method: 'GET', path: 'workforce/plan/deliverables', action: 'deliverables', args: fromQuery('plan_id') },
  { name: 'List Pending Approvals', method: 'GET', path: 'workforce/approvals', action: 'pending_approvals', args: fromQuery('department_id') },
  { name: 'Cancel Plan', method: 'POST', path: 'workforce/plan/cancel', action: 'cancel_plan',
    args: fromBody('plan_id', 'requested_by', 'reason') },
  { name: 'Retry Task', method: 'POST', path: 'workforce/task/retry', action: 'retry_task', wake: true,
    args: fromBody('plan_id', 'task_id', 'requested_by') },
  { name: 'Decide Approval', method: 'POST', path: 'workforce/approval/decision', action: 'decide_approval', wake: true,
    args: fromBody('approval_id', 'decision', 'decided_by', 'note') },
  { name: 'Assign Directly', method: 'POST', path: 'workforce/task/direct', action: 'direct_task', wake: true,
    args: fromBody('employee_id', 'text', 'requested_by', 'department_id') },
  { name: 'Recent Results', method: 'GET', path: 'workforce/results/recent', action: 'recent_results', args: fromQuery('limit', 'department_id') },
  { name: 'Get Task Output', method: 'GET', path: 'workforce/task/output', action: 'task_output', args: fromQuery('plan_id', 'task_id') },
  { name: 'Get Publications', method: 'GET', path: 'workforce/plan/publications', action: 'publications', args: fromQuery('plan_id') },
  { name: 'List Library', method: 'GET', path: 'workforce/library', action: 'library',
    args: fromQuery('department_id', 'employee_id', 'status', 'approval', 'q', 'limit', 'offset') },
  { name: 'Set Library Status', method: 'POST', path: 'workforce/library/status', action: 'set_library_status',
    args: fromBody('plan_id', 'task_id', 'status', 'updated_by') },
  // Non-secret integration settings only; secrets go from the dashboard server straight to n8n credentials.
  { name: 'Get Integrations', method: 'GET', path: 'workforce/integrations', action: 'integrations', args: '{}' },
  { name: 'Save Integration Config', method: 'POST', path: 'workforce/integrations/config', action: 'save_integration_config',
    args: fromBody('service', 'config', 'secret_saved', 'updated_by') },
];

module.exports = function buildDashboardApiWorkflow() {
  // Successful polling executions are not stored: they add noise and would keep request headers.
  const wb = new WorkflowBuilder(WORKFLOW_IDS.dashboardApi, WORKFLOW_NAMES[WORKFLOW_IDS.dashboardApi],
    { executionTimeout: 60, saveDataSuccessExecution: 'none' });

  // The Postgres node does NOT use its error output when the database is unreachable: it passes the
  // request item on with no `result` (verified with wf-postgres stopped). So every SQL node continues
  // on its regular output and a missing `result` means "database unavailable" (503), never a crash.
  const sql = { onError: 'continueRegularOutput' };
  wb.code('Shape Response', function () {
    const r = $json.result;
    if (!r || typeof r !== 'object') {
      return [{ json: { status_code: 503, body: { ok: false, data: null,
        error: { code: 'service_unavailable', message: 'Không kết nối được database (wf-postgres). Kiểm tra container wf-postgres có đang chạy không.' } } } }];
    }
    return [{ json: { status_code: r.status, body: { ok: r.ok, data: r.data ?? null, error: r.error ?? null } } }];
  }, [1300, 0]);
  wb.respond('Respond', [1520, 0]);
  wb.connect('Shape Response', 'Respond');

  ENDPOINTS.forEach((ep, i) => {
    const y = i * 180 - 700;
    const hook = `${ep.method} ${ep.path}`;
    wb.webhook(hook, ep.method, ep.path, [0, y]);
    wb.pg(ep.name, `SELECT wf.api('${ep.action}', $1::jsonb) AS result`, `={{ [ JSON.stringify(${ep.args}) ] }}`,
      [240, y], sql);
    wb.connect(hook, ep.name);
    if (!ep.wake) {
      wb.connect(ep.name, 'Shape Response');
      return;
    }
    // Retries and approvals can unblock tasks: on success wake the dispatcher, then answer.
    wb.ifTrue(`${ep.name} Succeeded?`, '={{ !!($json.result && $json.result.ok) }}', [460, y]);
    wb.code(`${ep.name} Wake Payload`, function () {
      return [{ json: { plan_id: $json.result.data.plan_id } }];
    }, [680, y - 40]);
    wb.callWorkflow(`${ep.name} Wake Dispatcher`, WORKFLOW_IDS.dispatcher, [900, y - 40], { wait: false });
    wb.add(`${ep.name} Result`, 'n8n-nodes-base.code', 2, {
      jsCode: `return [{ json: { result: $('${ep.name}').first().json.result } }];\n`,
    }, [1100, y - 40]);
    wb.chain(ep.name, `${ep.name} Succeeded?`, `${ep.name} Wake Payload`, `${ep.name} Wake Dispatcher`, `${ep.name} Result`, 'Shape Response');
    wb.connect(`${ep.name} Succeeded?`, 'Shape Response', { output: 1 });
  });

  // POST plan/publish-linkedin { plan_id, requested_by }: reserve the publication (approval and
  // duplicate checks in SQL), post it through workflow F (waits), answer with the final record.
  const y = ENDPOINTS.length * 180 - 700;
  wb.webhook('POST workforce/plan/publish-linkedin', 'POST', 'workforce/plan/publish-linkedin', [0, y]);
  wb.pg('Start LinkedIn Publication', "SELECT wf.api('start_linkedin_publication', $1::jsonb) AS result",
    `={{ [ JSON.stringify(${fromBody('plan_id', 'requested_by')}) ] }}`, [240, y], sql);
  wb.ifTrue('Publication Reserved?', '={{ !!($json.result && $json.result.ok) }}', [460, y]);
  wb.code('Publish Payload', function () {
    const d = $json.result.data;
    return [{ json: { publication_id: d.publication_id, text: d.text, image_file: d.image_file || null } }];
  }, [680, y - 40]);
  // alwaysOutputData: answer with the stored state even if the publisher returned nothing
  wb.callWorkflow('Publish To LinkedIn', WORKFLOW_IDS.linkedinPublisher, [900, y - 40],
    { wait: true, onError: 'continueRegularOutput', alwaysOutputData: true });
  wb.pg('Publication Result', "SELECT wf.api('publications', $1::jsonb) AS result",
    "={{ [ JSON.stringify({ plan_id: $('Start LinkedIn Publication').first().json.result.data.plan_id }) ] }}", [1100, y - 40],
    sql);
  wb.chain('POST workforce/plan/publish-linkedin', 'Start LinkedIn Publication', 'Publication Reserved?', 'Publish Payload',
    'Publish To LinkedIn', 'Publication Result', 'Shape Response');

  wb.connect('Publication Reserved?', 'Shape Response', { output: 1 });
  return wb.toJSON();
};

module.exports.ENDPOINTS = ENDPOINTS;
