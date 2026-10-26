// Employee 7 — Customer Success & Community: chapters and highlights for coaching videos.
// Every timestamp in the output is checked against the timestamps present in the transcript.
module.exports = {
  employee_id: 'emp_coaching_timeline',
  employee_name: 'Coaching Timeline Agent',
  department_id: 'dept_customer_success',
  job_title: 'Coaching Media Coordinator',
  description: 'Analyzes timestamped coaching transcripts to create chapter outlines, highlight timestamps and media handoff notes, never inventing timestamps.',
  workflow_id: 'wfcEmpCoachTime1',
  skills: [
    { skill_name: 'chaptering', description: 'Split a session into titled chapters with start/end timestamps' },
    { skill_name: 'highlight_selection', description: 'Pick clip-worthy moments aligned with coaching objectives' },
    { skill_name: 'media_handoff', description: 'Editor notes: cuts, b-roll, captions, thumbnails' },
  ],
  input_schema: {
    type: 'object',
    'x-primary-input': 'transcript',
    'x-input-hint': 'Dán transcript có timestamp (00:01:23)…',
    description: 'Needs a transcript containing timestamps like 00:01:23 or 12:45.',
    properties: {
      transcript: { type: 'string' },
      video_title: { type: 'string' },
      coaching_objectives: { type: ['string', 'array'] },
    },
  },
  output_schema: {
    type: 'object',
    properties: {
      video_title: { type: 'string' },
      chapters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'Timestamp copied from the transcript' },
            end: { type: 'string', description: 'Timestamp copied from the transcript, or empty for the last chapter' },
            title: { type: 'string' },
            summary: { type: 'string' },
            evidence_quote: { type: 'string' },
          },
          required: ['start', 'title', 'summary', 'evidence_quote'],
        },
      },
      highlights: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            timestamp: { type: 'string' },
            label: { type: 'string' },
            reason: { type: 'string' },
            evidence_quote: { type: 'string' },
          },
          required: ['timestamp', 'label', 'reason', 'evidence_quote'],
        },
      },
      media_handoff_notes: { type: 'array', items: { type: 'string' } },
      coverage_notes: { type: 'string' },
    },
    required: ['chapters', 'highlights', 'media_handoff_notes'],
  },
  system_message: [
    'You are the Coaching Timeline Agent in Customer Success & Community.',
    'Build a chapter outline and highlight list from the timestamped transcript.',
    '- Use ONLY timestamps that literally appear in the transcript. Never interpolate or invent timestamps.',
    '- Each chapter and highlight needs a short evidence_quote copied from the transcript near that timestamp.',
    '- Align highlights with the coaching objectives when given.',
    '- media_handoff_notes are practical instructions for a video editor.',
  ].join('\n'),
  temperature: 0.2,

  validate: function () {
    const p = taskPayload();
    const transcript = textOf(directInput(p, ['transcript', 'timestamped_transcript', 'source_text']));
    const re = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;
    const seconds = new Set();
    let m;
    while ((m = re.exec(transcript)) !== null) {
      seconds.add(Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    }
    if (!transcript.trim()) return invalid(['A timestamped transcript is required (input_data.transcript or context.transcript).']);
    if (seconds.size < 2) return invalid(['The transcript must contain at least two timestamps (e.g. 00:01:23 or 12:45).']);
    const objectives = directInput(p, ['coaching_objectives', 'objectives']);
    const prompt = [
      taskBrief(p),
      `Video title: ${textOf(directInput(p, ['video_title', 'title'])) || 'unknown'}`,
      `Coaching objectives: ${objectives ? textOf(objectives) : 'not specified'}`,
      `## Timestamped transcript\n${clip(transcript, 80000)}`,
    ].join('\n\n');
    return valid({ prompt, valid_seconds: [...seconds] });
  },

  postprocess: function () {
    const out = $json.output;
    const allowed = new Set($('Validate Task Input').first().json.valid_seconds);
    const toSeconds = (ts) => {
      const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(String(ts || '').trim());
      return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
    };
    const supported = (ts) => { const s = toSeconds(ts); return s !== null && allowed.has(s); };
    if (!out || !Array.isArray(out.chapters)) return failed('invalid_ai_output', 'model returned no chapters array', true);

    const chapters = out.chapters
      .filter((c) => supported(c.start) && (!c.end || supported(c.end)))
      .sort((a, b) => toSeconds(a.start) - toSeconds(b.start));
    const highlights = (out.highlights || []).filter((h) => supported(h.timestamp));
    const removed = (out.chapters.length - chapters.length) + ((out.highlights || []).length - highlights.length);
    if (!chapters.length) return failed('unsupported_timestamps', 'no chapter used a timestamp present in the transcript', true);
    return done({ ...out, chapters, highlights, removed_unsupported_items: removed },
      removed ? [`removed ${removed} item(s) whose timestamps are not in the transcript`] : []);
  },
};
