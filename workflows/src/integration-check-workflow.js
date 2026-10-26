// Workflow G — Integration Check. POST workforce/integrations/test { service } makes ONE real call
// with the credential the dashboard filled (LinkedIn userinfo, Circle members, WeCommitDW query or
// HTTP GET), stores { ok, message, at } in wf.integration_settings and returns it. Read-only calls only.
const { WorkflowBuilder } = require('../lib/n8n-builders');
const { WORKFLOW_IDS, WORKFLOW_NAMES, credRef } = require('../lib/ids');

const ROUTES = ['linkedin', 'circle', 'postgres', 'mysql', 'mssql', 'http', 'invalid'];

module.exports = function buildIntegrationCheckWorkflow() {
  const wb = new WorkflowBuilder(WORKFLOW_IDS.integrationCheck, WORKFLOW_NAMES[WORKFLOW_IDS.integrationCheck],
    { executionTimeout: 90 });
  const checked = { onError: 'continueErrorOutput' };
  // SQL nodes pass the INPUT item to the success output on a connection error (no error field),
  // so they continue on the regular output and "Connected" decides from the item content.
  const sqlChecked = { onError: 'continueRegularOutput' };

  wb.webhook('POST workforce/integrations/test', 'POST', 'workforce/integrations/test', [0, 0]);
  wb.pg('Load Integration',
    "SELECT (SELECT x FROM jsonb_array_elements(wf.api_integrations()->'services') x WHERE x->>'service' = $1) AS s",
    "={{ [ String(($json.body || {}).service || '') ] }}", [220, 0], sqlChecked);
  wb.code('Pick Route', function () {
    const s = $json.s;
    const service = s ? s.service : String(($('POST workforce/integrations/test').first().json.body || {}).service || '');
    const c = (s && s.config) || {};
    let route = s ? s.service : 'invalid';
    let message = s ? '' : !('s' in $json) ? 'Không kết nối được database (wf-postgres).' : `Dịch vụ không hợp lệ: "${service}"`;
    if (service === 'wecommitdw') {
      route = c.kind || 'invalid';
      if (!c.kind) message = 'Chưa chọn loại kết nối WeCommitDW. Hãy lưu cấu hình trước.';
    }
    const url = c.base_url ? c.base_url.replace(/\/+$/, '') + (c.health_path ? `/${String(c.health_path).replace(/^\/+/, '')}` : '') : '';
    if (route === 'http' && !url) { route = 'invalid'; message = 'Chưa nhập Base URL của WeCommitDW API.'; }
    const i = ROUTES.indexOf(route);
    if (i === -1 && !message) message = `Loại kết nối không hợp lệ: "${route}"`;
    return [{ json: { service, route, index: i === -1 ? ROUTES.length - 1 : i, url, message } }];
  }, [440, 0], { helpers: [`const ROUTES = ${JSON.stringify(ROUTES)};`] });
  wb.add('Route', 'n8n-nodes-base.switch', 3.2, {
    mode: 'expression', numberOutputs: ROUTES.length, output: '={{ $json.index }}',
  }, [660, 0]);

  // ── one real, read-only call per route ──
  const http = (name, url, credType, credKey, y) => wb.add(name, 'n8n-nodes-base.httpRequest', 4.2, {
    url,
    authentication: credType === 'linkedInOAuth2Api' ? 'predefinedCredentialType' : 'genericCredentialType',
    ...(credType === 'linkedInOAuth2Api' ? { nodeCredentialType: credType } : { genericAuthType: credType }),
    options: { timeout: 20000 },
  }, [900, y], { credentials: { [credType]: credRef(credKey) }, ...checked });
  http('LinkedIn Userinfo', 'https://api.linkedin.com/v2/userinfo', 'linkedInOAuth2Api', 'linkedin', -500);
  http('Circle Members', 'https://app.circle.so/api/admin/v2/community_members?per_page=1', 'httpHeaderAuth', 'circle', -320);
  wb.pg('WeCommitDW PostgreSQL', 'SELECT current_database() AS db, current_user AS usr, version() AS version', null, [900, -140],
    { credentials: { postgres: credRef('wecommitdwPostgres') }, ...sqlChecked });
  wb.add('WeCommitDW MySQL', 'n8n-nodes-base.mySql', 2.4, {
    operation: 'executeQuery', query: 'SELECT DATABASE() AS db, CURRENT_USER() AS usr, VERSION() AS version', options: {},
  }, [900, 40], { credentials: { mySql: credRef('wecommitdwMysql') }, ...sqlChecked });
  wb.add('WeCommitDW SQL Server', 'n8n-nodes-base.microsoftSql', 1.1, {
    operation: 'executeQuery', query: 'SELECT DB_NAME() AS db, SUSER_SNAME() AS usr, @@VERSION AS version',
  }, [900, 220], { credentials: { microsoftSql: credRef('wecommitdwMssql') }, ...sqlChecked });
  http('WeCommitDW API', "={{ $('Pick Route').first().json.url }}", 'httpHeaderAuth', 'wecommitdwApi', 400);

  // Raw error text -> message with the usual cause first. Shared by both result nodes.
  const explain = function explain(route, e) {
    const raw = typeof e === 'string' ? e : (e && [e.message, e.description].filter(Boolean).join(' — ')) || 'lỗi không rõ';
    const hint = route === 'linkedin' && /token|oauth|sign|credential/i.test(raw)
      ? 'Chưa bấm Connect trong n8n (hoặc token đã hết hạn sau 60 ngày). '
      : /401|403|unauthori|forbidden/i.test(raw) ? 'Token/khoá không đúng hoặc không đủ quyền. '
      : /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|timeout|hostname/i.test(raw) ? 'Không tới được máy chủ (sai host/port, firewall, hoặc máy chủ chỉ cho IP nội bộ). '
      : /password|authentication failed|login failed|access denied/i.test(raw) ? 'Sai user hoặc mật khẩu. '
      : '';
    return { ok: false, message: `${hint}${String(raw).slice(0, 700)}` };
  };
  // Success output. Some nodes (Postgres) report a handled error as a regular item, and a query
  // must return its row: anything else is a failure, never "connected".
  wb.code('Connected', function () {
    const route = $('Pick Route').first().json.route;
    const r = $json || {};
    const isDb = ['postgres', 'mysql', 'mssql'].includes(route);
    if (r.error) return [{ json: explain(route, r.error) }];
    if (isDb && (r.db === undefined || r.db === null)) {
      // the Postgres node drops the error text on failure; only the absence of the row is known
      return [{ json: { ok: false, message: 'Không kết nối được database: sai host/port, sai user hoặc mật khẩu, database không tồn tại, '
        + 'hoặc máy chủ không cho kết nối từ máy này (n8n không trả chi tiết lỗi cho loại kết nối này).' } }];
    }
    const short = (v) => String(v || '').split(/[\n,]/)[0].slice(0, 80);
    const message = route === 'linkedin' ? `Đã kết nối LinkedIn: ${r.name || r.given_name || r.sub || 'tài khoản'}${r.email ? ` (${r.email})` : ''}`
      : route === 'circle' ? `Đã kết nối Circle${typeof r.count === 'number' ? ` · ${r.count} thành viên` : ''}`
      : route === 'http' ? 'WeCommitDW API trả lời thành công'
      : `Đã kết nối database "${r.db}" bằng user "${r.usr}" · ${short(r.version)}`;
    return [{ json: { ok: true, message } }];
  }, [1140, -200], { helpers: [explain] });
  wb.code('Not Connected', function () {
    return [{ json: explain($('Pick Route').first().json.route, $json.error) }];
  }, [1140, 200], { helpers: [explain] });
  wb.code('Invalid Request', function () {
    return [{ json: { ok: false, message: $json.message || 'Chưa cấu hình' } }];
  }, [1140, 560]);

  wb.pg('Record Test', 'SELECT wf.record_integration_test($1, $2::boolean, $3) AS result',
    "={{ [ $('Pick Route').first().json.service, $json.ok, $json.message ] }}", [1360, 0], sqlChecked);
  // No `result` = the workforce database is unreachable (the Postgres node passes the item on).
  wb.code('Shape Response', function () {
    const r = $json.result;
    if (!r || typeof r !== 'object') {
      return [{ json: { status_code: 503, body: { ok: false, data: null,
        error: { code: 'service_unavailable', message: 'Không kết nối được database (wf-postgres). Kiểm tra container wf-postgres có đang chạy không.' } } } }];
    }
    return [{ json: { status_code: 200, body: { ok: true, data: r, error: null } } }];
  }, [1580, 0]);
  wb.respond('Respond', [1800, 0]);

  wb.chain('POST workforce/integrations/test', 'Load Integration', 'Pick Route', 'Route');
  const checks = ['LinkedIn Userinfo', 'Circle Members', 'WeCommitDW PostgreSQL', 'WeCommitDW MySQL', 'WeCommitDW SQL Server', 'WeCommitDW API'];
  const sqlChecks = ['WeCommitDW PostgreSQL', 'WeCommitDW MySQL', 'WeCommitDW SQL Server'];
  checks.forEach((n, i) => {
    wb.connect('Route', n, { output: i });
    wb.connect(n, 'Connected');
    if (!sqlChecks.includes(n)) wb.connect(n, 'Not Connected', { output: 1 });
  });
  wb.connect('Route', 'Invalid Request', { output: ROUTES.length - 1 });
  for (const n of ['Connected', 'Not Connected', 'Invalid Request']) wb.connect(n, 'Record Test');
  wb.connect('Record Test', 'Shape Response');
  wb.connect('Shape Response', 'Respond');
  return wb.toJSON();
};
