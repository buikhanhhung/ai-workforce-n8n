// "Kết nối & tài khoản" page (#settings): enter and test the external accounts the agents use.
// Secrets typed here are posted once to /api/integrations/save, which writes them straight into
// n8n's encrypted credentials; the API never returns them, so secret fields always start empty.
// Uses helpers defined in app.js: $, api, esc, rel, approver, state.
'use strict';

(() => {
  const N8N = 'http://localhost:5678';
  const REDIRECT = `${N8N}/rest/oauth2-credential/callback`;
  const KINDS = { postgres: 'PostgreSQL', mysql: 'MySQL', mssql: 'SQL Server', http: 'HTTP API' };
  const DEFAULT_PORT = { postgres: '5432', mysql: '3306', mssql: '1433' };
  const page = { data: null, kind: null, msg: {} };

  const status = (s) => {
    if (s.last_test && s.last_test.ok) return `<span class="set-status ok">✓ Đã kết nối</span>`;
    if (s.last_test) return `<span class="set-status err">✗ Kiểm tra thất bại</span>`;
    if (s.secret_saved_at) return `<span class="set-status wait">● Đã lưu, chưa kiểm tra</span>`;
    return `<span class="set-status">○ Chưa cấu hình</span>`;
  };
  const lastTest = (s) => (s.last_test ? `<div class="set-result ${s.last_test.ok ? 'ok' : 'err'}">
      ${s.last_test.ok ? '✓' : '✗'} ${esc(s.last_test.message)} <small>· kiểm tra ${rel(s.last_test.at)}</small></div>` : '');
  const saved = (s) => (s.secret_saved_at ? `<small class="cv-muted">Bí mật lưu lần cuối ${rel(s.secret_saved_at)}${s.updated_by ? ` bởi ${esc(s.updated_by)}` : ''}</small>` : '');
  const field = (label, name, value, { type = 'text', secret = false, ph = '', hint = '' } = {}) => `
    <label class="set-field"><span>${esc(label)}</span>
      <input type="${type}" ${secret ? `data-secret="${name}" autocomplete="new-password"` : `data-field="${name}" autocomplete="off"`}
        value="${secret ? '' : esc(value || '')}" placeholder="${esc(ph)}" spellcheck="false">
      ${hint ? `<small>${hint}</small>` : ''}</label>`;
  const msg = (svc) => (page.msg[svc] ? `<div class="set-result ${page.msg[svc].ok ? 'ok' : 'err'}">${esc(page.msg[svc].text)}</div>` : '');
  const buttons = (svc, extra = '') => `<div class="actions">
      <button type="submit" class="btn gold small" data-set-save="${svc}">💾 Lưu</button>${extra}
      <button type="button" class="btn small" data-set-test="${svc}">🔌 Kiểm tra kết nối</button></div>`;
  const copy = (text) => `<span class="set-copy"><code>${esc(text)}</code><button type="button" class="btn small" data-set-copy="${esc(text)}">⧉</button></span>`;

  function adminCard(a) {
    return `<article class="panel set-card ${a.configured ? '' : 'todo'}">
      <header><h3>🔑 Quyền quản trị n8n</h3>${a.configured ? '<span class="set-status ok">✓ Đã có</span>' : '<span class="set-status err">Cần làm trước</span>'}</header>
      <p class="set-why">Để app ghi tài khoản vào kho credential (đã mã hoá) của n8n, dashboard cần một n8n API key. Làm một lần.</p>
      ${a.from_env ? '<p class="cv-muted">Đang dùng key từ biến môi trường N8N_API_KEY.</p>' : `
      <ol class="set-steps">
        <li>Mở <a href="${N8N}/settings/api" target="_blank" rel="noopener">n8n → Settings → n8n API ↗</a> (đăng nhập n8n nếu được hỏi).</li>
        <li>Bấm <b>Create an API key</b>, đặt tên <code>Workforce dashboard</code>, Expiration chọn <b>No expiration</b>, rồi copy key.</li>
        <li>Dán vào ô dưới và bấm Lưu. Key được giữ phía server, không hiện lại ở đây.</li>
      </ol>
      <form class="set-form" data-set-form="n8n">
        ${field('n8n API key', 'api_key', '', { type: 'password', secret: true, ph: a.configured ? 'đã lưu, dán key mới để thay' : 'eyJhbGciOi…' })}
        <div class="actions"><button type="submit" class="btn gold small">💾 Lưu</button></div>${msg('n8n')}
      </form>`}
    </article>`;
  }

  function linkedinCard(s) {
    const c = s.config || {};
    return `<article class="panel set-card">
      <header><h3>🔗 LinkedIn</h3>${status(s)}</header>
      <p class="set-why">Dùng để đăng bài đã duyệt lên trang LinkedIn cá nhân (nút "Đăng lên LinkedIn" trong kế hoạch).</p>
      <ol class="set-steps">
        <li>Tạo app ở <a href="https://www.linkedin.com/developers/apps/new" target="_blank" rel="noopener">LinkedIn Developers ↗</a>. App bắt buộc gắn với một LinkedIn Page, nếu chưa có thì tạo một trang.</li>
        <li>Tab <b>Products</b>: thêm <b>Share on LinkedIn</b> và <b>Sign In with LinkedIn using OpenID Connect</b>.</li>
        <li>Tab <b>Auth</b> → Authorized redirect URLs: thêm ${copy(REDIRECT)}</li>
        <li>Copy <b>Client ID</b> và <b>Primary Client Secret</b> vào đây, bấm Lưu.</li>
        <li>Bấm <b>Mở n8n để Connect</b> → nút <b>Connect my account</b> → đăng nhập LinkedIn và đồng ý. Sau đó quay lại bấm Kiểm tra.</li>
      </ol>
      <form class="set-form" data-set-form="linkedin">
        <div class="set-grid">
          ${field('Client ID', 'client_id', '', { ph: c.client_id_hint ? `đã lưu: ${c.client_id_hint}, nhập lại để thay` : '86xxxxxxxxxxxx' })}
          ${field('Client Secret', 'client_secret', '', { type: 'password', secret: true, ph: s.secret_saved_at ? 'đã lưu, để trống nếu giữ nguyên' : '' })}
        </div>
        ${buttons('linkedin', `<a class="btn small" href="${N8N}/home/credentials/wfLinkedInCred01" target="_blank" rel="noopener">↗ Mở n8n để Connect</a>`)}
        ${saved(s)}${msg('linkedin')}${lastTest(s)}
        <small class="cv-muted">Token LinkedIn hết hạn sau 60 ngày, khi đó cần bấm Connect lại.</small>
      </form>
    </article>`;
  }

  function circleCard(s) {
    const c = s.config || {};
    return `<article class="panel set-card">
      <header><h3>👋 Circle</h3>${status(s)}</header>
      <p class="set-why">Để Circle Community Checker tự đọc thread cộng đồng thay vì chờ bạn dán dữ liệu.</p>
      <ol class="set-steps">
        <li>Trong Circle (tài khoản admin): <b>Settings → Developers → Tokens</b>. Nếu không thấy mục này thì gói Circle hiện tại chưa có API.</li>
        <li>Tạo token loại <b>Admin V2</b>, copy token vào đây, bấm Lưu, rồi Kiểm tra.</li>
      </ol>
      <form class="set-form" data-set-form="circle">
        <div class="set-grid">
          ${field('Địa chỉ community (không bắt buộc)', 'community_url', c.community_url, { ph: 'https://community.tencongty.com' })}
          ${field('Admin API token', 'api_token', '', { type: 'password', secret: true, ph: s.secret_saved_at ? 'đã lưu, để trống nếu giữ nguyên' : '' })}
        </div>
        ${buttons('circle')}${saved(s)}${msg('circle')}${lastTest(s)}
        <small class="cv-muted">Sau khi kiểm tra thành công mới nối agent vào dữ liệu thật. Hiện agent vẫn dùng dữ liệu được dán vào.</small>
      </form>
    </article>`;
  }

  function wecommitCard(s) {
    const c = s.config || {};
    const kind = page.kind || c.kind || 'postgres';
    const db = kind !== 'http';
    return `<article class="panel set-card">
      <header><h3>🩺 WeCommitDW</h3>${status(s)}</header>
      <p class="set-why">Để WeCommitDW System Checker tự kiểm tra hệ thống thay vì chờ bạn dán log.</p>
      <ul class="set-steps">
        <li><b>Nên dùng tài khoản chỉ đọc</b> (chỉ SELECT, hoặc token chỉ đọc). Agent không cần quyền ghi.</li>
        <li>Host phải tới được từ container n8n: <code>localhost</code> là chính container. Nếu database chạy trên máy này thì dùng <code>host.docker.internal</code>.</li>
      </ul>
      <form class="set-form" data-set-form="wecommitdw">
        <label class="set-field"><span>Loại kết nối</span>
          <select data-field="kind" data-set-kind>${Object.entries(KINDS).map(([k, l]) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${db ? `<div class="set-grid">
            ${field('Host', 'host', c.kind === kind ? c.host : '', { ph: 'db.wecommit.local' })}
            ${field('Port', 'port', c.kind === kind ? c.port : DEFAULT_PORT[kind], { ph: DEFAULT_PORT[kind] })}
            ${field('Database', 'database', c.kind === kind ? c.database : '')}
            ${field('User (chỉ đọc)', 'user', c.kind === kind ? c.user : '')}
            ${field('Mật khẩu', 'password', '', { type: 'password', secret: true, ph: s.secret_saved_at && c.kind === kind ? 'đã lưu, để trống nếu giữ nguyên' : '' })}
            <label class="set-field set-check"><input type="checkbox" data-field="ssl" ${c.kind === kind && c.ssl === 'true' ? 'checked' : ''}><span>Dùng SSL/TLS</span></label>
          </div>` : `<div class="set-grid">
            ${field('Base URL', 'base_url', c.kind === 'http' ? c.base_url : '', { ph: 'https://monitor.wecommit.vn/api' })}
            ${field('Đường dẫn kiểm tra (không bắt buộc)', 'health_path', c.kind === 'http' ? c.health_path : '', { ph: 'health' })}
            ${field('API token (Bearer)', 'api_token', '', { type: 'password', secret: true, ph: s.secret_saved_at && c.kind === 'http' ? 'đã lưu, để trống nếu giữ nguyên' : '' })}
          </div>`}
        ${buttons('wecommitdw')}${saved(s)}${msg('wecommitdw')}${lastTest(s)}
        <small class="cv-muted">Kiểm tra chỉ chạy một câu SELECT (tên database, user, phiên bản) hoặc một lệnh GET.</small>
      </form>
    </article>`;
  }

  function render() {
    const d = page.data;
    const host = $('#settings');
    if (!d) { host.innerHTML = '<div class="panel empty">Đang tải…</div>'; return; }
    const by = Object.fromEntries(d.services.map((s) => [s.service, s]));
    host.innerHTML = `<div class="set-intro panel">
        <b>Bí mật bạn nhập ở đây (secret, token, mật khẩu) được ghi thẳng vào kho credential đã mã hoá của n8n.</b>
        App không lưu chúng ở chỗ khác và không bao giờ hiển thị lại. Để trống ô bí mật nghĩa là giữ giá trị đã lưu.
      </div>
      ${adminCard(d.n8n_admin)}${linkedinCard(by.linkedin)}${circleCard(by.circle)}${wecommitCard(by.wecommitdw)}`;
    const todo = (d.n8n_admin.configured ? 0 : 1) + d.services.filter((s) => !(s.last_test && s.last_test.ok)).length;
    $('#settings-todo').textContent = todo ? String(todo) : '';
  }

  async function load() {
    try {
      page.data = await api('GET', 'integrations');
    } catch (e) {
      $('#settings').innerHTML = `<div class="panel state err">Không tải được: ${esc(e.message)}</div>`;
      return;
    }
    if (state.view === 'settings') render();
    else {
      const d = page.data;
      const todo = (d.n8n_admin.configured ? 0 : 1) + d.services.filter((s) => !(s.last_test && s.last_test.ok)).length;
      $('#settings-todo').textContent = todo ? String(todo) : '';
    }
  }

  function collect(form) {
    const config = {};
    const secrets = {};
    form.querySelectorAll('[data-field]').forEach((el) => { config[el.dataset.field] = el.type === 'checkbox' ? String(el.checked) : el.value; });
    form.querySelectorAll('[data-secret]').forEach((el) => { if (el.value.trim()) secrets[el.dataset.secret] = el.value; });
    return { config, secrets };
  }

  async function busy(btn, fn) {
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '⏳ Đang xử lý…';
    try { await fn(); } finally { btn.disabled = false; btn.innerHTML = label; }
  }

  $('#settings').addEventListener('submit', (ev) => {
    const form = ev.target.closest('[data-set-form]');
    if (!form) return;
    ev.preventDefault();
    const svc = form.dataset.setForm;
    const btn = form.querySelector('button[type=submit]');
    const { config, secrets } = collect(form);
    busy(btn, async () => {
      try {
        if (svc === 'n8n') {
          if (!secrets.api_key) throw new Error('Hãy dán n8n API key');
          await api('POST', 'integrations/n8n-key', { api_key: secrets.api_key });
          page.msg.n8n = { ok: true, text: '✓ Đã lưu n8n API key.' };
        } else {
          await api('POST', 'integrations/save', { service: svc, config, secrets, updated_by: approver() });
          page.msg[svc] = { ok: true, text: Object.keys(secrets).length ? '✓ Đã lưu vào n8n. Bấm "Kiểm tra kết nối" để thử.' : '✓ Đã lưu cấu hình.' };
        }
      } catch (e) {
        page.msg[svc] = { ok: false, text: `✗ ${e.message}` };
      }
      page.kind = null;
      await load();
    });
  });

  $('#settings').addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-set-test],[data-set-copy]');
    if (!t) return;
    if (t.dataset.setCopy) {
      navigator.clipboard.writeText(t.dataset.setCopy).then(() => { t.textContent = '✓'; }, () => { t.textContent = '✗'; });
      return;
    }
    const svc = t.dataset.setTest;
    busy(t, async () => {
      try {
        const r = await api('POST', 'integrations/test', { service: svc });
        page.msg[svc] = null;
        if (!r.ok) page.msg[svc] = { ok: false, text: `✗ ${r.message}` };
      } catch (e) {
        page.msg[svc] = { ok: false, text: `✗ ${e.message}` };
      }
      await load();
    });
  });

  // Switching the WeCommitDW connection kind re-renders the fields of that kind.
  $('#settings').addEventListener('change', (ev) => {
    if (!ev.target.matches('[data-set-kind]')) return;
    page.kind = ev.target.value;
    render();
  });

  window.Settings = { load };
  load();
})();
