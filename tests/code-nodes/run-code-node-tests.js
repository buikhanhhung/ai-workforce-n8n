// Unit tests for Code-node logic, executed against the BUILT workflow JSON (workflows/dist),
// with n8n globals ($, $json, $input, $execution) mocked. No n8n or LLM needed.
// Usage: node workflows/build-workflows.js && node tests/code-nodes/run-code-node-tests.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { WORKFLOW_IDS } = require('../../workflows/lib/ids');

const dist = path.join(__dirname, '..', '..', 'workflows', 'dist');
const load = (id) => JSON.parse(fs.readFileSync(path.join(dist, `${id}.json`), 'utf8'));

// Runs one Code node. nodes: { 'Node Name': json } returned by $('Node Name').first().json
function runCode(workflowId, nodeName, { json = {}, nodes = {} } = {}) {
  const node = load(workflowId).nodes.find((n) => n.name === nodeName);
  assert(node, `node ${nodeName} not found in ${workflowId}`);
  const $ = (name) => {
    if (!(name in nodes)) return { isExecuted: false, first: () => { throw new Error(`node ${name} not mocked`); } };
    return { isExecuted: true, first: () => ({ json: nodes[name] }), all: () => [{ json: nodes[name] }] };
  };
  const $input = { first: () => ({ json }), all: () => [{ json }] };
  const fn = new Function('$', '$json', '$input', '$execution', node.parameters.jsCode);
  return fn($, json, $input, { id: 'test-exec' }).map((i) => i.json);
}

const catalog = [
  { employee_id: 'emp_yt_linkedin', department_id: 'dept_marketing' },
  { employee_id: 'emp_visual_design', department_id: 'dept_marketing' },
];
const task = (id, extra = {}) => ({
  task_id: id, task_name: id, description: 'd', assigned_employee_id: 'emp_yt_linkedin', department_id: 'dept_marketing',
  input_data: {}, depends_on: [], expected_output: 'x', acceptance_criteria: ['c'], priority: 'medium', ...extra,
});
const validatePlan = (tasks) => runCode(WORKFLOW_IDS.planning, 'Validate Task Plan', {
  json: { output: { plan_summary: 's', tasks } }, nodes: { 'Load Employee Catalog': { catalog } },
})[0];

