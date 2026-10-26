// AI Workforce dashboard. Talks only to /api/* (dashboard/server.js proxies to n8n).
// Polls every few seconds; employee cards are built once and only their state area is
// re-rendered, so text typed in the "Giao lại" boxes is never lost.
'use strict';

const POLL_MS = 4000;
const DEPTS = {
  dept_marketing: { label: 'Marketing', sub: 'Nội dung & thương hiệu', icon: '📣', order: 1 },
  dept_operations: { label: 'Vận hành', sub: 'Hệ thống & hiệu suất', icon: '⚙️', order: 2 },
  dept_customer_success: { label: 'CSKH & Cộng đồng', sub: 'Học viên & cộng đồng', icon: '💬', order: 3 },
};
const ICONS = {
  emp_yt_linkedin: '📝', emp_repurpose_studio: '🎬', emp_visual_design: '🎨', emp_wecommitdw_checker: '🩺',
  emp_skill_recommender: '🧭', emp_circle_checker: '👋', emp_coaching_timeline: '✂️', emp_knowledge_support: '📚',
};
// Context keys the employees understand (see each employee's input_schema).
const ATTACH_TYPES = [
  ['youtube_url', 'Link YouTube'], ['transcript', 'Transcript video'], ['source_text', 'Nội dung nguồn'], ['brand_guidelines', 'Brand guidelines'],
  ['system_data', 'Dữ liệu hệ thống / log'], ['community_data', 'Thảo luận cộng đồng'],
  ['question', 'Câu hỏi hỗ trợ'], ['target_audience', 'Đối tượng mục tiêu'],
];
const STATUS_VI = {
  pending: 'chờ', ready: 'sẵn sàng', running: 'đang làm', completed: 'xong', failed: 'lỗi', blocked: 'bị chặn',
  cancelled: 'đã huỷ', awaiting_approval: 'chờ duyệt', reviewing: 'CEO đang review', rejected: 'bị từ chối',
  planning: 'CEO đang lập kế hoạch',
};
const STEP_ICON = { running: '⟳', completed: '✓', failed: '✗', blocked: '⛔', awaiting_approval: '✋', cancelled: '⊘' };

const APPROVAL_VI = { awaiting: '✋ Chờ duyệt', approved: '✓ Đã duyệt', in_progress: '⟳ Đang xử lý', rejected: '✗ Bị từ chối', cancelled: '⊘ Đã huỷ' };
const APPROVAL_PILL = { awaiting: 'awaiting_approval', approved: 'approved', in_progress: 'running', rejected: 'rejected', cancelled: 'cancelled' };
const LIB_VI = { active: 'Đang dùng được', new: 'Mới', used: 'Đã dùng', archived: 'Lưu trữ', all: 'Tất cả' };
const LIB_PAGE = 30;

const state = { employees: {}, built: false, refreshing: false, dismissed: loadSet('wf.dismissed'),
                submitting: false, watchPlan: undefined, planningBannerFor: null, scope: 'ceo', view: 'ops', departments: [],
                lib: { status: 'active', employee: '', approval: '', q: '', items: [], total: 0, counts: {}, seenAll: null, loading: false },
                modal: null };

// Hash = "#<scope>" or "#<scope>/library". Scope: 'ceo' (whole company) or a department_id (that
// department's manager). View: 'ops' (assign and follow work) or 'library' (everything produced).
// "#settings" is the company-wide integrations page (settings.js).
function parseHash() {
  if (location.hash === '#settings') return { scope: 'ceo', view: 'settings' };
  const m = /^#(ceo|dept_[a-z0-9_]+)(\/library)?$/.exec(location.hash);
  return { scope: m ? m[1] : 'ceo', view: m && m[2] ? 'library' : 'ops' };
}
const hashFor = (scope, view) => `#${scope}${view === 'library' ? '/library' : ''}`;
const deptScope = () => (state.scope === 'ceo' ? null : state.scope);
const scopeQS = (prefix = '&') => (deptScope() ? `${prefix}department_id=${encodeURIComponent(deptScope())}` : '');
const watchKey = () => `wf.watchPlan.${state.scope}`;
const $ = (sel, root = document) => root.querySelector(sel);
// Re-render only when content changed: replacing nodes under the pointer swallows clicks.
function setHTML(el, html) {
  if (el.__html !== html) { el.innerHTML = html; el.__html = html; }
}

