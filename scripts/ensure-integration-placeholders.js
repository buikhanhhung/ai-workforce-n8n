// Creates the empty integration credentials (LinkedIn, Circle, WeCommitDW) with their fixed ids in
// n8n, ONLY when they do not exist yet: an existing credential (possibly filled from the dashboard)
// is never overwritten. The dashboard later fills them through the n8n public API.
// Usage: node scripts/ensure-integration-placeholders.js <n8nProjectId>
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CREDENTIALS, INTEGRATION_CREDENTIALS } = require('../workflows/lib/ids');

const projectId = process.argv[2];
if (!projectId) throw new Error('usage: node scripts/ensure-integration-placeholders.js <n8nProjectId>');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' });

// Ids only: the export (encrypted data) never leaves the container.
const existing = new Set(docker('exec', 'n8n', 'sh', '-c',
  'n8n export:credentials --all --output=/tmp/cred-ids.json >/dev/null 2>&1; '
  + 'node -e "for (const c of require(\'/tmp/cred-ids.json\')) console.log(c.id)"; rm -f /tmp/cred-ids.json')
  .split(/\r?\n/).filter(Boolean));

const missing = INTEGRATION_CREDENTIALS.map((k) => CREDENTIALS[k]).filter((c) => !existing.has(c.id));
if (!missing.length) {
  console.log('integration credentials: all present');
  process.exit(0);
}
const file = path.join(os.tmpdir(), 'wf-integration-placeholders.json');
fs.writeFileSync(file, JSON.stringify(missing.map((c) => ({ id: c.id, name: c.name, type: c.type, data: c.placeholder }))));
try {
  docker('cp', file, 'n8n:/tmp/wf-integration-placeholders.json');
  docker('exec', 'n8n', 'n8n', 'import:credentials', '--input=/tmp/wf-integration-placeholders.json', `--projectId=${projectId}`);
} finally {
  fs.rmSync(file, { force: true });
  docker('exec', '-u', 'root', 'n8n', 'rm', '-f', '/tmp/wf-integration-placeholders.json');
}
console.log(`integration credentials created: ${missing.map((c) => c.name).join(', ')}`);
