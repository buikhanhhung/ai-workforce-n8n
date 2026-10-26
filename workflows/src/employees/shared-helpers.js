// Functions shared by employee Code nodes. They are serialized into each Code node (n8n Code
// nodes cannot import local modules), so they may only use Code-node globals such as $().
// Contract of every employee workflow result:
//   { status: 'completed', output: {...}, metadata: { employee_id, warnings[] } }
//   { status: 'failed', error: { code, message, retryable }, metadata: {...} }

function textOf(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function clip(value, max) {
  const s = textOf(value);
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

// First non-empty value among keys of obj.
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj ? obj[k] : undefined;
    if (v !== undefined && v !== null && textOf(v).trim() !== '') return v;
  }
  return undefined;
}

// The standardized payload received from the task runner (Execute Sub-workflow trigger).
function taskPayload() {
  return $('Task Payload').first().json;
}

// Looks for source material in task input first, then shared plan context.
function directInput(p, keys) {
  return pick(p.task && p.task.input_data, keys) ?? pick(p.plan && p.plan.context, keys);
}

function dependencyText(p, max) {
  const deps = (p.dependency_outputs || []).filter((d) => d.output);
  if (!deps.length) return '';
  return clip(deps.map((d) => `### Output of ${d.task_id} (${d.task_name}, by ${d.employee_id})\n${textOf(d.output)}`)
    .join('\n\n'), max);
}

function taskBrief(p) {
  const t = p.task || {};
  return [
    `Business objective: ${p.plan && p.plan.objective}`,
    `Task ${t.task_id}: ${t.task_name}`,
    `Description: ${t.description}`,
    `Expected output: ${t.expected_output}`,
    `Acceptance criteria:\n- ${(t.acceptance_criteria || []).join('\n- ')}`,
    t.revision_cycle ? `This is revision cycle ${t.revision_cycle}; address the reviewer feedback in the task input.` : '',
    `Task input data:\n${clip(t.input_data, 4000)}`,
  ].filter(Boolean).join('\n');
}

function invalid(errors) {
  return [{ json: { valid: false, errors } }];
}

function valid(fields) {
  return [{ json: { valid: true, ...fields } }];
}

function done(output, warnings) {
  return [{ json: { status: 'completed', output,
                    metadata: { employee_id: EMPLOYEE_ID, warnings: warnings || [], finished_at: new Date().toISOString() } } }];
}

function failed(code, message, retryable) {
  return [{ json: { status: 'failed', error: { code, message, retryable },
                    metadata: { employee_id: EMPLOYEE_ID, finished_at: new Date().toISOString() } } }];
}

// Collapses whitespace/case so model quotes can be matched against the supplied input.
function normalizeForMatch(s) {
  return textOf(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

module.exports = {
  textOf, clip, pick, taskPayload, directInput, dependencyText, taskBrief,
  invalid, valid, done, failed, normalizeForMatch,
};
