// Creates/updates the n8n credentials used by the workforce workflows.
// Secrets come from .env (Postgres password, API key) and the GEMINI_API_KEY env var.
// The temporary credential file only lives briefly and is deleted right after import.
// Usage: GEMINI_API_KEY=... node scripts/import-credentials.js <n8nProjectId>
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { CREDENTIALS } = require('../workflows/lib/ids');

const projectId = process.argv[2];
if (!projectId) throw new Error('usage: node scripts/import-credentials.js <n8nProjectId>');

const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const geminiKey = process.env.GEMINI_API_KEY;
if (!geminiKey) throw new Error('GEMINI_API_KEY env var is required');

const credentials = [
  { ...CREDENTIALS.postgres, type: 'postgres',
    data: { host: 'postgres', port: 5432, database: 'workforce', user: 'workforce',
            password: env.WF_POSTGRES_PASSWORD, ssl: 'disable', allowUnauthorizedCerts: false, sshTunnel: false } },
  { ...CREDENTIALS.gemini, type: 'googlePalmApi',
    data: { host: 'https://generativelanguage.googleapis.com', apiKey: geminiKey } },
  { ...CREDENTIALS.apiKey, type: 'httpHeaderAuth',
    data: { name: 'X-API-Key', value: env.WORKFORCE_API_KEY } },
];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-cred-'));
const tmp = path.join(tmpDir, 'credentials.json');
try {
  fs.writeFileSync(tmp, JSON.stringify(credentials), { mode: 0o600 });
  execFileSync('docker', ['cp', tmp, 'n8n:/tmp/wf-credentials.json']);
  const out = execFileSync('docker', ['exec', 'n8n', 'n8n', 'import:credentials',
    '--input=/tmp/wf-credentials.json', `--projectId=${projectId}`]).toString();
  console.log(out.trim().split('\n').pop());
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  execFileSync('docker', ['exec', '-u', 'root', 'n8n', 'rm', '-f', '/tmp/wf-credentials.json']);
}
