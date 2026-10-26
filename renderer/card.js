// Sketch-style social card: SVG built from a content spec (all text comes from the spec, so the
// image always matches the post). Text is measured with the real fonts and wrapped, never clipped.
const path = require('path');
const opentype = require('opentype.js');
const rough = require('roughjs/bundled/rough.cjs.js');

const FONT_DIR = path.join(__dirname, 'fonts');
const FONTS = {
  hand: { family: 'Patrick Hand', file: 'PatrickHand-Regular.ttf' },
  body: { family: 'Be Vietnam Pro', file: 'BeVietnamPro-Regular.ttf' },
  bold: { family: 'Be Vietnam Pro', file: 'BeVietnamPro-Bold.ttf', weight: 700 },
};
for (const f of Object.values(FONTS)) f.font = opentype.loadSync(path.join(FONT_DIR, f.file));
const FONT_FILES = [...new Set(Object.values(FONTS).map((f) => path.join(FONT_DIR, f.file)))];

const DEFAULT_PALETTE = { primary: '#1B2A4A', accent: '#FF7A00', background: '#F7F5F0', ink: '#2B2B2B' };
const HEX = /^#[0-9a-fA-F]{6}$/;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
// The hand font lacks some symbols (e.g. arrows): such text falls back to the bold sans font.
const covers = (fontKey, text) => [...String(text)].every((ch) => !ch.trim() || FONTS[fontKey].font.charToGlyphIndex(ch) !== 0);
const pick = (fontKey, text) => (fontKey === 'hand' && !covers('hand', text) ? 'bold' : fontKey);
const width = (fontKey, text, size) => FONTS[pick(fontKey, text)].font.getAdvanceWidth(text, size);
// Neither font has arrows or emoji: map arrows to ASCII and drop anything no font can draw,
// so a card never shows empty glyph boxes.
function clean(text) {
  const s = String(text ?? '').replace(/[→⇒➜➔⟶]/g, '->').replace(/[←⇐⟵]/g, '<-').replace(/[•●▪]/g, '·');
  return [...s].filter((ch) => !ch.trim() || covers('body', ch) || covers('hand', ch)).join('').replace(/\s+/g, ' ').trim();
}

// Greedy word wrap with real glyph metrics; the last allowed line gets an ellipsis if needed.
function wrap(fontKey, text, size, maxWidth, maxLines) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (width(fontKey, candidate, size) <= maxWidth || !line) line = candidate;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return { lines, overflow: false };
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 1 && width(fontKey, `${last}…`, size) > maxWidth) last = last.slice(0, -1).trimEnd();
  kept[maxLines - 1] = `${last}…`;
  return { lines: kept, overflow: true };
}

// Largest size (down to min) at which text fits in maxLines.
function fit(fontKey, text, maxSize, minSize, maxWidth, maxLines) {
  for (let size = maxSize; size >= minSize; size -= 2) {
    const r = wrap(fontKey, text, size, maxWidth, maxLines);
    if (!r.overflow) return { size, lines: r.lines };
  }
  return { size: minSize, lines: wrap(fontKey, text, minSize, maxWidth, maxLines).lines };
}

function textBlock(fontKey, lines, x, y, size, color, lineHeight = 1.18, anchor = 'start') {
  const f = FONTS[pick(fontKey, lines.join(' '))];
  return lines.map((l, i) => `<text x="${x.toFixed(1)}" y="${(y + i * size * lineHeight).toFixed(1)}" font-family="${f.family}"`
    + `${f.weight ? ` font-weight="${f.weight}"` : ''} font-size="${size}" fill="${color}" text-anchor="${anchor}">${esc(l)}</text>`).join('');
}

function validateSpec(spec) {
  const errors = [];
  const s = spec || {};
  if (typeof s.headline !== 'string' || !s.headline.trim()) errors.push('headline is required');
  const points = Array.isArray(s.points) ? s.points.filter((p) => p && (p.title || p.text)) : [];
  if (points.length < 2 || points.length > 4) errors.push('points must contain 2-4 items');
  const w = Number(s.width || 1200);
  const h = Number(s.height || 627);
  if (!(w >= 600 && w <= 2400 && h >= 400 && h <= 2400)) errors.push('width/height out of range');
  return { errors, points, w, h };
}

