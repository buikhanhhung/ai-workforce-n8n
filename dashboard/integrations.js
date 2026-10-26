// Integrations settings (dashboard "Kết nối & tài khoản" page), server side.
// Secrets typed in the page are written ONLY into n8n's encrypted credentials through the n8n
// public API (PATCH /api/v1/credentials/{id}, partial merge); they are never stored here, never
// logged and never returned to the browser. Non-secret settings go to wf.integration_settings
// through the workforce webhooks.
//   GET  /api/integrations           -> services (non-secret config, last test) + whether the n8n API key is set
//   POST /api/integrations/n8n-key   { api_key }                         -> validated, kept server side
//   POST /api/integrations/save      { service, config, secrets, updated_by }
// The connection test (POST /api/integrations/test) is a plain proxied webhook (workflow G).
const fs = require('fs');
const path = require('path');

// Fixed ids created by scripts/ensure-integration-placeholders.js (see workflows/lib/ids.js).
const CRED = {
  linkedin: 'wfLinkedInCred01', circle: 'wfCircleCred0001',
  postgres: 'wfWcdwPgCred001', mysql: 'wfWcdwMyCred001', mssql: 'wfWcdwMsCred001', http: 'wfWcdwApiCred01',
};
const MAX_FIELD = 4096;

const str = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());
const bearer = (token) => `Bearer ${token.replace(/^bearer\s+/i, '')}`;
const hint = (s) => (s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : '••••');
class InputError extends Error {}