// ───────── helpers ─────────
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function loadSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
}
function saveSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set].slice(-500))); } catch { /* storage unavailable */ }
}
const rtf = new Intl.RelativeTimeFormat('vi', { numeric: 'auto' });
function rel(ts) {
  if (!ts) return '';
  const s = (new Date(ts) - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, n] of units) if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), u);
  return 'vừa xong';
}
function elapsed(ts) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(ts)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function approver() {
  let name = '';
  try { name = localStorage.getItem('wf.approver') || ''; } catch { /* ignore */ }
  if (!name) {
    name = (window.prompt('Tên của bạn (ghi vào lịch sử thao tác):', '') || '').trim() || 'dashboard-user';
    try { localStorage.setItem('wf.approver', name); } catch { /* ignore */ }
  }
  return name;
}
async function api(method, path, body) {
  const res = await fetch(`/api/${path}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { json = { ok: false, error: { message: `Phản hồi không hợp lệ (HTTP ${res.status})` } }; }
  if (!json.ok) {
    const err = new Error((json.error && json.error.message) || json.message || `HTTP ${res.status}`);
    err.details = json.error && json.error.details;
    throw err;
  }
  return json.data;
}
const empName = (id) => (state.employees[id] ? state.employees[id].employee_name : id);
const deptLabel = (id) => (DEPTS[id] ? DEPTS[id].label : id);

// ───────── banner ─────────
let bannerTimer = null;
function banner(kind, html) {
  const el = $('#banner');
  clearInterval(bannerTimer);
  el.className = `banner ${kind}`;
  el.innerHTML = `${html}<button type="button" class="icon-btn" data-close-banner aria-label="Đóng">✕</button>`;
  el.hidden = false;
}

// ───────── departments & employees ─────────
function buildDepartments(org) {
  const host = $('#departments');
  host.innerHTML = '';
  const depts = [...org.departments].sort((a, b) => (DEPTS[a.department_id]?.order ?? 9) - (DEPTS[b.department_id]?.order ?? 9));
  for (const d of depts) {
    const meta = DEPTS[d.department_id] || { label: d.name, sub: d.purpose, icon: '🏢' };
    const col = document.createElement('article');
    col.className = 'panel dept';
    col.dataset.dept = d.department_id;
    col.innerHTML = `
      <header class="dept-head">
        <div class="dept-icon">${meta.icon}</div>
        <div class="names"><h3>${esc(meta.label)}</h3><p>${esc(meta.sub)}</p></div>
        <span class="badge" data-badge></span>
      </header>
      <div class="dept-body"><div class="label">NHÂN SỰ</div></div>`;
    const body = $('.dept-body', col);
    const order = Object.keys(ICONS);   // same order as the organization spec
    const staff = [...d.employees].sort((a, b) => order.indexOf(a.employee_id) - order.indexOf(b.employee_id));
    for (const e of staff) {
      const card = document.createElement('div');
      card.className = 'emp';
      card.dataset.emp = e.employee_id;
      card.innerHTML = `
        <div class="emp-head">
          <div class="emp-icon">${ICONS[e.employee_id] || '🤖'}</div>
          <div class="names"><h4>${esc(e.employee_name)}</h4><p>${esc(e.job_title)}</p></div>
          <span class="tag" title="${esc((e.skills || []).map((s) => s.skill_name).join(', '))}">${(e.skills || []).length} SKILL</span>
        </div>
        <div class="state" data-state></div>
        <form class="assign" data-assign="${esc(e.employee_id)}">
          <input maxlength="100000" placeholder="${esc((e.input_schema && e.input_schema['x-input-hint']) || 'Giao việc trực tiếp…')}">
          <button type="submit" class="btn">▶ Giao lại</button>
        </form>`;
      body.appendChild(card);
    }
    host.appendChild(col);
  }
  const nav = $('#side-nav');
  nav.insertAdjacentHTML('beforeend', '<div class="group">PHÒNG BAN</div>' + depts.map((d) => {
    const meta = DEPTS[d.department_id] || { label: d.name, icon: '🏢' };
    return `<a href="#${esc(d.department_id)}" data-scope="${esc(d.department_id)}"><span class="ico">${meta.icon}</span>
      <span class="lbl">${esc(meta.label)}</span><span class="cnt" data-busy="${esc(d.department_id)}"></span></a>`;
  }).join(''));
  state.departments = depts;
  state.built = true;
  applyScopeChrome();
}

// Header, sidebar highlight, visible department and command placeholder for the current scope.
function applyScopeChrome() {
  const settings = state.view === 'settings';
  $('#side-sys a').classList.toggle('active', settings);
  document.querySelectorAll('#side-nav a').forEach((a) => {
    a.classList.toggle('active', !settings && a.dataset.scope === state.scope);
    a.setAttribute('href', hashFor(a.dataset.scope, state.view));   // switching department keeps the view
  });
  document.querySelectorAll('[data-view-tab]').forEach((a) => {
    a.classList.toggle('active', a.dataset.viewTab === state.view);
    a.setAttribute('href', hashFor(state.scope, a.dataset.viewTab));
  });
  $('#recent-library').setAttribute('href', hashFor(state.scope, 'library'));
  // not "data-view": that attribute marks clickable "Xem" targets (plan|task) in the click handler
  $('.shell').dataset.mode = state.view;
  fillLibraryEmployees();
  const dept = state.departments.find((d) => d.department_id === state.scope);
  const meta = dept ? (DEPTS[dept.department_id] || { label: dept.name, sub: dept.purpose, icon: '🏢' }) : null;
  $('#scope-icon').textContent = meta ? meta.icon : 'W';
  $('#scope-title').innerHTML = meta ? `Phòng <span class="accent">${esc(meta.label)}</span>`
    : 'Vận hành doanh nghiệp bằng <span class="accent">đội ngũ nhân sự AI</span>';
  $('#scope-sub').textContent = meta ? `Trưởng phòng giao việc · chỉ ${dept.employees.length} agent của phòng nhận việc` : 'CEO điều phối toàn công ty';
  $('#stat-depts-box').hidden = !!meta;
  $('#departments').classList.toggle('single', !!meta);
  document.querySelectorAll('.dept').forEach((c) => c.classList.toggle('current', c.dataset.dept === state.scope));
  if (!state.submitting && !$('#objective').disabled) setCommandLocked(false);
  document.title = `${state.view === 'library' ? 'Thư viện · ' : ''}${meta ? `${meta.label} · ` : ''}AI Workforce`;
  if (settings) {
    $('#scope-icon').textContent = '⚙️';
    $('#scope-title').innerHTML = 'Kết nối &amp; <span class="accent">tài khoản</span>';
    $('#scope-sub').textContent = 'Tài khoản các dịch vụ bên ngoài mà agent dùng · bí mật được lưu mã hoá trong n8n';
    document.title = 'Kết nối & tài khoản · AI Workforce';
  }
}

function queueLine(q) {
  if (!q || !q.waiting) return '';
  const parts = [q.ceo ? `${q.ceo} của CEO` : '', q.department ? `${q.department} của phòng` : ''].filter(Boolean).join(', ');
  return `<div class="queue-line">⏳ Đang chờ: ${q.waiting} việc (${parts})${q.capacity > 1 ? ` · làm tối đa ${q.capacity} việc cùng lúc` : ''}</div>`;
}

function employeeState(e) {
  const a = e.activity || {};
  const cur = a.current_task;
  const q = a.queued_task;
  const res = a.last_result;
  const fail = a.last_failure;
  if (cur) {
    return { running: true, html: `
      <div class="thinking"><span class="spinner"></span>Đang suy luận… <span data-since="${esc(cur.started_at)}"></span>
        <span class="for-tag ${cur.for === 'ceo' ? 'ceo' : ''}">${cur.for === 'ceo' ? 'việc CEO' : 'việc phòng'}</span></div>
      ${queueLine(a.queue)}
      <div class="meta"><span>${esc(cur.task_name)}${cur.retry_count ? ` · thử lại lần ${cur.retry_count}` : ''}</span>
        <button type="button" class="btn danger small" data-cancel="${esc(cur.plan_id)}">■ Dừng</button></div>` };
  }
  if (q) {
    const waits = (q.waiting_for || []).map((w) => w.employee_name);
    const text = q.status === 'blocked' ? '⛔ Bị chặn: việc trước đó bị lỗi'
      : q.status === 'awaiting_approval' ? '✋ Chờ bạn duyệt kết quả'
      : waits.length ? `⏳ Chờ tới lượt · sau ${waits.join(', ')}` : '⏳ Sẵn sàng · đang chờ lượt chạy';
    return { html: `<div class="state wait">${esc(text)}</div>
      <div class="step-box" data-plan="${esc(q.plan_id)}">Bước ${q.step}/${q.total_steps} · trong kế hoạch</div>` };
  }
  if (fail && (!res || new Date(fail.at) > new Date(res.completed_at))) {
    return { html: `<div class="state err">✗ Lỗi: ${esc(fail.message || 'không rõ')}</div>
      <div class="meta"><span>${rel(fail.at)}</span><span class="actions">
        <button type="button" class="btn small" data-view="${esc(fail.plan_id)}|${esc(fail.task_id)}">Xem</button>
        <button type="button" class="btn small" data-retry="${esc(fail.plan_id)}|${esc(fail.task_id)}">↻ Thử lại</button></span></div>` };
  }
  if (res) {
    return { html: `${res.asset_url ? `<img class="thumb" src="${esc(res.asset_url)}" alt="" loading="lazy">` : ''}
      <div class="state ok"><div class="summary"><span class="mark">✓</span> ${esc(res.summary)}</div></div>
      <div class="meta"><span>xong · ${rel(res.completed_at)}</span>
        <button type="button" class="btn small" data-view="${esc(res.plan_id)}|${esc(res.task_id)}">Xem</button></div>` };
  }
  return { html: '<div class="state wait">Chưa có việc nào.</div>' };
}

function renderOrg(org) {
  if (!state.built) buildDepartments(org);
  let busy = 0;
  let total = 0;
  for (const d of org.departments) {
    const col = document.querySelector(`.dept[data-dept="${d.department_id}"]`);
    let deptBusy = false;
    let lastDone = null;
    for (const e of d.employees) {
      total++;
      state.employees[e.employee_id] = e;
      const card = document.querySelector(`.emp[data-emp="${e.employee_id}"]`);
      if (!card) continue;
      const s = employeeState(e);
      card.classList.toggle('running', !!s.running);
      setHTML($('[data-state]', card), s.html);
      if (s.running) { busy++; deptBusy = true; }
      const done = e.activity && e.activity.last_result && e.activity.last_result.completed_at;
      if (done && (!lastDone || done > lastDone)) lastDone = done;
    }
    if (col) {
      const badge = $('[data-badge]', col);
      badge.className = `badge ${deptBusy ? 'busy' : lastDone ? 'done' : ''}`;
      badge.textContent = deptBusy ? '● đang làm' : lastDone ? `✓ ${rel(lastDone)}` : 'chưa có việc';
    }
  }
  const busyBy = {};
  for (const d of org.departments) {
    busyBy[d.department_id] = d.employees.filter((e) => e.activity && e.activity.current_task).length;
  }
  const scoped = org.departments.find((d) => d.department_id === state.scope);
  $('#stat-depts').textContent = org.departments.length;
  $('#stat-employees').textContent = scoped ? scoped.employees.length : total;
  $('#stat-busy').textContent = scoped ? busyBy[scoped.department_id] : busy;
  document.querySelectorAll('[data-busy]').forEach((el) => {
    const n = el.dataset.busy === 'ceo' ? busy : busyBy[el.dataset.busy] || 0;
    el.textContent = n ? `${n} đang làm` : '';
  });
}

// ───────── recent results, approvals, plans ─────────
function renderRecent(results) {
  const items = results.filter((r) => !state.dismissed.has(`${r.plan_id}|${r.task_id}|${r.completed_at}`));
  $('#recent-count').textContent = items.length;
  setHTML($('#recent-list'), items.length ? items.map((r) => `
    <li class="recent-item" data-view="${esc(r.plan_id)}|${esc(r.task_id)}">
      <div class="text">✓ <b>${esc(r.employee_name)} xong:</b> ${esc(r.summary)}</div>
      <button type="button" class="icon-btn" data-dismiss="${esc(`${r.plan_id}|${r.task_id}|${r.completed_at}`)}" aria-label="Ẩn">✕</button>
    </li>`).join('') : '<li class="empty">Chưa có kết quả mới.</li>');
}

function renderApprovals(list) {
  $('#approvals').hidden = !list.length;
  setHTML($('#approval-list'), list.map((a) => `
    <li class="approval">
      <div class="grow">${esc(a.objective)}
        <small>${a.approval_type === 'final_deliverables' ? 'Bản cuối của kế hoạch' : `Kết quả task ${esc(a.task_id)}`} · ${rel(a.created_at)}${a.payload && a.payload.reviewer_verdict ? ` · CEO: ${a.payload.reviewer_verdict === 'approved' ? 'đạt' : 'cần chỉnh'}` : ''}</small></div>
      <div class="actions">
        <button type="button" class="btn small" data-plan="${esc(a.plan_id)}">Xem</button>
        <button type="button" class="btn small ok" data-decide="${esc(a.approval_id)}|approved">✓ Duyệt</button>
        <button type="button" class="btn small" data-decide="${esc(a.approval_id)}|rejected">✗ Từ chối</button>
      </div>
    </li>`).join(''));
}

function renderStrips(plans) {
  setHTML($('#plan-strips'), plans.map((p) => {
    const steps = p.tasks.map((t) => `<span class="step ${esc(t.status)}" title="${esc(t.task_name)} · ${esc(STATUS_VI[t.status] || t.status)}">
        ${STEP_ICON[t.status] || '⏳'} ${esc(empName(t.assigned_employee_id))}</span>`).join('<span class="arrow">→</span>');
    return `<div class="panel strip">
      <span class="title">🗂️ Kế hoạch</span><span class="pill ${esc(p.status)}">${esc(STATUS_VI[p.status] || p.status)}</span>
      <div class="chips">${steps}</div>
      <button type="button" class="btn small" data-plan="${esc(p.plan_id)}">Chi tiết</button>
      ${p.can_cancel ? `<button type="button" class="btn danger small" data-cancel="${esc(p.plan_id)}">■ Dừng</button>` : ''}
      <div class="objective">${esc(p.objective)}${p.status_reason ? ` — ${esc(p.status_reason)}` : ''}</div>
    </div>`;
  }).join(''));
}

// ───────── content library ─────────
// Agent filter: only the agents of the open scope (all of them on the CEO tab).
function fillLibraryEmployees() {
  const sel = $('#lib-employee');
  const emps = state.departments.filter((d) => state.scope === 'ceo' || d.department_id === state.scope)
    .flatMap((d) => d.employees.map((e) => ({ ...e, dept: d.department_id })));
  const html = '<option value="">Tất cả agent</option>' + emps.map((e) =>
    `<option value="${esc(e.employee_id)}">${ICONS[e.employee_id] || '🤖'} ${esc(e.employee_name)}${state.scope === 'ceo' ? ` · ${esc(deptLabel(e.dept))}` : ''}</option>`).join('');
  if (sel.__html !== html) {
    sel.innerHTML = html;
    sel.__html = html;
    if (!emps.some((e) => e.employee_id === state.lib.employee)) state.lib.employee = '';
    sel.value = state.lib.employee;
  }
}

function libraryQuery(limit, offset) {
  const l = state.lib;
  const qs = new URLSearchParams({ status: l.status, limit: String(limit), offset: String(offset) });
  if (deptScope()) qs.set('department_id', deptScope());
  if (l.employee) qs.set('employee_id', l.employee);
  if (l.approval) qs.set('approval', l.approval);
  if (l.q.trim()) qs.set('q', l.q.trim());
  return `library?${qs}`;
}

// mode 'reset': first page; 'more': next page; 'reload': same number of items (after a change)
async function loadLibrary(mode = 'reset') {
  const l = state.lib;
  const scope = state.scope;
  const offset = mode === 'more' ? l.items.length : 0;
  const limit = mode === 'reload' ? Math.min(Math.max(l.items.length, LIB_PAGE), 100) : LIB_PAGE;
  const key = libraryQuery(limit, offset);
  l.loading = key;
  if (mode === 'reset') $('#lib-info').textContent = 'Đang tải…';
  try {
    const r = await api('GET', key);
    if (l.loading !== key || scope !== state.scope) return;     // a newer request or another tab won
    l.items = mode === 'more' ? l.items.concat(r.items) : r.items;
    l.total = r.total;
    l.counts = r.counts;
    renderLibrary();
  } catch (e) {
    if (l.loading === key) $('#lib-info').textContent = `Không tải được thư viện: ${e.message}`;
  } finally {
    if (l.loading === key) l.loading = false;
  }
}

function libraryActions(item, small = true) {
  const k = `${item.plan_id}|${item.task_id}`;
  const b = (status, label, cls = '') => `<button type="button" class="btn ${small ? 'small' : ''} ${cls}" data-libstatus="${esc(k)}|${status}">${label}</button>`;
  if (item.status === 'archived') return b('new', '↺ Khôi phục');
  return (item.status === 'used' ? b('new', '↺ Đánh dấu mới') : b('used', '✓ Đã dùng', 'ok')) + b('archived', '🗄 Lưu trữ');
}

function renderLibrary() {
  const l = state.lib;
  const c = l.counts || {};
  const chips = ['active', 'new', 'used', 'archived', 'all'].map((s) => {
    const n = s === 'active' ? (c.new || 0) + (c.used || 0) : c[s] || 0;
    return `<button type="button" class="lib-chip ${l.status === s ? 'active' : ''}" data-libfilter="${s}">${LIB_VI[s]} <b>${n}</b></button>`;
  }).join('');
  setHTML($('#lib-status'), chips);
  const ceo = state.scope === 'ceo';
  setHTML($('#lib-grid'), l.items.length ? l.items.map((it) => `
    <article class="lib-card ${it.status}" data-view="${esc(it.plan_id)}|${esc(it.task_id)}" tabindex="0">
      ${it.thumbnail_url ? `<img class="lib-thumb" src="${esc(it.thumbnail_url)}" alt="" loading="lazy">` : ''}
      <div class="lib-top"><span class="lib-emp">${ICONS[it.employee_id] || '🤖'} ${esc(it.employee_name)}</span>
        ${ceo ? `<span class="lib-dept" data-d="${esc(it.department_id)}">${esc(deptLabel(it.department_id))}</span>` : ''}</div>
      <h4>${esc(it.title)}</h4>
      <p class="lib-sum">${esc(it.summary)}</p>
      <div class="lib-badges">
        <span class="pill ${esc(APPROVAL_PILL[it.approval] || '')}">${esc(APPROVAL_VI[it.approval] || it.approval)}</span>
        <span class="pill lib-${esc(it.status)}">${esc(LIB_VI[it.status])}</span>
        ${it.published_url ? `<a class="pill approved" href="${esc(it.published_url)}" target="_blank" rel="noopener">🔗 Đã đăng</a>` : ''}
      </div>
      <div class="lib-meta"><span title="${esc(new Date(it.created_at).toLocaleString('vi-VN'))}">${rel(it.created_at)}${it.status_by ? ` · ${esc(it.status_by)}` : ''}</span>
        <span class="actions">${libraryActions(it)}</span></div>
    </article>`).join('')
    : `<div class="empty lib-empty">${l.q || l.employee || l.approval ? 'Không có nội dung khớp bộ lọc.' : l.status === 'archived' ? 'Chưa có gì trong lưu trữ.' : 'Chưa có nội dung nào. Giao việc ở tab Điều hành, kết quả của agent sẽ xuất hiện ở đây.'}</div>`);
  $('#lib-info').textContent = l.items.length ? `Hiển thị ${l.items.length}/${l.total}` : '';
  $('#lib-more').hidden = l.items.length >= l.total;
}

async function setLibraryStatus(planId, taskId, status) {
  try {
    await api('POST', 'library/status', { plan_id: planId, task_id: taskId, status, updated_by: approver() });
  } catch (e) {
    banner('error', `<div class="grow">✗ Không đổi được trạng thái: ${esc(e.message)}</div>`);
    return;
  }
  if (state.view === 'library') loadLibrary('reload');
  if (state.modal && state.modal.plan === planId && state.modal.task === taskId && !$('#modal').hidden) showOutput(planId, taskId);
  refreshLibraryBadge();
}

// "N mới" on the library tab; also reloads the open library when new outputs arrive.
async function refreshLibraryBadge() {
  try {
    const r = await api('GET', `library?status=all&limit=1${scopeQS()}`);
    $('#lib-tab-count').textContent = r.counts.new ? `${r.counts.new} mới` : '';
    const all = `${state.scope}:${r.counts.all}`;
    if (state.lib.seenAll !== null && state.lib.seenAll !== all && state.view === 'library' && !state.lib.loading) loadLibrary('reload');
    state.lib.seenAll = all;
  } catch { /* the connection line already reports backend problems */ }
}

function downloadText(filename, content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const slug = (s) => String(s || 'noi-dung').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'noi-dung';

async function refresh() {
  if (state.refreshing) { state.refreshAgain = true; return; }
  state.refreshing = true;
  const scope = state.scope;
  const [org, recent, approvals, plans] = await Promise.allSettled([
    api('GET', 'organization'), api('GET', `results/recent?limit=5${scopeQS()}`), api('GET', `approvals${scopeQS('?')}`),
    api('GET', `plans?limit=30${scopeQS()}`),
  ]);
  // The tab changed while loading: discard this round (it belongs to the previous scope).
  if (scope !== state.scope) { state.refreshing = false; refresh(); return; }
  const conn = $('#connection');
  if (org.status === 'fulfilled') {
    renderOrg(org.value);
    conn.className = 'connection';
    conn.textContent = `Đã kết nối n8n · cập nhật ${new Date().toLocaleTimeString('vi-VN')}`;
  } else {
    conn.className = 'connection bad';
    conn.textContent = `Không kết nối được backend: ${org.reason.message}`;
  }
  if (recent.status === 'fulfilled') renderRecent(recent.value.results);
  if (approvals.status === 'fulfilled') renderApprovals(approvals.value.approvals);
  if (plans.status === 'fulfilled') {
    await syncPlanning(plans.value.plans);
    $('#history-count').textContent = plans.value.plans.length;
    const active = plans.value.plans.filter((p) => ['running', 'reviewing', 'blocked'].includes(p.status)).slice(0, 3);
    const details = await Promise.allSettled(active.map((p) => api('GET', `plan?plan_id=${p.plan_id}`)));
    if (scope === state.scope) renderStrips(details.filter((d) => d.status === 'fulfilled').map((d) => d.value));
  }
  await refreshLibraryBadge();
  state.refreshing = false;
  if (state.refreshAgain) { state.refreshAgain = false; refresh(); }
}

// ───────── modals ─────────
function openModal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
}
const closeModal = () => { $('#modal').hidden = true; };

function renderValue(v, depth = 0) {
  if (v === null || v === undefined || v === '') return '<span class="empty">—</span>';
  if (typeof v !== 'object') return `<div class="v">${esc(v)}</div>`;
  if (depth > 5) return `<div class="v">${esc(JSON.stringify(v))}</div>`;
  if (Array.isArray(v)) {
    if (!v.length) return '<span class="empty">—</span>';
    if (v.every((x) => typeof x !== 'object' || x === null)) return `<ul>${v.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    return v.map((x) => `<div class="sub">${renderValue(x, depth + 1)}</div>`).join('');
  }
  return `<div class="kv">${Object.entries(v).map(([k, x]) => `<div><div class="k">${esc(k.replace(/_/g, ' '))}</div>${renderValue(x, depth + 1)}</div>`).join('')}</div>`;
}

async function showOutput(planId, taskId) {
  openModal('Đang tải…', '<div class="empty">Đang tải kết quả…</div>');
  try {
    const t = await api('GET', `task/output?plan_id=${encodeURIComponent(planId)}&task_id=${encodeURIComponent(taskId)}`);
    const view = t.output ? window.ContentViews.render(t.employee_id, t.output) : null;
    const title = (t.output && (t.output.title || (t.output.card && t.output.card.headline) || t.output.video_title)) || t.task_name;
    state.modal = { plan: t.plan_id, task: t.task_id, markdown: view ? view.markdown : JSON.stringify(t.output, null, 2),
                    filename: `${slug(title)}.md`, json: t.output ? JSON.stringify(t.output, null, 2) : '' };
    const genericImages = !view && t.output && Array.isArray(t.output.asset_urls) ? t.output.asset_urls.map((u) =>
      `<a href="${esc(u)}" target="_blank" rel="noopener"><img class="asset" src="${esc(u)}" alt="Ảnh do Visual Design tạo"></a>`).join('') : '';
    openModal(`${ICONS[t.employee_id] || '🤖'} ${t.employee_name} · ${t.task_name}`, `
      <div class="cv-head">
        <div class="grow"><div class="k">YÊU CẦU</div><div class="v">${esc(t.objective)}</div></div>
        <div class="cv-badges"><span class="pill ${esc(t.status)}">${esc(STATUS_VI[t.status] || t.status)}</span>
          ${t.output ? `<span class="pill ${esc(APPROVAL_PILL[t.approval] || '')}">${esc(APPROVAL_VI[t.approval] || '')}</span>
          <span class="pill lib-${esc(t.library_status)}">${esc(LIB_VI[t.library_status] || '')}</span>` : ''}
          ${t.produced_at ? `<small class="cv-muted">${esc(new Date(t.produced_at).toLocaleString('vi-VN'))}</small>` : ''}</div>
      </div>
      ${t.last_error ? `<div class="state err">✗ ${esc(t.last_error.message || JSON.stringify(t.last_error))}</div>` : ''}
      ${t.output ? `<div class="actions cv-actions">
          <button type="button" class="btn small" data-copy-md>⧉ Sao chép nội dung</button>
          <button type="button" class="btn small" data-download-md>⬇ Tải .md</button>
          ${libraryActions({ plan_id: t.plan_id, task_id: t.task_id, status: t.library_status })}
          <button type="button" class="btn small ghost" data-plan="${esc(t.plan_id)}">Xem cả kế hoạch</button></div>
        <div class="cv">${view ? view.html : genericImages + renderValue(t.output)}</div>
        <details class="cv-raw"><summary>Dữ liệu gốc (JSON)</summary>
          <button type="button" class="btn small" data-copy>Sao chép JSON</button><pre>${esc(state.modal.json)}</pre></details>`
        : '<div class="empty">Chưa có kết quả.</div>'}`);
  } catch (e) {
    openModal('Lỗi', `<div class="state err">${esc(e.message)}</div>`);
  }
}

async function showPlan(planId) {
  openModal('Đang tải…', '<div class="empty">Đang tải kế hoạch…</div>');
  try {
    const [p, d, apv, pub] = await Promise.all([api('GET', `plan?plan_id=${planId}`), api('GET', `plan/deliverables?plan_id=${planId}`),
      api('GET', 'approvals'), api('GET', `plan/publications?plan_id=${planId}`)]);
    const pending = apv.approvals.filter((a) => a.plan_id === planId);
    const report = d.final_report;
    const pubRows = pub.publications.map((x) => `<div class="task-row"><span>🔗</span>
      <div class="grow">LinkedIn · ${esc(x.task_id)}<small>${rel(x.published_at || x.created_at)} · bởi ${esc(x.requested_by)}${x.error ? ` · ${esc(x.error)}` : ''}</small></div>
      <span class="pill ${x.status === 'published' ? 'completed' : x.status === 'failed' ? 'failed' : 'running'}">${x.status === 'published' ? 'đã đăng' : x.status === 'failed' ? 'lỗi' : 'đang đăng'}</span>
      ${x.url ? `<a class="btn small" href="${esc(x.url)}" target="_blank" rel="noopener">Mở bài ↗</a>` : ''}</div>`).join('');
    openModal('Kế hoạch', `
      <div class="kv">
        <div><div class="k">Mục tiêu</div><div class="v">${esc(p.objective)}</div></div>
        <div><div class="k">Trạng thái</div><span class="pill ${esc(p.status)}">${esc(STATUS_VI[p.status] || p.status)}</span>
          ${p.status_reason ? `<small class="empty"> ${esc(p.status_reason)}</small>` : ''}</div>
        <div><div class="k">Tiến độ</div><div class="v">${p.progress.completed}/${p.progress.total} task xong · tạo ${rel(p.created_at)}</div></div>
      </div>
      <div class="actions">
        ${pending.map((a) => `<button type="button" class="btn small ok" data-decide="${esc(a.approval_id)}|approved">✓ Duyệt ${a.task_id ? esc(a.task_id) : 'bản cuối'}</button>
          <button type="button" class="btn small" data-decide="${esc(a.approval_id)}|rejected">✗ Từ chối</button>`).join('')}
        ${p.can_cancel ? `<button type="button" class="btn danger small" data-cancel="${esc(p.plan_id)}">■ Dừng kế hoạch</button>` : ''}
        ${pub.can_publish_linkedin ? `<button type="button" class="btn small gold" data-publish="${esc(p.plan_id)}">🔗 Đăng lên LinkedIn</button>` : ''}
      </div>
      ${pubRows ? `<div class="label">ĐÃ XUẤT BẢN</div>${pubRows}` : ''}
      ${pub.linkedin_post ? linkedinPreview(pub.linkedin_post) : ''}
      <div class="label">CÁC BƯỚC</div>
      ${p.tasks.map((t) => `<div class="task-row">
        <span>${ICONS[t.assigned_employee_id] || '🤖'}</span>
        <div class="grow">${esc(t.task_id)} · ${esc(t.task_name)}
          <small>${esc(empName(t.assigned_employee_id))}${t.depends_on.length ? ` · sau ${esc(t.depends_on.join(', '))}` : ''}${t.retry_count ? ` · đã thử lại ${t.retry_count}` : ''}${t.last_error ? ` · ${esc(t.last_error.message)}` : ''}</small></div>
        <span class="pill ${esc(t.status)}">${esc(STATUS_VI[t.status] || t.status)}</span>
        <span class="actions">
          ${t.has_output ? `<button type="button" class="btn small" data-view="${esc(p.plan_id)}|${esc(t.task_id)}">Xem</button>` : ''}
          ${t.can_retry ? `<button type="button" class="btn small" data-retry="${esc(p.plan_id)}|${esc(t.task_id)}">↻ Thử lại</button>` : ''}
        </span></div>`).join('')}
      ${report ? `<div class="label">BÁO CÁO CỦA CEO · ${d.review && d.review.verdict === 'approved' ? 'ĐẠT' : 'CẦN CHỈNH'}</div>
        <div class="sub">${renderValue({ 'Tiêu đề': report.title, 'Tóm tắt': report.executive_summary, 'Ghi chú xuất bản': report.publication_notes,
          'Vấn đề còn mở': (report.open_issues || []).map((i) => `[${i.severity}] ${i.description}`), 'Bước tiếp theo': report.next_steps })}</div>` : ''}
      ${p.validation_errors ? `<div class="label">LỖI KẾ HOẠCH</div>${renderValue(p.validation_errors)}` : ''}`);
  } catch (e) {
    openModal('Lỗi', `<div class="state err">${esc(e.message)}</div>`);
  }
}

// Exactly the package the publisher sends: this text and this image file (snapshotted on publish).
function linkedinPreview(post) {
  const who = (() => { try { return localStorage.getItem('wf.approver') || 'Bạn'; } catch { return 'Bạn'; } })();
  return `<div class="label">XEM TRƯỚC BÀI LINKEDIN · đúng nội dung sẽ được đăng</div>
    <div class="li-card">
      <div class="li-head"><div class="li-avatar">${esc(who.slice(0, 1).toUpperCase())}</div>
        <div><b>${esc(who)}</b><small>Bài đăng · Công khai 🌐</small></div></div>
      <div class="li-text">${esc(post.text)}</div>
      ${post.image_url ? `<img class="li-image" src="${esc(post.image_url)}" alt="Ảnh đính kèm">` : '<div class="li-noimg">Bài này đăng không kèm ảnh (kế hoạch không có ảnh từ Visual Design).</div>'}
      <div class="li-foot">${post.text.length}/3000 ký tự · chữ từ ${esc(post.task_id)}${post.image_task_id ? ` · ảnh từ ${esc(post.image_task_id)}` : ''}</div>
    </div>`;
}

async function showHistory() {
  openModal('Lịch sử kế hoạch', '<div class="empty">Đang tải…</div>');
  try {
    const { plans } = await api('GET', `plans?limit=50${scopeQS()}`);
    openModal(`Lịch sử kế hoạch (${plans.length})`, plans.length ? plans.map((p) => `
      <div class="plan-row" data-plan="${esc(p.plan_id)}">
        <div>${esc(p.objective)}<br><small>${rel(p.created_at)} · ${p.progress.completed}/${p.progress.total} task</small></div>
        <span class="pill ${esc(p.status)}">${esc(STATUS_VI[p.status] || p.status)}</span>
        <div class="progress"><i style="width:${Number(p.progress.percent) || 0}%"></i></div>
      </div>`).join('') : '<div class="empty">Chưa có kế hoạch nào.</div>');
  } catch (e) {
    openModal('Lỗi', `<div class="state err">${esc(e.message)}</div>`);
  }
}

// ───────── actions ─────────
async function submitObjective(ev) {
  ev.preventDefault();
  const objective = $('#objective').value.trim();
  if (objective.length < 10) return banner('error', '<div class="grow">Hãy mô tả công việc rõ hơn (ít nhất 10 ký tự).</div>');
  const context = {};
  document.querySelectorAll('.attachment').forEach((row) => {
    const text = $('textarea', row).value.trim();
    if (text) context[$('select', row).value] = text;
  });
  const requestedBy = approver();
  state.submitting = true;
  setCommandLocked(true);
  showPlanningBanner(objective, new Date().toISOString());
  try {
    const data = await api('POST', 'requests', { objective, context, requested_by: requestedBy, department_id: deptScope() });
    state.watchPlan = null;
    showAssigned(data.plan_id, data.tasks, data.out_of_scope);
    $('#objective').value = '';
    $('#attachment-list').innerHTML = '';
    $('#attachments').hidden = true;
    updateAttachCount();
  } catch (e) {
    showPlanError(e.message, e.details);
  } finally {
    state.submitting = false;
    refresh();
  }
}

// ───────── CEO planning state (persisted in the database, so it survives F5) ─────────
function setCommandLocked(locked) {
  const ids = ['#objective', '#send', '#toggle-attach', '#add-attachment'];
  ids.forEach((s) => { $(s).disabled = locked; });
  document.querySelectorAll('.attachment textarea, .attachment select').forEach((el) => { el.disabled = locked; });
  const dept = state.departments.find((d) => d.department_id === state.scope);
  const label = dept ? (DEPTS[dept.department_id] || { label: dept.name }).label : null;
  $('#objective').placeholder = locked
    ? `🧠 ${label ? `Trưởng phòng ${label}` : 'CEO'} đang lập kế hoạch, chờ xong mới giao việc tiếp…`
    : label ? `Giao việc cho phòng ${label}… (chỉ agent trong phòng nhận việc)`
      : 'Giao việc cho công ty… (vd: xem video YouTube, viết bài LinkedIn và làm ảnh kèm theo)';
}

function showPlanningBanner(objective, since) {
  if (state.planningBannerFor === since) return;
  state.planningBannerFor = since;
  banner('working', `<div class="grow">🧠 ${deptScope() ? 'Trưởng phòng' : 'CEO'} đang lập kế hoạch… <span id="plan-timer">${elapsed(since)}</span>
    <small class="empty"> ${esc(String(objective).slice(0, 140))}</small></div>`);
  bannerTimer = setInterval(() => { const t = $('#plan-timer'); if (t) t.textContent = elapsed(since); }, 1000);
}

function showAssigned(planId, tasks, outOfScope = []) {
  state.planningBannerFor = null;
  const deptOf = (id) => deptLabel(state.employees[id]?.department_id);
  const depts = [...new Set(tasks.map((t) => deptOf(t.assigned_employee_id)))];
  banner('', `<div class="grow">✓ Đã giao ${esc(depts.join(', '))}.</div>
    ${tasks.map((t) => `<span class="chip">→ ${ICONS[t.assigned_employee_id] || '🤖'} ${esc(empName(t.assigned_employee_id))} · ${esc(deptOf(t.assigned_employee_id))}</span>`).join('')}
    <button type="button" class="btn small" data-plan="${esc(planId)}">Xem kế hoạch</button>
    ${outOfScope && outOfScope.length ? `<div class="scope-warn">⚠ Ngoài phạm vi, chưa giao: <ul>${outOfScope.map((o) =>
      `<li>${esc(o.request)} — ${esc(o.reason)}${o.suggested_department ? ` (nên giao cho ${esc(o.suggested_department)})` : ''}</li>`).join('')}</ul></div>` : ''}`);
}

function showPlanError(message, details) {
  state.planningBannerFor = null;
  banner('error', `<div class="grow">✗ ${esc(message)}${details && details.length ? `<ul>${details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}</div>`);
}

// Called on every poll: lock while any plan is planning; when the watched plan finishes
// (e.g. after F5, so no POST response arrives in this tab), show its outcome.
async function syncPlanning(plans) {
  const planning = plans.find((p) => p.status === 'planning' && (p.department_id || null) === deptScope());
  if (planning) {
    state.watchPlan = planning.plan_id;
    try { localStorage.setItem(watchKey(), planning.plan_id); } catch { /* ignore */ }
    setCommandLocked(true);
    showPlanningBanner(planning.objective, planning.created_at);
    return;
  }
  if (!state.submitting) setCommandLocked(false);
  let watched = state.watchPlan;
  if (watched === undefined) { try { watched = localStorage.getItem(watchKey()); } catch { watched = null; } }
  if (!watched || state.submitting) return;
  state.watchPlan = null;
  try { localStorage.removeItem(watchKey()); } catch { /* ignore */ }
  if (!state.planningBannerFor) return;          // nothing was shown as "planning" in this tab
  try {
    const p = await api('GET', `plan?plan_id=${watched}`);
    if (p.status === 'rejected') showPlanError('Kế hoạch bị từ chối', p.validation_errors || []);
    else showAssigned(p.plan_id, p.tasks);
  } catch (e) {
    showPlanError(e.message);
  }
}

async function assignDirect(form) {
  const input = $('input', form);
  const text = input.value.trim();
  const id = form.dataset.assign;
  if (text.length < 3) { input.focus(); return; }
  const btn = $('button', form);
  btn.disabled = true;
  try {
    await api('POST', 'task/direct', { employee_id: id, text, requested_by: approver(), department_id: deptScope() });
    input.value = '';
    banner('', `<div class="grow">✓ Đã giao trực tiếp cho ${esc(empName(id))}.</div>`);
  } catch (e) {
    banner('error', `<div class="grow">✗ Không giao được cho ${esc(empName(id))}: ${esc(e.message)}</div>`);
  } finally {
    btn.disabled = false;
    refresh();
  }
}

async function act(fn, okText) {
  try {
    await fn();
    if (okText) banner('', `<div class="grow">${esc(okText)}</div>`);
  } catch (e) {
    banner('error', `<div class="grow">✗ ${esc(e.message)}</div>`);
  }
  refresh();
}

// After approving final deliverables, offer to publish when the plan has a LinkedIn post.
async function decide(approvalId, decision, note) {
  try {
    const r = await api('POST', 'approval/decision', { approval_id: approvalId, decision, decided_by: approver(), note });
    banner('', `<div class="grow">${decision === 'approved' ? '✓ Đã duyệt.' : '✗ Đã từ chối.'}</div>`);
    if (decision === 'approved' && r.approval_type === 'final_deliverables') {
      const pub = await api('GET', `plan/publications?plan_id=${r.plan_id}`);
      if (pub.can_publish_linkedin) {
        banner('', `<div class="grow">✓ Đã duyệt. Kế hoạch có bài LinkedIn sẵn sàng đăng.</div>
          <button type="button" class="btn small gold" data-publish="${esc(r.plan_id)}">🔗 Đăng lên LinkedIn</button>`);
      }
    }
  } catch (e) {
    banner('error', `<div class="grow">✗ ${esc(e.message)}</div>`);
  }
  refresh();
}

async function publishLinkedIn(planId) {
  if (!window.confirm('Đăng bài này CÔNG KHAI lên trang LinkedIn cá nhân đã kết nối?')) return;
  closeModal();
  banner('working', '<div class="grow">🔗 Đang đăng lên LinkedIn…</div>');
  try {
    const r = await api('POST', 'plan/publish-linkedin', { plan_id: planId, requested_by: approver() });
    const last = r.publications[0];
    if (last && last.status === 'published') {
      banner('', `<div class="grow">✓ Đã đăng lên LinkedIn.</div>${last.url ? `<a class="btn small" href="${esc(last.url)}" target="_blank" rel="noopener">Mở bài ↗</a>` : ''}`);
    } else {
      banner('error', `<div class="grow">✗ Đăng LinkedIn thất bại: ${esc((last && last.error) || 'không rõ lỗi')}</div>`);
    }
  } catch (e) {
    banner('error', `<div class="grow">✗ ${esc(e.message)}</div>`);
  }
  refresh();
}

function addAttachment() {
  const row = document.createElement('div');
  row.className = 'attachment';
  row.innerHTML = `<select>${ATTACH_TYPES.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
    <textarea placeholder="Dán nội dung…"></textarea>
    <button type="button" class="icon-btn" data-remove-attachment aria-label="Xoá">✕</button>`;
  $('#attachment-list').appendChild(row);
  updateAttachCount();
  $('textarea', row).focus();
}
function updateAttachCount() {
  const n = document.querySelectorAll('.attachment').length;
  $('#attach-count').textContent = n ? n : '';
}

document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-view],[data-plan],[data-cancel],[data-retry],[data-decide],[data-dismiss],[data-close],[data-close-banner],[data-copy],[data-remove-attachment],[data-publish],'
    + '[data-libstatus],[data-libfilter],[data-copy-md],[data-download-md],[data-copy-idx]');
  if (!t) { if (ev.target === $('#modal')) closeModal(); return; }
  if (ev.target.closest('a[href]') && t.contains(ev.target.closest('a[href]')) && t !== ev.target.closest('a[href]')) return;  // links inside cards
  const d = t.dataset;
  const copied = (text) => navigator.clipboard.writeText(text || '').then(() => { t.textContent = 'Đã chép ✓'; }, () => { t.textContent = 'Không chép được'; });
  if ('libstatus' in d) {
    const [plan, task, status] = d.libstatus.split('|');
    t.disabled = true;
    setLibraryStatus(plan, task, status);
  } else if ('libfilter' in d) {
    state.lib.status = d.libfilter;
    loadLibrary('reset');
  } else if ('copyMd' in d) {
    copied(state.modal && state.modal.markdown);
  } else if ('downloadMd' in d) {
    if (state.modal) downloadText(state.modal.filename, state.modal.markdown);
  } else if ('copyIdx' in d) {
    copied(window.ContentViews.copyTexts[Number(d.copyIdx)]);
  } else if ('dismiss' in d) {
    ev.stopPropagation();
    state.dismissed.add(d.dismiss);
    saveSet('wf.dismissed', state.dismissed);
    refresh();
  } else if ('view' in d) {
    const [plan, task] = d.view.split('|');
    if (plan && task) showOutput(plan, task);
  } else if ('plan' in d) {
    showPlan(d.plan);
  } else if ('cancel' in d) {
    if (window.confirm('Dừng kế hoạch này? Các task chưa xong sẽ bị huỷ và kết quả đang chạy sẽ bị bỏ.')) {
      act(() => api('POST', 'plan/cancel', { plan_id: d.cancel, requested_by: approver(), reason: 'Dừng từ dashboard' }), '■ Đã dừng kế hoạch.');
      closeModal();
    }
  } else if ('retry' in d) {
    const [plan, task] = d.retry.split('|');
    act(() => api('POST', 'task/retry', { plan_id: plan, task_id: task, requested_by: approver() }), `↻ Đã cho chạy lại ${task}.`);
    closeModal();
  } else if ('decide' in d) {
    const [id, decision] = d.decide.split('|');
    const note = decision === 'rejected' ? window.prompt('Lý do từ chối:', '') : '';
    if (note === null) return;
    closeModal();
    decide(id, decision, note);
  } else if ('publish' in d) {
    publishLinkedIn(d.publish);
  } else if ('close' in d) {
    closeModal();
  } else if ('closeBanner' in d) {
    clearInterval(bannerTimer);
    $('#banner').hidden = true;
  } else if ('copy' in d) {
    copied(state.modal && state.modal.json);
  } else if ('removeAttachment' in d) {
    t.closest('.attachment').remove();
    updateAttachCount();
  }
});
document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-assign]');
  if (form) { ev.preventDefault(); assignDirect(form); }
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeModal(); });
$('#command-form').addEventListener('submit', submitObjective);
window.addEventListener('hashchange', () => {
  const next = parseHash();
  if (next.scope === state.scope && next.view === state.view) return;
  const scopeChanged = next.scope !== state.scope;
  state.scope = next.scope;
  state.view = next.view;
  if (scopeChanged) {
    state.watchPlan = undefined;
    state.planningBannerFor = null;
    state.lib.seenAll = null;
    state.lib.items = [];
    clearInterval(bannerTimer);
    $('#banner').hidden = true;
    ['#recent-list', '#approval-list', '#plan-strips'].forEach((sel) => { $(sel).__html = null; });
  }
  applyScopeChrome();
  if (state.view === 'library' && (scopeChanged || !state.lib.items.length)) loadLibrary('reset');
  if (state.view === 'settings' && window.Settings) window.Settings.load();
  if (scopeChanged) refresh();
});
({ scope: state.scope, view: state.view } = parseHash());
applyScopeChrome();
if (state.view === 'library') loadLibrary('reset');
let libSearchTimer = null;
$('#lib-q').addEventListener('input', (ev) => {
  clearTimeout(libSearchTimer);
  libSearchTimer = setTimeout(() => { state.lib.q = ev.target.value; loadLibrary('reset'); }, 300);
});
$('#lib-employee').addEventListener('change', (ev) => { state.lib.employee = ev.target.value; loadLibrary('reset'); });
$('#lib-approval').addEventListener('change', (ev) => { state.lib.approval = ev.target.value; loadLibrary('reset'); });
$('#lib-more').addEventListener('click', () => loadLibrary('more'));
// Enter on a focused library card opens it.
$('#lib-grid').addEventListener('keydown', (ev) => {
  const card = ev.target.closest('.lib-card');
  if (card && ev.key === 'Enter' && ev.target === card) card.click();
});
$('#open-history').addEventListener('click', showHistory);
$('#toggle-attach').addEventListener('click', () => {
  const box = $('#attachments');
  box.hidden = !box.hidden;
  if (!box.hidden && !document.querySelector('.attachment')) addAttachment();
});
$('#add-attachment').addEventListener('click', addAttachment);
$('#clear-recent').addEventListener('click', () => {
  document.querySelectorAll('[data-dismiss]').forEach((b) => state.dismissed.add(b.dataset.dismiss));
  saveSet('wf.dismissed', state.dismissed);
  refresh();
});

// Live "Đang suy luận… m:ss" timers.
setInterval(() => document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = elapsed(el.dataset.since); }), 1000);
refresh();
setInterval(refresh, POLL_MS);
