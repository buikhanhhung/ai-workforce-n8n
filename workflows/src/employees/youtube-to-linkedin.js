// Employee 1 — Marketing: turns a YouTube video or source text into a LinkedIn post.
// Given only a public YouTube URL, it gets the real spoken content by having Gemini watch the
// video (YouTube blocks direct caption downloads from servers). Supplied transcripts win.
const { GEMINI_MODEL, CREDENTIALS } = require('../../lib/ids');

module.exports = {
  employee_id: 'emp_yt_linkedin',
  employee_name: 'YouTube-to-LinkedIn Agent',
  department_id: 'dept_marketing',
  job_title: 'LinkedIn Content Writer',
  description: 'Watches a public YouTube video (or reads a supplied transcript/source text), extracts key ideas and writes an accurate, engaging LinkedIn post for the target audience.',
  workflow_id: 'wfcEmpYtLinkdIn1',
  execution_timeout: 600,
  skills: [
    { skill_name: 'youtube_transcription', description: 'Real transcript of a public YouTube video, via Gemini video understanding' },
    { skill_name: 'key_idea_extraction', description: 'Pull the main ideas and quotable facts out of a transcript or article' },
    { skill_name: 'linkedin_copywriting', description: 'Hook, short paragraphs, call to action, hashtags; max 3000 characters' },
    { skill_name: 'audience_adaptation', description: 'Adapt tone and structure to the stated audience' },
    { skill_name: 'source_attribution', description: 'Keep claims traceable to the source material' },
  ],
  input_schema: {
    type: 'object',
    'x-primary-input': 'source_text',
    'x-input-hint': 'Dán link YouTube, transcript hoặc nội dung nguồn…',
    description: 'Needs a public YouTube URL, a transcript or source text (task input, plan context, or prerequisite output).',
    properties: {
      youtube_url: { type: 'string', description: 'Public video; transcribed automatically when no transcript is supplied' },
      transcript: { type: 'string' },
      source_text: { type: 'string' },
      target_audience: { type: 'string' },
      tone: { type: 'string' },
      language: { type: 'string' },
    },
  },
  output_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      post: { type: 'string', description: 'LinkedIn post text, max 3000 characters' },
      summary: { type: 'string' },
      key_ideas: { type: 'array', items: { type: 'string' } },
      target_audience: { type: 'string' },
      tone: { type: 'string' },
      hashtags: { type: 'array', items: { type: 'string' } },
      factual_claims: {
        type: 'array',
        items: { type: 'object', properties: { claim: { type: 'string' }, supported_by: { type: 'string', description: 'Short quote from the source' } },
                 required: ['claim', 'supported_by'] },
      },
      source_references: {
        type: 'array',
        items: { type: 'object', properties: { type: { type: 'string' }, reference: { type: 'string' }, note: { type: 'string' } },
                 required: ['type', 'reference'] },
      },
    },
    required: ['title', 'post', 'summary', 'key_ideas', 'hashtags', 'factual_claims', 'source_references'],
  },
  system_message: [
    'You are the YouTube-to-LinkedIn Agent in the Marketing department.',
    'Write a LinkedIn post from the supplied source material only.',
    'Rules:',
    '- Preserve factual accuracy. Every factual claim must be supported by a short quote from the source (factual_claims).',
    '- Never invent statistics, names, dates or quotes that are not in the source.',
    '- Structure: strong first-line hook, short paragraphs, one clear takeaway, a call to action, 3-5 relevant hashtags.',
    '- The post must be at most 3000 characters, in plain text: LinkedIn does not render Markdown, so never use **, __, # or backticks (emoji and line breaks are fine).',
    '- Adapt tone and vocabulary to the target audience. Write in the requested language, otherwise in the language of the source.',
  ].join('\n'),
  temperature: 0.6,

  validate: function () {
    const YT = /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|live\/)|youtu\.be\/)[\w-]{6,}\S*$/;
    const p = taskPayload();
    const errors = [];
    let url = textOf(directInput(p, ['youtube_url', 'video_url', 'url'])).trim();
    let source = directInput(p, ['transcript', 'source_text', 'text', 'content', 'article']);
    // A bare link typed into the dashboard "Giao lại" box arrives as source_text.
    if (!url && typeof source === 'string' && YT.test(source.trim())) {
      url = source.trim();
      source = undefined;
    }
    if (url && !YT.test(url)) errors.push(`youtube_url is not a valid YouTube video URL: ${url.slice(0, 200)}`);
    // Gemini rejects video URLs carrying extra parameters (e.g. "&list=…&index=…" from a playlist) with
    // "Bad request": keep only the video id, in the canonical watch form.
    const id = url.match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/live\/)([\w-]{6,})/);
    if (id) url = `https://www.youtube.com/watch?v=${id[1]}`;
    const deps = dependencyText(p, 30000);
    if (!url && !source && !deps) {
      errors.push('A YouTube URL, a transcript or source text is required (context.youtube_url / transcript, or input_data.source_text).');
    }
    if (errors.length) return invalid(errors);
    return valid({
      youtube_url: url,
      needs_transcript: !!url && !source,
      source: clip(source, 60000),
      deps,
      audience: textOf(directInput(p, ['target_audience', 'audience'])) || 'professionals on LinkedIn',
      tone: textOf(directInput(p, ['tone'])) || 'insightful and practical',
      language: textOf(directInput(p, ['language'])),
    });
  },

  // oEmbed (no key) gives the real title/channel; if no transcript was supplied, Gemini watches
  // the public video and returns a timestamped transcript.
  prefetch(wb, [x, y]) {
    const meta = wb.add('Fetch YouTube Metadata', 'n8n-nodes-base.httpRequest', 4.2, {
      url: "={{ 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent($json.youtube_url || 'none') }}",
      options: { timeout: 10000 },
    }, [x, y], { onError: 'continueRegularOutput' });
    const needs = wb.ifTrue('Needs Transcript?', "={{ $('Validate Task Input').first().json.needs_transcript }}", [x + 220, y]);
    const transcribe = wb.add('Transcribe YouTube Video', 'n8n-nodes-base.httpRequest', 4.2, {
      method: 'POST',
      url: `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googlePalmApi',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={{ JSON.stringify({
        contents: [{ parts: [
          { file_data: { file_uri: $('Validate Task Input').first().json.youtube_url } },
          { text: 'Transcribe everything that is said in this video, in the original language, with [mm:ss] timestamps at the start of each paragraph. Output only the transcript. Do not summarize, translate or add anything that is not spoken.' }
        ] }],
        generationConfig: { maxOutputTokens: 32000, temperature: 0, mediaResolution: 'MEDIA_RESOLUTION_LOW' }
      }) }}`,
      options: { timeout: 300000 },
    }, [x + 440, y - 100], {
      credentials: { googlePalmApi: CREDENTIALS.gemini },
      retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueRegularOutput',
    });
    wb.connect(meta, needs);
    wb.connect(needs, transcribe);
    return { first: meta, lasts: [[transcribe, 0], [needs, 1]], width: 3 };
  },

  buildPrompt: function () {
    const v = $('Validate Task Input').first().json;
    const meta = $('Fetch YouTube Metadata').first().json;
    const video = v.youtube_url && meta && meta.title
      ? { title: meta.title, channel: meta.author_name, url: v.youtube_url } : null;
    let transcript = v.source;
    let transcriptSource = v.source ? 'supplied' : null;
    if (v.needs_transcript) {
      const r = $('Transcribe YouTube Video').first().json;
      const text = r && r.candidates && r.candidates[0] && r.candidates[0].content
        ? (r.candidates[0].content.parts || []).map((part) => part.text || '').join('').trim() : '';
      if (!text) {
        const reason = (r && r.error && (r.error.message || JSON.stringify(r.error))) || 'empty response';
        // Thrown so the task runner records a retryable failure instead of writing from nothing.
        throw new Error(`YouTube transcription failed: ${String(reason).slice(0, 400)}`);
      }
      transcript = text;
      transcriptSource = 'gemini_video_transcription';
    }
    const prompt = [
      taskBrief(taskPayload()),
      `Target audience: ${v.audience}`,
      `Tone: ${v.tone}`,
      v.language ? `Language: ${v.language}` : '',
      video ? `Video: "${video.title}" by ${video.channel} (${video.url})` : (v.youtube_url ? `Video URL: ${v.youtube_url}` : ''),
      transcript ? `## ${transcriptSource === 'supplied' ? 'Source material' : 'Video transcript'}\n${clip(transcript, 60000)}` : '',
      v.deps ? `## Prerequisite task outputs\n${v.deps}` : '',
    ].filter(Boolean).join('\n\n');
    return [{ json: { prompt, video, transcript_source: transcriptSource, transcript: transcript ? clip(transcript, 20000) : '' } }];
  },

  postprocess: function () {
    const out = $json.output;
    const { video, transcript_source, transcript } = $('Build Prompt').first().json;
    const v = $('Validate Task Input').first().json;
    const warnings = [];
    if (!out || typeof out.post !== 'string' || !out.post.trim()) return failed('invalid_ai_output', 'model returned no post text', true);
    // LinkedIn shows plain text; remove any Markdown the model still produced.
    out.post = out.post.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1')
      .replace(/^#{1,6}[ \t]+/gm, '').replace(/^[ \t]*\*[ \t]+/gm, '• ');
    if (out.post.length > 3000) return failed('post_too_long', `post has ${out.post.length} characters (LinkedIn max 3000)`, true);
    const refs = Array.isArray(out.source_references) ? out.source_references : [];
    if (v.youtube_url && !refs.some((r) => String(r.reference).includes(v.youtube_url))) {
      refs.unshift({ type: 'youtube_video', reference: v.youtube_url, note: video ? video.title : 'title lookup unavailable' });
    }
    if (!(out.factual_claims || []).length) warnings.push('no factual claims were listed; verify the post manually');
    if (transcript_source === 'gemini_video_transcription') warnings.push('transcript was produced by Gemini from the video, not official captions');
    return done({
      ...out, source_references: refs, video_metadata: video, character_count: out.post.length, status: 'draft',
      transcript_source, source_transcript: transcript_source === 'gemini_video_transcription' ? transcript : undefined,
    }, warnings);
  },
};
