// Employee 6 — Customer Success & Community: triages supplied community discussions.
// Circle API access is not configured, so it works on supplied data and only drafts replies.
module.exports = {
  employee_id: 'emp_circle_checker',
  employee_name: 'Circle Community Checker Agent',
  department_id: 'dept_customer_success',
  job_title: 'Community Moderator',
  description: 'Analyzes supplied community discussions, activity reports and unanswered questions, drafts responses and escalates uncertain or sensitive cases.',
  workflow_id: 'wfcEmpCircleChk1',
  skills: [
    { skill_name: 'community_triage', description: 'Find threads that need attention and prioritize them' },
    { skill_name: 'response_drafting', description: 'Draft on-brand replies (never posted automatically)' },
    { skill_name: 'escalation_judgement', description: 'Escalate sensitive, uncertain or urgent cases to humans' },
  ],
  input_schema: {
    type: 'object',
    'x-primary-input': 'community_data',
    'x-input-hint': 'Dán các thảo luận cộng đồng cần soát…',
    description: 'Needs community data supplied in the request (Circle API integration is not configured).',
    properties: {
      community_data: { type: ['string', 'array', 'object'], description: 'Discussions, posts, activity report' },
      community_guidelines: { type: 'string' },
    },
  },
  output_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            reference: { type: 'string', description: 'Thread/post id, title or URL from the supplied data' },
            author: { type: 'string' },
            issue: { type: 'string' },
            category: { type: 'string', enum: ['unanswered_question', 'complaint', 'bug_report', 'feedback', 'spam', 'sensitive', 'other'] },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
            draft_response: { type: 'string' },
            escalate: { type: 'boolean' },
            escalation_reason: { type: 'string' },
          },
          required: ['reference', 'issue', 'category', 'priority', 'draft_response', 'escalate'],
        },
      },
      unanswered_questions: { type: 'array', items: { type: 'string' } },
      trends: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'items', 'unanswered_questions'],
  },
  system_message: [
    'You are the Circle Community Checker Agent in Customer Success & Community.',
    'Work only from the supplied community data. You cannot read or post to Circle.',
    '- Identify every thread needing attention; reference it exactly as it appears in the data.',
    '- Draft friendly, accurate replies. Do not promise refunds, features, dates or policies not stated in the data.',
    '- Escalate (escalate=true) anything sensitive (legal, safety, harassment, personal data, billing disputes), urgent, or that you cannot answer reliably.',
  ].join('\n'),
  temperature: 0.4,

  validate: function () {
    const p = taskPayload();
    const data = directInput(p, ['community_data', 'discussions', 'posts', 'activity_report', 'threads']);
    const deps = dependencyText(p, 20000);
    if (!data && !deps) {
      return invalid(['Community data is required (input_data.community_data or context.community_data/discussions). '
        + 'The Circle API integration is not configured.']);
    }
    const guidelines = directInput(p, ['community_guidelines', 'guidelines']);
    const prompt = [
      taskBrief(p),
      `Community guidelines: ${guidelines ? clip(guidelines, 6000) : 'none supplied'}`,
      data ? `## Community data\n${clip(data, 60000)}` : '',
      deps ? `## Prerequisite task outputs\n${deps}` : '',
    ].filter(Boolean).join('\n\n');
    return valid({ prompt });
  },

  postprocess: function () {
    const out = $json.output;
    if (!out || !Array.isArray(out.items)) return failed('invalid_ai_output', 'model returned no items array', true);
    let forced = 0;
    const items = out.items.map((i) => {
      const mustEscalate = i.category === 'sensitive' || i.priority === 'urgent';
      if (mustEscalate && !i.escalate) forced++;
      return {
        ...i,
        escalate: i.escalate || mustEscalate,
        escalation_reason: i.escalation_reason || (mustEscalate ? `auto-escalated: ${i.category}/${i.priority}` : ''),
        response_status: 'draft_not_posted',
      };
    });
    return done({
      ...out,
      items,
      escalation_count: items.filter((i) => i.escalate).length,
      integration_note: 'Circle API is not configured; data was supplied in the request and responses are drafts only.',
    }, forced ? [`${forced} sensitive/urgent item(s) were escalated by policy`] : []);
  },
};