const tests = {
  'plan: valid graph passes and system fields are forced'() {
    const r = validatePlan([task('T1', { status: 'completed', retry_count: 9 }), task('T2', { depends_on: ['T1'] }), task('T3')]);
    assert.strictEqual(r.valid, true, r.errors.join('; '));
    assert.deepStrictEqual(r.independent_tasks, ['T1', 'T3']);
    assert.strictEqual(r.plan.tasks[0].status, 'pending');
    assert.strictEqual(r.plan.tasks[0].retry_count, 0);
  },
  'plan: circular dependency rejected with path'() {
    const r = validatePlan([task('T1', { depends_on: ['T3'] }), task('T2', { depends_on: ['T1'] }), task('T3', { depends_on: ['T2'] })]);
    assert.strictEqual(r.valid, false);
    assert(r.errors.some((e) => /circular dependency: T1 -> T3 -> T2 -> T1/.test(e)), r.errors.join('; '));
  },
  'plan: unknown employee, wrong department, duplicate id, bad dependency, self dependency'() {
    const r = validatePlan([
      task('T1', { assigned_employee_id: 'emp_ghost' }),
      task('T2', { department_id: 'dept_operations' }),
      task('T2'),
      task('T4', { depends_on: ['T9'] }),
      task('T5', { depends_on: ['T5'] }),
    ]);
    assert.strictEqual(r.valid, false);
    for (const re of [/unknown or unavailable employee "emp_ghost"/, /belongs to dept_marketing/, /duplicate task_id/,
                      /depends on unknown task "T9"/, /T5: depends on itself/]) {
      assert(r.errors.some((e) => re.test(e)), `missing error ${re}: ${r.errors.join('; ')}`);
    }
  },
  'plan: work no listed employee can do is reported, not forced'() {
    const r = runCode(WORKFLOW_IDS.planning, 'Validate Task Plan', {
      json: { output: { plan_summary: 's', tasks: [], out_of_scope: [{ request: 'check system logs', reason: 'no log analyst', suggested_department: 'Operations' }] } },
      nodes: { 'Load Employee Catalog': { catalog } },
    })[0];
    assert.strictEqual(r.valid, false);
    assert(/check system logs/.test(r.errors[0]) && /Operations/.test(r.errors[0]), r.errors.join('; '));
    const ok = runCode(WORKFLOW_IDS.planning, 'Validate Task Plan', {
      json: { output: { plan_summary: 's', tasks: [task('T1')], out_of_scope: [{ request: 'x', reason: 'y' }] } },
      nodes: { 'Load Employee Catalog': { catalog } },
    })[0];
    assert.strictEqual(ok.valid, true);
    assert.strictEqual(ok.out_of_scope.length, 1);
  },
  'plan: empty plan rejected'() {
    assert.strictEqual(validatePlan([]).valid, false);
  },
  'planning: YouTube link in the objective becomes context.youtube_url'() {
    const [r] = runCode(WORKFLOW_IDS.planning, 'Validate Request', { json: { body: {
      objective: 'Xem video https://www.youtube.com/watch?v=aircAruvnKk rồi viết bài LinkedIn' } } });
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.request.context.youtube_url, 'https://www.youtube.com/watch?v=aircAruvnKk');
  },
  'runner: context references are resolved, unknown ones dropped'() {
    const [p] = runCode(WORKFLOW_IDS.taskRunner, 'Build Employee Payload', { json: { run: {
      task: { task_id: 'T1', plan_id: 'p', input_data: { transcript: 'context.transcript', tone: 'calm', brand: '{{ context.missing }}', nested: { a: 'context.audience' } } },
      plan: { context: { transcript: 'REAL TRANSCRIPT', audience: 'ops' } },
      dependency_outputs: [], execution_id: 'e', attempt: 1, employee: { workflow_reference: 'w' },
    } } });
    assert.strictEqual(p.task.input_data.transcript, 'REAL TRANSCRIPT');
    assert.strictEqual(p.task.input_data.nested.a, 'ops');
    assert.strictEqual(p.task.input_data.tone, 'calm');
    assert(!('brand' in p.task.input_data));
    assert.deepStrictEqual(p.unresolved_context_refs, ['{{ context.missing }}']);
  },
  'coaching: invented timestamps are removed'() {
    const [r] = runCode('wfcEmpCoachTime1', 'Post-process Output', {
      json: { output: { chapters: [{ start: '00:00', end: '02:15', title: 'a' }, { start: '03:33', title: 'invented' }],
                        highlights: [{ timestamp: '02:15' }, { timestamp: '07:07' }], media_handoff_notes: [] } },
      nodes: { 'Validate Task Input': { valid_seconds: [0, 135] } },
    });
    assert.strictEqual(r.status, 'completed');
    assert.deepStrictEqual(r.output.chapters.map((c) => c.start), ['00:00']);
    assert.deepStrictEqual(r.output.highlights.map((h) => h.timestamp), ['02:15']);
    assert.strictEqual(r.output.removed_unsupported_items, 2);
  },
  'coaching: transcript without timestamps is invalid input'() {
    const [r] = runCode('wfcEmpCoachTime1', 'Validate Task Input', {
      nodes: { 'Task Payload': { task: { input_data: {} }, plan: { context: { transcript: 'no times here' } } } },
    });
    assert.strictEqual(r.valid, false);
  },
  'visual: card text is bounded, palette validated, image only claimed by the render step'() {
    const [r] = runCode('wfcEmpVisualDsg1', 'Post-process Output', {
      json: { output: { concept_title: 'c', visual_concept: 'v', design_brief: {}, image_generated: true, asset_urls: ['https://fake/img.png'],
        card: { headline: 'H'.repeat(200), points: [{ title: '1. a', text: 'b' }, { title: '2) c', text: 'd' }], layout: 'flow',
                palette: { primary: '#123456', accent: 'orange' } } } },
      nodes: { 'Validate Task Input': { dimensions: { width: 1200, height: 627 }, has_brand_guidelines: true } },
    });
    assert.strictEqual(r.status, 'completed');
    assert.strictEqual(r.output.image_generated, false);
    assert.deepStrictEqual(r.output.asset_urls, []);
    assert(r.output.card.headline.length <= 90);
    assert.deepStrictEqual(r.output.card.palette, { primary: '#123456' });
    assert.deepStrictEqual(r.output.card.points.map((p) => p.title), ['a', 'c']);
  },
  'visual: a card with fewer than 2 points is rejected for retry'() {
    const [r] = runCode('wfcEmpVisualDsg1', 'Post-process Output', {
      json: { output: { card: { headline: 'H', points: [{ title: 'only one', text: 'x' }] } } },
      nodes: { 'Validate Task Input': { dimensions: { width: 1200, height: 627 } } },
    });
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.error.retryable, true);
  },
  'youtube: URL alone is accepted and marked for real transcription'() {
    const [r] = runCode('wfcEmpYtLinkdIn1', 'Validate Task Input', {
      nodes: { 'Task Payload': { task: { input_data: { youtube_url: 'https://www.youtube.com/watch?v=abcdefgh' } }, plan: { context: {} }, dependency_outputs: [] } },
    });
    assert.strictEqual(r.valid, true, (r.errors || []).join(' '));
    assert.strictEqual(r.needs_transcript, true);
  },
  'youtube: bare link typed in the Giao lai box is treated as the video'() {
    const [r] = runCode('wfcEmpYtLinkdIn1', 'Validate Task Input', {
      nodes: { 'Task Payload': { task: { input_data: { source_text: 'https://youtu.be/aircAruvnKk' } }, plan: { context: {} }, dependency_outputs: [] } },
    });
    assert.strictEqual(r.youtube_url, 'https://www.youtube.com/watch?v=aircAruvnKk');
    assert.strictEqual(r.needs_transcript, true);
  },
  'youtube: playlist / share parameters are dropped (Gemini rejects them with Bad request)'() {
    for (const [input, id] of [
      ['https://www.youtube.com/watch?v=4MxbtnBS-Iw&list=PLE0F17DE4E825F04A&index=161', '4MxbtnBS-Iw'],
      ['https://youtu.be/aircAruvnKk?si=abc123&t=42', 'aircAruvnKk'],
      ['https://www.youtube.com/shorts/abcdefgh123', 'abcdefgh123'],
    ]) {
      const [r] = runCode('wfcEmpYtLinkdIn1', 'Validate Task Input', {
        nodes: { 'Task Payload': { task: { input_data: { youtube_url: input } }, plan: { context: {} }, dependency_outputs: [] } },
      });
      assert.strictEqual(r.youtube_url, `https://www.youtube.com/watch?v=${id}`, input);
    }
  },
  'youtube: failed transcription fails the task instead of writing from nothing'() {
    assert.throws(() => runCode('wfcEmpYtLinkdIn1', 'Build Prompt', { nodes: {
      'Validate Task Input': { youtube_url: 'https://youtu.be/x', needs_transcript: true, audience: 'a', tone: 't' },
      'Fetch YouTube Metadata': {}, 'Transcribe YouTube Video': { error: { message: 'quota' } },
      'Task Payload': { task: { acceptance_criteria: [] }, plan: {} } } }), /YouTube transcription failed/);
  },
  'youtube: Markdown is stripped from the LinkedIn post'() {
    const [r] = runCode('wfcEmpYtLinkdIn1', 'Post-process Output', {
      json: { output: { title: 't', post: '## Hook\n🔹 **Neuron là gì?**\n* điểm một\n2*3=6', summary: 's', key_ideas: [], hashtags: [],
                        factual_claims: [{ claim: 'c', supported_by: 'q' }], source_references: [] } },
      nodes: { 'Build Prompt': { video: null, transcript_source: 'supplied', transcript: '' }, 'Validate Task Input': { youtube_url: '' } },
    });
    assert.strictEqual(r.status, 'completed');
    assert.strictEqual(r.output.post, 'Hook\n🔹 Neuron là gì?\n• điểm một\n2*3=6');
  },
  'knowledge: no sources forces escalation; unknown citations removed'() {
    const [r] = runCode('wfcEmpKnowledge1', 'Post-process Output', {
      json: { output: { answer: 'Refunds take 3 days', cited_source_ids: ['kb-99'], confidence: 0.9, escalate: false } },
      nodes: { 'Build Prompt': { sources: [] } },
    });
    assert.strictEqual(r.output.escalate, true);
    assert.strictEqual(r.output.answer, '');
    assert.deepStrictEqual(r.output.cited_source_ids, []);
  },
  'skill recommendation: employee outside the catalog is rejected'() {
    const [r] = runCode('wfcEmpSkillRec01', 'Post-process Output', {
      json: { output: { recommended_employee_id: 'emp_ghost', recommended_skills: ['x'], capability_gaps: [], confidence: 2 } },
      nodes: { 'Load Employee Catalog': { catalog: [{ employee_id: 'emp_yt_linkedin', current_status: 'available', skills: [], workflow_reference: 'w' }] } },
    });
    assert.strictEqual(r.output.recommended_employee_id, null);
    assert.strictEqual(r.output.workflow_reference, null);
    assert.strictEqual(r.output.confidence, 1);
  },
  'system checker: evidence not in the data is flagged'() {
    const [r] = runCode('wfcEmpSysCheck01', 'Post-process Output', {
      json: { output: { findings: [{ evidence: 'Disk usage /data: 91%' }, { evidence: 'CPU at 100% for 3 hours' }] } },
      nodes: { 'Validate Task Input': { evidence_corpus: 'disk usage /data: 91% (threshold 85%)' } },
    });
    assert.deepStrictEqual(r.output.findings.map((f) => f.evidence_verified), [true, false]);
  },
  'review: approval with unmet criteria is downgraded and revisions are namespaced'() {
    const ctx = { plan_id: 'p', revision_cycle: 0, max_revision_cycles: 1, employee_ids: ['emp_yt_linkedin'],
                  employee_departments: { emp_yt_linkedin: 'dept_marketing' }, tasks: [{ task_id: 'T1' }] };
    const [r] = runCode(WORKFLOW_IDS.review, 'Enforce Review Rules', {
      json: { output: { verdict: 'approved', acceptance_checks: [{ task_id: 'T1', met: false }], missing_deliverables: [],
                        revision_tasks: [{ task_id: 'T1', assigned_employee_id: 'emp_yt_linkedin', depends_on: ['T1'], acceptance_criteria: ['ok'] }],
                        final_report: { deliverables: [{ task_id: 'T1' }, { task_id: 'GHOST' }] } } },
      nodes: { 'Load Review Context': { ctx } },
    });
    assert.strictEqual(r.review.verdict, 'changes_needed');
    assert.strictEqual(r.action, 'revise');
    assert.strictEqual(r.revision_tasks[0].task_id, 'R1-T1');
    assert.deepStrictEqual(r.final_report.deliverables.map((d) => d.task_id), ['T1']);
  },
  'review: no revision once the limit is reached'() {
    const ctx = { plan_id: 'p', revision_cycle: 1, max_revision_cycles: 1, employee_ids: ['emp_yt_linkedin'],
                  employee_departments: {}, tasks: [{ task_id: 'T1' }] };
    const [r] = runCode(WORKFLOW_IDS.review, 'Enforce Review Rules', {
      json: { output: { verdict: 'changes_needed', acceptance_checks: [], missing_deliverables: [],
                        revision_tasks: [{ task_id: 'X', assigned_employee_id: 'emp_yt_linkedin', depends_on: [], acceptance_criteria: ['ok'] }],
                        final_report: { deliverables: [] } } },
      nodes: { 'Load Review Context': { ctx } },
    });
    assert.strictEqual(r.action, 'finalize');
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
console.log(`${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
