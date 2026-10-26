// Sends each CEO demo scenario (data inline in the objective, no attachments), checks the CEO
// routed it to the expected employee, waits for the result and prints a one-line verdict.
// Usage: node tests/run-ceo-demo-scenarios.js [name filter]   (dashboard on http://localhost:3000)
const filter = (process.argv[2] || '').toLowerCase();
const scenarios = require('./requests/ceo-demo-scenarios.json').filter((s) => s.name.toLowerCase().includes(filter));
const BASE = process.env.DASHBOARD_URL || 'http://localhost:3000/api';
const api = (m, p, b) => fetch(`${BASE}/${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const runs = [];
  for (const s of scenarios) {           // the CEO plans one request at a time
    const r = await api('POST', 'requests', { objective: s.objective, requested_by: 'ceo-demo', max_revision_cycles: 0 });
    if (!r.ok) { runs.push({ s, error: r.error && r.error.message }); continue; }
    runs.push({ s, plan: r.data.plan_id, assigned: r.data.tasks.map((t) => t.assigned_employee_id) });
  }
  for (const run of runs.filter((x) => x.plan)) {
    for (let i = 0; i < 60; i++) {
      const p = (await api('GET', `plan?plan_id=${run.plan}`)).data;
      if (!['running', 'reviewing', 'planning'].includes(p.status)) {
        run.status = p.status;
        run.tasks = p.tasks.map((t) => `${t.assigned_employee_id}:${t.status}${t.last_error ? ` (${t.last_error.message})` : ''}`);
        break;
      }
      await sleep(5000);
    }
  }
  for (const run of runs) {
    const routed = run.assigned && run.s.expect.every((e) => run.assigned.includes(e));
    console.log(`${routed ? 'ROUTED OK ' : 'ROUTED BAD'} | ${run.s.name.padEnd(26)} | assigned=${(run.assigned || []).join(',')} | plan=${run.status || run.error} | ${(run.tasks || []).join(' ')}`);
  }
})();
