// Employee 2 — Marketing: turns one source into several coordinated content formats.
const FORMATS = ['linkedin_post', 'short_video_script', 'summary', 'content_outline', 'twitter_thread', 'newsletter_blurb'];

module.exports = {
  employee_id: 'emp_repurpose_studio',
  employee_name: 'Repurpose Studio Agent',
  department_id: 'dept_marketing',
  job_title: 'Content Repurposing Producer',
  description: 'Transforms source material into multiple coordinated content assets: LinkedIn posts, short-video scripts, summaries, outlines and more.',
  workflow_id: 'wfcEmpRepurpose1',
  skills: [
    { skill_name: 'multi_format_repurposing', description: `Formats: ${FORMATS.join(', ')}` },
    { skill_name: 'short_video_scripting', description: 'Hook, beats and on-screen text for 30-90 second videos' },
    { skill_name: 'content_outlining', description: 'Structured outlines for articles, talks or courses' },
    { skill_name: 'variation_coordination', description: 'Consistent message across formats and A/B variations' },
  ],
  input_schema: {
    type: 'object',
    'x-primary-input': 'source_text',
    'x-input-hint': 'Dán nội dung nguồn cần chuyển thể…',
    description: 'Needs source material (task input, plan context or prerequisite output).',
    properties: {
      source_text: { type: 'string' },
      formats: { type: 'array', items: { type: 'string', enum: FORMATS } },
      variations: { type: 'integer', minimum: 1, maximum: 3 },
      target_audience: { type: 'string' },
      tone: { type: 'string' },
    },
  },
  output_schema: {
    type: 'object',
    properties: {
      assets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: FORMATS },
            variation: { type: 'integer' },
            title: { type: 'string' },
            content: { type: 'string' },
            notes: { type: 'string' },
          },
          required: ['format', 'variation', 'title', 'content'],
        },
      },
      core_message: { type: 'string' },
      coordination_notes: { type: 'string' },
    },
    required: ['assets', 'core_message'],
  },
  system_message: [
    'You are the Repurpose Studio Agent in the Marketing department.',
    'Produce every requested format, for every requested variation, from the supplied source only.',
    'Keep one consistent core message across formats; adapt length and structure to each format:',
    '- linkedin_post: hook + short paragraphs, max 3000 characters.',
    '- short_video_script: 30-90 seconds, numbered beats with spoken line and on-screen text.',
    '- summary: 3-6 sentences. content_outline: hierarchical headings with bullet points.',
    '- twitter_thread: 4-8 posts, each max 280 characters. newsletter_blurb: 80-150 words.',
    'Do not add facts that are not in the source.',
  ].join('\n'),
  temperature: 0.7,

  validate: function () {
    const ALLOWED = ['linkedin_post', 'short_video_script', 'summary', 'content_outline', 'twitter_thread', 'newsletter_blurb'];
    const p = taskPayload();
    const errors = [];
    const source = directInput(p, ['source_text', 'transcript', 'text', 'content', 'article']);
    const deps = dependencyText(p, 30000);
    if (!source && !deps) errors.push('Source material is required (input_data.source_text, context.source_text/transcript, or a prerequisite output).');
    let formats = directInput(p, ['formats']) || ['linkedin_post', 'short_video_script', 'summary', 'content_outline'];
    if (!Array.isArray(formats)) formats = String(formats).split(',').map((f) => f.trim());
    const unknown = formats.filter((f) => !ALLOWED.includes(f));
    if (unknown.length) errors.push(`Unsupported formats: ${unknown.join(', ')}. Allowed: ${ALLOWED.join(', ')}`);
    const variations = Number(directInput(p, ['variations']) || 1);
    if (!Number.isInteger(variations) || variations < 1 || variations > 3) errors.push('variations must be an integer between 1 and 3');
    if (errors.length) return invalid(errors);

    const prompt = [
      taskBrief(p),
      `Formats to produce: ${formats.join(', ')}`,
      `Variations per format: ${variations}`,
      `Target audience: ${textOf(directInput(p, ['target_audience', 'audience'])) || 'general professional audience'}`,
      `Tone: ${textOf(directInput(p, ['tone'])) || 'clear and engaging'}`,
      source ? `## Source material\n${clip(source, 60000)}` : '',
      deps ? `## Prerequisite task outputs\n${deps}` : '',
    ].filter(Boolean).join('\n\n');
    return valid({ prompt, formats, variations });
  },

  postprocess: function () {
    const out = $json.output;
    const { formats, variations } = $('Validate Task Input').first().json;
    const assets = (out && Array.isArray(out.assets) ? out.assets : []).map((a) => ({
      ...a,
      word_count: String(a.content || '').split(/\s+/).filter(Boolean).length,
      status: 'draft',
    }));
    const missing = [];
    for (const f of formats) {
      for (let v = 1; v <= variations; v++) {
        if (!assets.some((a) => a.format === f && Number(a.variation) === v)) missing.push(`${f}#${v}`);
      }
    }
    if (missing.length) return failed('missing_formats', `model did not produce: ${missing.join(', ')}`, true);
    const warnings = assets.filter((a) => a.format === 'linkedin_post' && a.content.length > 3000)
      .map((a) => `linkedin_post variation ${a.variation} exceeds 3000 characters`);
    return done({ ...out, assets, requested_formats: formats, variations }, warnings);
  },
};
