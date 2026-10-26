// Prints the id of the n8n owner's personal project (the project that owns the workforce workflows
// and credentials). Runs INSIDE the n8n container, read-only on its SQLite database.
// Usage (host): powershell -File scripts/n8n-project-id.ps1
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/home/node/.n8n/database.sqlite', { readOnly: true });
const userCols = db.prepare('PRAGMA table_info("user")').all().map((c) => c.name);
const roleCol = userCols.includes('roleSlug') ? 'roleSlug' : 'role';
const row = db.prepare(`SELECT p.id FROM project p
  JOIN project_relation r ON r.projectId = p.id
  JOIN "user" u ON u.id = r.userId
  WHERE p.type = 'personal' AND u.${roleCol} = 'global:owner' LIMIT 1`).get();
if (!row) {
  console.error('No n8n owner yet: open http://localhost:5678 and create the owner account first.');
  process.exit(1);
}
console.log(row.id);