function buildSvg(rawSpec) {
  const r = rawSpec || {};
  const spec = {
    ...r,
    tag: r.tag && clean(r.tag), headline: clean(r.headline), subtitle: r.subtitle && clean(r.subtitle), footer: r.footer && clean(r.footer),
    stat: r.stat && r.stat.value ? { value: clean(r.stat.value), label: r.stat.label && clean(r.stat.label) } : null,
    points: Array.isArray(r.points) ? r.points.map((p) => ({ title: clean(p && p.title), text: clean(p && p.text) })) : [],
  };
  const { errors, points, w, h } = validateSpec(spec);
  if (errors.length) { const e = new Error(errors.join('; ')); e.status = 400; throw e; }
  const pal = { ...DEFAULT_PALETTE };
  for (const k of Object.keys(DEFAULT_PALETTE)) if (spec.palette && HEX.test(spec.palette[k] || '')) pal[k] = spec.palette[k];
  const seed = Number.isInteger(spec.seed) ? spec.seed : 7;
  const gen = rough.generator();
  const k = w / 1200;                       // scale everything from a 1200px design
  const pad = 60 * k;
  const parts = [];
  const sketch = (drawable) => gen.toPaths(drawable).map((p) =>
    `<path d="${p.d}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" fill="${p.fill || 'none'}" stroke-linecap="round"/>`).join('');
  const opts = (extra) => ({ seed, roughness: 1.4, bowing: 1.2, stroke: pal.primary, strokeWidth: 2.2 * k, ...extra });

  parts.push(`<rect width="${w}" height="${h}" fill="${pal.background}"/>`);
  parts.push(sketch(gen.rectangle(22 * k, 22 * k, w - 44 * k, h - 44 * k, opts({ strokeWidth: 2.6 * k, roughness: 1.8 }))));

  // Optional highlight number, circled, top right.
  const statW = spec.stat && spec.stat.value ? 250 * k : 0;
  if (statW) {
    const cx = w - pad - statW / 2;
    const cy = 150 * k;
    parts.push(sketch(gen.ellipse(cx, cy, statW, 170 * k, opts({ stroke: pal.accent, strokeWidth: 3 * k }))));
    const v = fit('hand', String(spec.stat.value), 64 * k, 34 * k, statW - 40 * k, 1);
    parts.push(textBlock('hand', v.lines, cx, cy + v.size * 0.2, v.size, pal.accent, 1.1, 'middle'));
    if (spec.stat.label) {
      const lb = wrap('body', spec.stat.label, 16 * k, statW - 30 * k, 2);
      parts.push(textBlock('body', lb.lines, cx, cy + 46 * k, 16 * k, pal.ink, 1.2, 'middle'));
    }
  }

  // Tag, headline with a hand-drawn underline, subtitle.
  let y = 78 * k;
  if (spec.tag) {
    parts.push(textBlock('hand', [String(spec.tag).toUpperCase().slice(0, 60)], pad, y, 24 * k, pal.accent));
    y += 22 * k;
  }
  const textW = w - 2 * pad - statW - (statW ? 30 * k : 0);
  const head = fit('hand', spec.headline, 62 * k, 38 * k, textW, 2);
  y += head.size;
  parts.push(textBlock('hand', head.lines, pad, y, head.size, pal.primary, 1.08));
  y += (head.lines.length - 1) * head.size * 1.08 + 18 * k;
  const ulW = Math.min(textW, Math.max(...head.lines.map((l) => width('hand', l, head.size))));
  parts.push(sketch(gen.line(pad, y, pad + ulW, y + 4 * k, opts({ stroke: pal.accent, strokeWidth: 4 * k }))));
  y += 18 * k;
  if (spec.subtitle) {
    const sub = wrap('body', spec.subtitle, 22 * k, textW, 2);
    y += 22 * k;
    parts.push(textBlock('body', sub.lines, pad, y, 22 * k, pal.ink, 1.3));
    y += (sub.lines.length - 1) * 22 * k * 1.3;
  }

  // Key points as sketched boxes, joined by arrows when they form a flow. Boxes are sized to
  // their content (up to the space left) and the row is centred in that space.
  const footerH = spec.footer ? 44 * k : 20 * k;
  const areaTop = Math.max(y + 30 * k, h * 0.4);
  const areaH = h - areaTop - pad / 2 - footerH;
  const flow = spec.layout !== 'grid';
  const gap = (flow ? 54 : 28) * k;
  const boxW = (w - 2 * pad - gap * (points.length - 1)) / points.length;
  const inner = boxW - 32 * k;
  const bodySize = 19 * k;
  const bodyLH = bodySize * 1.38;
  const headBand = 64 * k;                                   // number circle + title row
  const laid = points.map((p) => {
    const tt = fit('hand', p.title || '', 30 * k, 22 * k, inner - 52 * k, 2);
    const titleExtra = (tt.lines.length - 1) * tt.size * 1.05;
    const maxLines = Math.max(1, Math.floor((areaH - headBand - titleExtra - 28 * k) / bodyLH));
    return { tt, titleExtra, body: wrap('body', p.text || '', bodySize, inner, Math.min(maxLines, 5)) };
  });
  const boxH = Math.min(areaH, Math.max(...laid.map((l) => headBand + l.titleExtra + 18 * k + l.body.lines.length * bodyLH + 12 * k)));
  const top = areaTop + (areaH - boxH) / 2;
  points.forEach((p, i) => {
    const x = pad + i * (boxW + gap);
    const { tt, titleExtra, body } = laid[i];
    parts.push(sketch(gen.rectangle(x, top, boxW, boxH, opts({ fill: '#FFFFFF', fillStyle: 'solid' }))));
    parts.push(sketch(gen.circle(x + 34 * k, top + 34 * k, 46 * k, opts({ stroke: pal.accent, fill: pal.accent, fillStyle: 'hachure', hachureGap: 5 * k }))));
    parts.push(textBlock('hand', [String(i + 1)], x + 34 * k, top + 44 * k, 30 * k, pal.primary, 1, 'middle'));
    parts.push(textBlock('hand', tt.lines, x + 66 * k, top + 44 * k, tt.size, pal.primary, 1.05));
    const tY = top + headBand + titleExtra + 18 * k;
    parts.push(textBlock('body', body.lines, x + 16 * k, tY, bodySize, pal.ink, 1.38));
    if (flow && i < points.length - 1) {
      const ax = x + boxW + 8 * k;
      const ay = top + boxH / 2;
      const bx = ax + gap - 16 * k;
      parts.push(sketch(gen.line(ax, ay, bx, ay, opts({ strokeWidth: 2.6 * k }))));
      parts.push(sketch(gen.line(bx, ay, bx - 12 * k, ay - 9 * k, opts({ strokeWidth: 2.6 * k }))));
      parts.push(sketch(gen.line(bx, ay, bx - 12 * k, ay + 9 * k, opts({ strokeWidth: 2.6 * k }))));
    }
  });

  if (spec.footer) {
    parts.push(textBlock('body', [wrap('body', spec.footer, 15 * k, w - 2 * pad - 160 * k, 1).lines[0]], pad, h - 38 * k, 15 * k, pal.ink));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`;
}

module.exports = { buildSvg, FONT_FILES };
