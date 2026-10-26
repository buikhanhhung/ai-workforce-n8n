// Employee 3 — Marketing: turns content into a ready-to-post visual. The AI writes a card spec
// (headline, key points, highlight number, brand palette) using only the source content; the
// local renderer service draws it as a sketch-style PNG (exact Vietnamese text, no watermark).
// If rendering fails the brief is still returned with image_generated=false (never a fake URL).
const RENDERER_URL = 'http://renderer:3100/render';
const IMAGE_PROVIDER = 'local sketch-card renderer';

module.exports = {
  employee_id: 'emp_visual_design',
  employee_name: 'Visual Design Agent',
  department_id: 'dept_marketing',
  job_title: 'Visual Designer',
  description: 'Turns content into a sketch-style social image: picks the headline, key points and highlight number from the source, applies brand colors, and renders the PNG.',
  workflow_id: 'wfcEmpVisualDsg1',
  skills: [
    { skill_name: 'visual_concepting', description: 'Translate a message into a visual idea and composition' },
    { skill_name: 'content_distillation', description: 'Pick the headline, 2-4 key points and one highlight number from the content' },
    { skill_name: 'brand_compliance', description: 'Apply supplied brand colors and style rules' },
    { skill_name: 'image_rendering', description: 'Render a hand-drawn style card (PNG) with exact text' },
  ],
  input_schema: {
    type: 'object',
    'x-primary-input': 'concept',
    'x-input-hint': 'Dán nội dung bài viết hoặc ý chính cần làm ảnh…',
    description: 'Needs content to visualize (concept, post text or a prerequisite output). Returns a rendered sketch card plus the design brief.',
    properties: {
      concept: { type: 'string' },
      brand_guidelines: { type: ['object', 'string'] },
      dimensions: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } } },
      style: { type: 'string', description: 'e.g. sketch' },
      deliverable_type: { type: 'string', enum: ['social_image', 'infographic', 'thumbnail', 'banner'] },
    },
  },
  output_schema: {
    type: 'object',
    properties: {
      concept_title: { type: 'string' },
      visual_concept: { type: 'string' },
      card: {
        type: 'object',
        description: 'Content of the rendered image. All text in the language of the source.',
        properties: {
          tag: { type: 'string', description: 'Short topic label, max 40 characters' },
          headline: { type: 'string', description: 'Main message, max 70 characters' },
          subtitle: { type: 'string', description: 'One supporting sentence, max 110 characters' },
          points: {
            type: 'array',
            description: '3 key points (2-4 allowed), in reading order',
            items: { type: 'object', properties: { title: { type: 'string', description: 'max 28 characters' },
                                                   text: { type: 'string', description: 'max 95 characters' } },
                     required: ['title', 'text'] },
          },
          stat: { type: 'object', description: 'One striking number from the source, or omit',
                  properties: { value: { type: 'string', description: 'max 10 characters' }, label: { type: 'string', description: 'max 40 characters' } } },
          footer: { type: 'string', description: 'Source attribution, max 80 characters' },
          layout: { type: 'string', enum: ['flow', 'grid'], description: 'flow = steps in sequence (arrows), grid = independent points' },
          palette: { type: 'object', properties: { primary: { type: 'string' }, accent: { type: 'string' }, background: { type: 'string' }, ink: { type: 'string' } },
                     description: 'Hex colors (#RRGGBB) from the brand guidelines' },
        },
        required: ['headline', 'points', 'layout'],
      },
      design_brief: {
        type: 'object',
        properties: {
          objective: { type: 'string' },
          audience: { type: 'string' },
          key_message: { type: 'string' },
          composition: { type: 'string' },
          color_palette: { type: 'array', items: { type: 'string' } },
          brand_compliance_notes: { type: 'string' },
        },
        required: ['objective', 'key_message', 'composition', 'color_palette'],
      },
      image_generation_prompt: { type: 'string', description: 'Optional prompt for an external illustration tool' },
    },
    required: ['concept_title', 'visual_concept', 'card', 'design_brief'],
  },
  system_message: [
    'You are the Visual Design Agent in the Marketing department.',
    'You design a sketch-style social image (a hand-drawn card) that carries the core message of the supplied content.',
    '- card text must come ONLY from the supplied content: no invented facts, numbers or quotes.',
    '- headline: the single most important message. points: 3 key ideas in reading order (layout "flow" when they are steps).',
    '- stat: one striking number that appears in the content (e.g. "784", "6 -> 2"); omit it if there is none.',
    '- Respect the length limits in the schema; write in the language of the content. Do not number point titles (numbers are drawn).',
    '- footer: "Nguồn: " / "Source: " followed by the exact source title or channel as given in the content; omit it if unknown.',
    '- palette: use the brand colors if supplied (hex), otherwise navy #1B2A4A, orange #FF7A00, cream #F7F5F0, ink #2B2B2B.',
    '- Do not output image URLs; the image is rendered by a separate step.',
  ].join('\n'),
  temperature: 0.5,

  validate: function () {
    const p = taskPayload();
    const errors = [];
    const concept = directInput(p, ['concept', 'brief', 'message', 'source_text', 'content', 'post']);
    const deps = dependencyText(p, 20000);
    if (!concept && !deps) errors.push('Content to visualize is required (concept, post text or a prerequisite output).');
    const dims = directInput(p, ['dimensions']) || { width: 1200, height: 627 };
    const width = Number(dims.width);
    const height = Number(dims.height);
    if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 600 && width <= 2400 && height >= 400 && height <= 2400)) {
      errors.push('dimensions must be integers: width 600-2400, height 400-2400');
    }
    if (errors.length) return invalid(errors);
    const brand = directInput(p, ['brand_guidelines', 'brand']);
    const prompt = [
      taskBrief(p),
      `Image size: ${width}x${height}px, sketch style`,
      `Brand guidelines: ${brand ? clip(brand, 6000) : 'none supplied'}`,
      concept ? `## Content to visualize\n${clip(concept, 20000)}` : '',
      deps ? `## Prerequisite task outputs\n${deps}` : '',
    ].filter(Boolean).join('\n\n');
    return valid({ prompt, dimensions: { width, height }, has_brand_guidelines: !!brand });
  },

  // Brief ready -> local renderer draws the card into /data/assets -> attach /assets/<file>.
  finalize(wb, [x, y], from, helpers) {
    wb.ifTrue('Brief Ready?', "={{ $json.status === 'completed' }}", [x, y]);
    wb.code('Return Brief Failure', function () { return [{ json: $json }]; }, [x + 220, y + 140]);
    wb.code('Prepare Render Request', function () {
      const r = $json;
      const p = taskPayload();
      const file = `${p.task.plan_id}-${p.task.task_id}-${Date.now()}.png`.replace(/[^A-Za-z0-9._-]/g, '');
      const spec = { ...r.output.card, width: r.output.dimensions.width, height: r.output.dimensions.height,
                     seed: Math.floor(Math.random() * 100000) };
      return [{ json: { ...r, render_request: { spec, file_name: file } } }];
    }, [x + 220, y - 80], { helpers });
    wb.add('Render Card', 'n8n-nodes-base.httpRequest', 4.2, {
      method: 'POST',
      url: RENDERER_URL,
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.render_request) }}',
      options: { timeout: 60000 },
    }, [x + 440, y - 80], { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000, onError: 'continueErrorOutput' });
    wb.code('Attach Image', function () {
      const { render_request: req, ...result } = $('Prepare Render Request').first().json;
      if (!$json.ok) {
        return [{ json: { ...result, output: { ...result.output, image_generated: false, asset_urls: [],
          integration_note: `Image rendering failed (${String($json.error || 'unknown').slice(0, 300)}); the brief is still usable.` } } }];
      }
      return [{ json: { ...result, output: { ...result.output,
        image_generated: true,
        asset_urls: [`/assets/${$json.file}`],
        image_provider: IMAGE_PROVIDER,
        integration_note: `Sketch card rendered locally (${Math.round($json.bytes / 1024)} kB). All text comes from the card spec.`,
      } } }];
    }, [x + 660, y - 160], { helpers: [`const IMAGE_PROVIDER = '${IMAGE_PROVIDER}';`, ...helpers] });
    wb.code('Image Not Rendered', function () {
      const { render_request: req, ...result } = $('Prepare Render Request').first().json;
      const e = $json.error;
      const reason = typeof e === 'string' ? e : (e && (e.message || e.description || JSON.stringify(e))) || 'renderer unavailable';
      return [{ json: { ...result,
        output: { ...result.output, image_generated: false, asset_urls: [],
                  integration_note: `Image rendering failed (${String(reason).slice(0, 300)}); the brief is still usable.` },
        metadata: { ...result.metadata, warnings: [...((result.metadata && result.metadata.warnings) || []), 'image rendering failed'] } } }];
    }, [x + 660, y + 20], { helpers });
    wb.connect(from, 'Brief Ready?');
    wb.connect('Brief Ready?', 'Return Brief Failure', { output: 1 });
    wb.chain('Brief Ready?', 'Prepare Render Request', 'Render Card', 'Attach Image');
    wb.connect('Render Card', 'Image Not Rendered', { output: 1 });
  },

  postprocess: function () {
    const HEX = /^#[0-9a-fA-F]{6}$/;
    const out = $json.output;
    const v = $('Validate Task Input').first().json;
    if (!out || !out.card || !out.card.headline) return failed('invalid_ai_output', 'model returned no card headline', true);
    const points = (out.card.points || []).filter((p) => p && (p.title || p.text)).slice(0, 4);
    if (points.length < 2) return failed('invalid_ai_output', 'card needs at least 2 key points', true);
    const cut = (s, n) => { const t = String(s || '').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
    const palette = {};
    for (const k of ['primary', 'accent', 'background', 'ink']) {
      const c = out.card.palette && out.card.palette[k];
      if (HEX.test(c || '')) palette[k] = c;
    }
    const card = {
      tag: cut(out.card.tag, 40), headline: cut(out.card.headline, 90), subtitle: cut(out.card.subtitle, 130),
      // the renderer draws the numbers, so leading "1." / "2)" in titles would duplicate them
      points: points.map((p) => ({ title: cut(String(p.title || '').replace(/^\s*\d+\s*[.):-]\s*/, ''), 32), text: cut(p.text, 110) })),
      stat: out.card.stat && out.card.stat.value ? { value: cut(out.card.stat.value, 12), label: cut(out.card.stat.label, 48) } : null,
      footer: cut(out.card.footer, 90), layout: out.card.layout === 'grid' ? 'grid' : 'flow', palette,
    };
    const warnings = [];
    if (!v.has_brand_guidelines) warnings.push('no brand guidelines were supplied; default palette used');
    return done({
      ...out,
      card,
      dimensions: v.dimensions,
      // Set by the rendering step only when an image file really exists.
      image_generated: false,
      asset_urls: [],
      integration_note: 'Image not rendered yet.',
    }, warnings);
  },
};
