// Creates .env from .env.example with fresh random secrets. Never overwrites an existing .env
// (its database password must keep matching the existing PostgreSQL volume).
// Usage: node scripts/init-env.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const target = path.join(root, '.env');
if (fs.existsSync(target)) {
  console.log('.env already exists: left unchanged');
  process.exit(0);
}
const secret = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const values = { WF_POSTGRES_PASSWORD: secret(24), WORKFORCE_API_KEY: secret(32) };
const text = fs.readFileSync(path.join(root, '.env.example'), 'utf8')
  .replace(/^(\w+)=.*$/gm, (line, key) => (key in values ? `${key}=${values[key]}` : line));
fs.writeFileSync(target, text, { mode: 0o600 });
console.log(`.env created with new ${Object.keys(values).join(' and ')}`);
