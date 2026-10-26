// Employee 8 — Customer Success & Community: answers questions from approved knowledge only
// (wf.knowledge_articles where approved = true, plus sources supplied with the task).
module.exports = {
  employee_id: 'emp_knowledge_support',
  employee_name: 'Knowledge & Support Agent',
  department_id: 'dept_customer_success',
  job_title: 'Knowledge & Support Specialist',
  description: 'Answers customer and employee questions from approved knowledge sources, classifies requests, cites sources with confidence and escalates what it cannot answer reliably.',
  workflow_id: 'wfcEmpKnowledge1',
  skills: [
    { skill_name: 'request_classification', description: 'Category, requester type and urgency' },
    { skill_name: 'knowledge_retrieval', description: 'Full-text search over approved knowledge articles' },
    { skill_name: 'grounded_answering', description: 'Answers that cite approved sources only' },
    { skill_name: 'escalation', description: 'Escalate low-confidence or unsupported questions' },
  ],
  input_schema: {
    type: 'object',
    'x-primary-input': 'question',
    'x-input-hint': 'Câu hỏi của khách hàng / nhân viên…',
    properties: {
      question: { type: 'string' },
      requester_type: { type: 'string', enum: ['customer', 'employee'] },
      knowledge_sources: {
        type: 'array',
        description: 'Optional approved sources supplied with the request',
        items: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, source_url: { type: 'string' } } },
      },
    },
    required: ['question'],
  },
  output_schema: {
    type: 'object',
    properties: {
      classification: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['billing', 'technical', 'account', 'product', 'policy', 'other'] },
          requester_type: { type: 'string', enum: ['customer', 'employee', 'unknown'] },
          urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['category', 'requester_type', 'urgency'],
      },
      answer: { type: 'string', description: 'Empty if the sources do not answer the question' },
      cited_source_ids: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number', description: '0 to 1' },
      escalate: { type: 'boolean' },
      escalation_reason: { type: 'string' },
      follow_up_questions: { type: 'array', items: { type: 'string' } },
    },
    required: ['classification', 'answer', 'cited_source_ids', 'confidence', 'escalate'],
  },
  system_message: [
    'You are the Knowledge & Support Agent in Customer Success & Community.',
    'Answer ONLY from the numbered sources in the prompt. Cite the source ids you used.',
    '- If the sources do not contain the answer, leave answer empty, set escalate=true and explain why.',
    '- Do not use outside knowledge, guess policies, prices or dates.',
    '- confidence reflects how completely the sources answer the question.',
  ].join('\n'),
  temperature: 0.1,

  validate: function () {
    const p = taskPayload();
    const question = textOf(directInput(p, ['question', 'query', 'request'])).trim();
    if (question.length < 5) return invalid(['A question of at least 5 characters is required (input_data.question).']);
    if (question.length > 4000) return invalid(['The question is longer than 4000 characters.']);
    const supplied = directInput(p, ['knowledge_sources']);
    if (supplied !== undefined && !Array.isArray(supplied)) return invalid(['knowledge_sources must be an array of {title, content, source_url}.']);
    return valid({
      question,
      requester_type: textOf(directInput(p, ['requester_type'])) || 'unknown',
      supplied_sources: (supplied || []).filter((s) => s && s.content)
        .map((s, i) => ({ source_id: `supplied-${i + 1}`, title: s.title || `Supplied source ${i + 1}`,
                          source_url: s.source_url || null, content: clip(s.content, 6000) })),
    });
  },

  prefetch(wb, [x, y]) {
    const name = wb.pg('Search Knowledge Base', 'SELECT wf.search_knowledge($1, 5) AS articles',
      '={{ [$json.question] }}', [x, y]);
    return { first: name, last: name };
  },

  buildPrompt: function () {
    const v = $('Validate Task Input').first().json;
    const kb = ($('Search Knowledge Base').first().json.articles || [])
      .map((a) => ({ source_id: `kb-${a.article_id}`, title: a.title, source_url: a.source_url, content: a.content }));
    const sources = [...v.supplied_sources, ...kb];
    const prompt = [
      taskBrief(taskPayload()),
      `Requester type: ${v.requester_type}`,
      `## Question\n${v.question}`,
      sources.length
        ? `## Sources\n${sources.map((s) => `[${s.source_id}] ${s.title}${s.source_url ? ` (${s.source_url})` : ''}\n${s.content}`).join('\n\n')}`
        : '## Sources\nNo approved sources matched this question.',
    ].join('\n\n');
    return [{ json: { prompt, sources: sources.map(({ content, ...s }) => s) } }];
  },

  postprocess: function () {
    const out = $json.output;
    const { sources } = $('Build Prompt').first().json;
    if (!out) return failed('invalid_ai_output', 'model returned no answer object', true);
    const warnings = [];
    const known = new Map(sources.map((s) => [s.source_id, s]));
    const cited = (out.cited_source_ids || []).filter((id) => known.has(id));
    if (cited.length < (out.cited_source_ids || []).length) warnings.push('citations to unknown sources were removed');
    let confidence = Math.max(0, Math.min(1, Number(out.confidence) || 0));
    let escalate = !!out.escalate;
    let reason = out.escalation_reason || '';
    if (!sources.length) { escalate = true; confidence = 0; reason = reason || 'no approved knowledge source matched the question'; }
    if (out.answer && !cited.length) { escalate = true; confidence = Math.min(confidence, 0.3); reason = reason || 'answer is not backed by a cited source'; }
    if (confidence < 0.6 && !escalate) { escalate = true; reason = reason || `low confidence (${confidence})`; }
    return done({
      ...out,
      answer: sources.length ? out.answer : '',
      cited_source_ids: cited,
      sources: cited.map((id) => known.get(id)),
      confidence,
      escalate,
      escalation_reason: reason,
      response_status: 'draft_not_sent',
    }, warnings);
  },
};