// Per service: which credential to patch, the credential data, the non-secret config to store.
function plan(service, config, secrets) {
  const c = Object.fromEntries(Object.entries(config || {}).map(([k, v]) => [k, str(v)]));
  const s = Object.fromEntries(Object.entries(secrets || {}).map(([k, v]) => [k, str(v)]));
  for (const v of [...Object.values(c), ...Object.values(s)]) if (v.length > MAX_FIELD) throw new InputError('a field is too long');
  if (service === 'linkedin') {
    const data = { legacy: false, organizationSupport: false };
    if (c.client_id) data.clientId = c.client_id;
    if (s.client_secret) data.clientSecret = s.client_secret;
    return { credId: CRED.linkedin, data, secret: !!s.client_secret,
             config: c.client_id ? { client_id_hint: hint(c.client_id) } : null };
  }
  if (service === 'circle') {
    return { credId: CRED.circle, data: s.api_token ? { name: 'Authorization', value: bearer(s.api_token) } : null,
             secret: !!s.api_token, config: { community_url: c.community_url || '' } };
  }
  if (service === 'wecommitdw') {
    const kind = c.kind;
    if (!CRED[kind] || ['linkedin', 'circle'].includes(kind)) throw new InputError('kind must be postgres, mysql, mssql or http');
    if (kind === 'http') {
      if (!c.base_url) throw new InputError('Base URL is required');
      return { credId: CRED.http, data: s.api_token ? { name: 'Authorization', value: bearer(s.api_token) } : null,
               secret: !!s.api_token, config: { kind, base_url: c.base_url, health_path: c.health_path || '' } };
    }
    if (!c.host || !c.database || !c.user) throw new InputError('host, database and user are required');
    const port = Number(c.port || { postgres: 5432, mysql: 3306, mssql: 1433 }[kind]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InputError('port must be 1-65535');
    const ssl = c.ssl === 'true' || c.ssl === true;
    const data = { port, database: c.database, user: c.user,
                   ...(kind === 'mssql' ? { server: c.host, tls: ssl } : { host: c.host }),
                   ...(kind === 'postgres' ? { ssl: ssl ? 'require' : 'disable' } : {}),
                   ...(kind === 'mysql' ? { ssl } : {}),
                   ...(s.password ? { password: s.password } : {}) };
    return { credId: CRED[kind], data, secret: !!s.password,
             config: { kind, host: c.host, port: String(port), database: c.database, user: c.user, ssl: String(ssl) } };
  }
  throw new InputError(`unknown service ${service}`);
}

module.exports = function createIntegrations({ n8nWebhookBase, apiKey, send, readBody }) {
  const apiBase = process.env.N8N_API_BASE || `${new URL(n8nWebhookBase).origin}/api/v1`;
  const dataDir = path.resolve(process.env.DASHBOARD_DATA_DIR || path.join(__dirname, '..', 'data', 'dashboard'));
  const keyFile = path.join(dataDir, 'n8n-api-key');
  const json = (res, status, body) => send(res, status, JSON.stringify(body));
  const fail = (res, status, code, message) => json(res, status, { ok: false, data: null, error: { code, message } });

  const n8nKey = () => {
    if (process.env.N8N_API_KEY) return process.env.N8N_API_KEY;
    try { return fs.readFileSync(keyFile, 'utf8').trim() || null; } catch { return null; }
  };
  const n8nApi = (method, p, body, key = n8nKey()) => fetch(`${apiBase}${p}`, {
    method, headers: { 'X-N8N-API-KEY': key, 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const webhook = async (method, p, body) => {
    const r = await fetch(`${n8nWebhookBase}/${p}`, {
      method, headers: { 'X-API-Key': apiKey, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
    });
    return r.json();
  };
  const n8nError = async (r) => {
    let m = '';
    try { m = (await r.json()).message || ''; } catch { /* not json */ }
    return `n8n API ${r.status}${m ? `: ${m}` : ''}`;
  };

  async function getAll(res) {
    const r = await webhook('GET', 'integrations');
    if (!r.ok) return json(res, r.error && r.error.code === 'service_unavailable' ? 503 : 502, r);
    r.data.n8n_admin = { configured: !!n8nKey(), from_env: !!process.env.N8N_API_KEY };
    return json(res, 200, r);
  }

  async function saveKey(req, res) {
    const key = str((await readBody(req)).api_key);
    if (key.length < 20 || key.length > MAX_FIELD) return fail(res, 400, 'invalid_request', 'API key không hợp lệ');
    const r = await n8nApi('GET', '/credentials?limit=1', null, key);
    if (r.status === 401 || r.status === 403) return fail(res, 400, 'invalid_key', 'n8n từ chối API key này (sai key hoặc đã bị xoá)');
    if (!r.ok) return fail(res, 502, 'n8n_error', await n8nError(r));
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    return json(res, 200, { ok: true, data: { configured: true }, error: null });
  }

  async function save(req, res) {
    const b = await readBody(req);
    const by = str(b.updated_by);
    if (!by) return fail(res, 400, 'invalid_request', 'updated_by is required');
    let p;
    try { p = plan(str(b.service), b.config, b.secrets); } catch (e) {
      if (e instanceof InputError) return fail(res, 400, 'invalid_request', e.message);
      throw e;
    }
    if (p.data && Object.keys(p.data).length) {
      if (!n8nKey()) return fail(res, 409, 'n8n_key_missing', 'Chưa nhập n8n API key (mục "Quyền quản trị n8n")');
      const r = await n8nApi('PATCH', `/credentials/${p.credId}`, { data: p.data, isPartialData: true });
      if (r.status === 404) return fail(res, 409, 'credential_missing', 'Credential giữ chỗ chưa có trong n8n: chạy lại scripts/deploy-workforce.ps1');
      if (!r.ok) return fail(res, 502, 'n8n_error', await n8nError(r));
    }
    const prev = ((await webhook('GET', 'integrations')).data?.services || []).find((x) => x.service === b.service);
    const config = p.config || (prev && prev.config) || {};
    const r = await webhook('POST', 'integrations/config', { service: b.service, config, secret_saved: p.secret, updated_by: by });
    return json(res, r.ok ? 200 : r.error && r.error.code === 'invalid_request' ? 400 : 502, r);
  }

  // Returns true when the request was handled here.
  return async function handle(req, res, endpoint) {
    try {
      if (endpoint === 'integrations' && req.method === 'GET') { await getAll(res); return true; }
      if (endpoint === 'integrations/n8n-key' && req.method === 'POST') { await saveKey(req, res); return true; }
      if (endpoint === 'integrations/save' && req.method === 'POST') { await save(req, res); return true; }
    } catch (e) {
      if (e && e.code === 'too_large') fail(res, 413, 'too_large', 'request body over 1 MB');
      else fail(res, 503, 'unavailable', `n8n không phản hồi: ${e && e.message}`);
      return true;
    }
    return false;
  };
};
