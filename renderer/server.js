// Internal render service (Docker network only): POST /render { spec, file_name } -> writes a PNG
// into ASSETS_DIR and returns { ok, file, bytes }. Used by the Visual Design employee workflow.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const { buildSvg, FONT_FILES } = require('./card');

const PORT = Number(process.env.PORT || 3100);
const ASSETS_DIR = path.resolve(process.env.ASSETS_DIR || '/data/assets');

const reply = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/render') return reply(res, 404, { ok: false, error: 'not found' });
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200000) return reply(res, 413, { ok: false, error: 'request too large' });
  }
  try {
    const { spec, file_name: fileName } = JSON.parse(raw || '{}');
    if (!/^[A-Za-z0-9._-]{1,120}\.png$/.test(fileName || '')) return reply(res, 400, { ok: false, error: 'file_name must be a simple *.png name' });
    const svg = buildSvg(spec);
    const png = new Resvg(svg, {
      font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Be Vietnam Pro' },
      fitTo: { mode: 'original' },
    }).render().asPng();
    fs.writeFileSync(path.join(ASSETS_DIR, fileName), png);
    reply(res, 200, { ok: true, file: fileName, bytes: png.length });
  } catch (e) {
    reply(res, e.status || 500, { ok: false, error: e.message });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`renderer on :${PORT}, assets -> ${ASSETS_DIR}`));
