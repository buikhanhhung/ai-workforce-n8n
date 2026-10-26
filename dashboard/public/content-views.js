// Readable views of employee outputs (one per employee type) for the content library and the
// "Xem" modal, plus a Markdown export of the same content. Unknown shapes return null so the
// caller can fall back to the generic key-value view.
// ContentViews.render(employeeId, output) -> { html, markdown } | null
// Copy buttons carry data-copy-idx; the texts are in ContentViews.copyTexts (reset on each render).
'use strict';

(() => {
  // Models sometimes double-escape line breaks ("\n" arrives as the two characters \ and n).
  const fixBreaks = (s) => s.replace(/(^|[^\\])\\n/g, '$1\n').replace(/(^|[^\\])\\n/g, '$1\n');
  const esc = (v) => String(typeof v === 'string' ? fixBreaks(v) : v ?? '')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const arr = (v) => (Array.isArray(v) ? v : []);
  const text = (v) => (v === null || v === undefined ? '' : typeof v === 'string' ? fixBreaks(v) : JSON.stringify(v));
  const pct = (v) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '');
  let copyTexts = [];

  const copyBtn = (value, label = 'Sao chép') => {
    copyTexts.push(text(value));
    return `<button type="button" class="btn small" data-copy-idx="${copyTexts.length - 1}">⧉ ${esc(label)}</button>`;
  };
  const para = (v) => (text(v).trim() ? `<div class="cv-text">${esc(v)}</div>` : '');
  const section = (title, body) => (body ? `<div class="cv-section"><div class="label">${esc(title)}</div>${body}</div>` : '');
  // Strings or objects: objects become "a · b · c" of their scalar values.
  const itemText = (x) => (x && typeof x === 'object'
    ? Object.values(x).filter((y) => y !== null && typeof y !== 'object' && String(y).trim()).join(' · ') : text(x));
  const list = (v, ordered) => (arr(v).length
    ? `<${ordered ? 'ol' : 'ul'} class="cv-list">${arr(v).map((x) => `<li>${esc(itemText(x))}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>` : '');
  const mdList = (v, ordered) => arr(v).map((x, i) => `${ordered ? `${i + 1}.` : '-'} ${itemText(x)}`).join('\n');
  const md = (...parts) => parts.filter((p) => text(p).trim()).join('\n\n');
  const sev = (s) => `<span class="sev ${esc(String(s || '').toLowerCase())}">${esc(s || '—')}</span>`;

  const VIEWS = {
    emp_yt_linkedin(o) {
      const tags = arr(o.hashtags).map((h) => (String(h).startsWith('#') ? h : `#${h}`)).join(' ');
      const v = o.video_metadata || {};
      return {
        html: `${o.title ? `<h3 class="cv-title">${esc(o.title)}</h3>` : ''}
          <div class="cv-block"><div class="cv-block-head"><span class="label">BÀI LINKEDIN · ${esc(o.character_count || text(o.post).length)} ký tự</span>${copyBtn(o.post, 'Sao chép bài')}</div>
            <div class="cv-text">${esc(o.post)}</div>${tags ? `<div class="cv-tags">${esc(tags)}</div>` : ''}</div>
          ${v.url ? `<div class="cv-meta">🎬 Nguồn: <a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.title || v.url)}</a>${v.channel ? ` · ${esc(v.channel)}` : ''}</div>` : ''}
          ${section('Ý CHÍNH', list(o.key_ideas))}
          ${section('TÓM TẮT', para(o.summary))}`,
        markdown: md(`# ${o.title || 'Bài LinkedIn'}`, o.post, tags, v.url ? `Nguồn: ${v.title || ''} ${v.url}` : '',
          arr(o.key_ideas).length ? `## Ý chính\n${mdList(o.key_ideas)}` : ''),
      };
    },

    emp_repurpose_studio(o) {
      const assets = arr(o.assets);
      return {
        html: `${o.core_message ? `<div class="cv-callout">💡 ${esc(o.core_message)}</div>` : ''}
          ${assets.map((a) => `<div class="cv-block">
            <div class="cv-block-head"><span><span class="chip">${esc(a.format)}</span> <b>${esc(a.title || '')}</b>
              ${a.variation ? `<small class="cv-muted"> · biến thể ${esc(a.variation)}</small>` : ''}${a.word_count ? `<small class="cv-muted"> · ${esc(a.word_count)} từ</small>` : ''}</span>
              ${copyBtn(a.content)}</div>
            <div class="cv-text">${esc(a.content)}</div>${a.notes ? `<small class="cv-muted">${esc(a.notes)}</small>` : ''}</div>`).join('')}
          ${section('GHI CHÚ PHỐI HỢP', para(o.coordination_notes))}`,
        markdown: md(o.core_message ? `> ${o.core_message}` : '',
          ...assets.map((a) => `## ${a.format}${a.title ? ` — ${a.title}` : ''}\n\n${text(a.content)}`)),
      };
    },

    emp_visual_design(o) {
      const c = o.card || {};
      const img = arr(o.asset_urls)[0];
      const name = img ? img.split('/').pop() : '';
      return {
        html: `${img ? `<a href="${esc(img)}" target="_blank" rel="noopener"><img class="asset" src="${esc(img)}" alt="${esc(c.headline || 'Ảnh')}"></a>
            <div class="actions"><a class="btn small" href="${esc(img)}" download="${esc(name)}">⬇ Tải ảnh PNG</a>
              ${o.dimensions ? `<small class="cv-muted">${esc(o.dimensions.width)}×${esc(o.dimensions.height)} px</small>` : ''}</div>`
            : '<div class="cv-callout">Chưa có ảnh (chỉ có bản mô tả thiết kế).</div>'}
          ${c.headline ? `<div class="cv-block"><h3 class="cv-title">${esc(c.headline)}</h3>${para(c.subtitle)}${list(c.points)}
            ${c.stat ? `<div class="cv-meta">📊 ${esc(itemText(c.stat))}</div>` : ''}</div>` : ''}
          ${section('Ý TƯỞNG HÌNH ẢNH', para(o.visual_concept))}
          ${o.design_brief ? section('BRIEF', para(o.design_brief.key_message)) : ''}`,
        markdown: md(`# ${c.headline || o.concept_title || 'Visual'}`, c.subtitle, mdList(c.points), img ? `Ảnh: ${img}` : '', o.visual_concept),
      };
    },

    emp_wecommitdw_checker(o) {
      const f = arr(o.findings);
      return {
        html: `<div class="cv-meta">🩺 ${esc(o.system_name || 'Hệ thống')} · sức khỏe: ${sev(o.overall_health)} · ${f.length} phát hiện</div>
          ${o.data_scope ? `<small class="cv-muted">Dữ liệu đã phân tích: ${esc(o.data_scope)}</small>` : ''}
          ${f.map((x) => `<div class="cv-block">
            <div class="cv-block-head"><span>${sev(x.severity)} <b>${esc(x.title)}</b>${x.category ? `<small class="cv-muted"> · ${esc(x.category)}</small>` : ''}</span>
              ${x.evidence_verified ? '<small class="cv-ok">✓ bằng chứng khớp dữ liệu</small>' : '<small class="cv-warn">⚠ chưa đối chiếu được</small>'}</div>
            ${x.evidence ? `<blockquote class="cv-quote">${esc(x.evidence)}</blockquote>` : ''}
            ${x.recommendation ? `<div>👉 ${esc(x.recommendation)}</div>` : ''}</div>`).join('')}
          ${section('ĐỀ XUẤT CẢI TIẾN', list(o.improvements))}
          ${section('THIẾU THÔNG TIN', list(o.missing_information))}
          ${section('CÂU HỎI CÒN MỞ', list(o.unresolved_questions))}`,
        markdown: md(`# Kiểm tra ${o.system_name || 'hệ thống'} — ${o.overall_health || ''}`,
          ...f.map((x) => `## [${x.severity}] ${x.title}\n\n> ${text(x.evidence)}\n\n${text(x.recommendation)}`),
          arr(o.improvements).length ? `## Đề xuất cải tiến\n${mdList(o.improvements)}` : ''),
      };
    },

    emp_skill_recommender(o) {
      return {
        html: `<div class="cv-callout">🧭 Đề xuất: <b>${esc(o.recommended_employee_name || 'không có nhân sự phù hợp')}</b>
            ${pct(o.confidence) ? `<small class="cv-muted"> · độ tin cậy ${pct(o.confidence)}</small>` : ''}</div>
          ${section('LÝ DO', para(o.rationale))}
          ${section('KỸ NĂNG CẦN DÙNG', list(o.recommended_skills))}
          ${section('CÁC BƯỚC THỰC HIỆN', list(o.execution_steps, true))}
          ${section('ĐIỀU KIỆN CẦN', list(o.prerequisites))}
          ${section('KHOẢNG TRỐNG NĂNG LỰC', list(o.capability_gaps))}
          ${section('PHƯƠNG ÁN KHÁC', list(o.alternatives))}`,
        markdown: md(`# Đề xuất: ${o.recommended_employee_name || 'không có'}`, o.rationale,
          arr(o.execution_steps).length ? `## Các bước\n${mdList(o.execution_steps, true)}` : ''),
      };
    },

    emp_circle_checker(o) {
      const items = arr(o.items);
      return {
        html: `${para(o.summary)}
          ${items.map((x) => `<div class="cv-block">
            <div class="cv-block-head"><span>${sev(x.priority)} <b>${esc(x.reference || '')}</b>${x.author ? ` · ${esc(x.author)}` : ''}
              <small class="cv-muted"> · ${esc(x.category || '')}</small></span>
              ${x.escalate ? '<small class="cv-warn">⚠ cần chuyển người xử lý</small>' : ''}</div>
            <div>${esc(x.issue)}</div>
            ${x.escalate && x.escalation_reason ? `<small class="cv-warn">${esc(x.escalation_reason)}</small>` : ''}
            ${x.draft_response ? `<div class="cv-draft"><div class="cv-block-head"><span class="label">TRẢ LỜI NHÁP · chưa đăng</span>${copyBtn(x.draft_response)}</div>
              <div class="cv-text">${esc(x.draft_response)}</div></div>` : ''}</div>`).join('')}
          ${section('XU HƯỚNG', list(o.trends))}
          ${section('CÂU HỎI CHƯA AI TRẢ LỜI', list(o.unanswered_questions))}`,
        markdown: md('# Soát cộng đồng', o.summary,
          ...items.map((x) => `## ${x.reference || ''} — ${x.issue}\n\nƯu tiên: ${x.priority}${x.escalate ? ' · CẦN CHUYỂN NGƯỜI XỬ LÝ' : ''}\n\n${text(x.draft_response)}`)),
      };
    },

    emp_coaching_timeline(o) {
      const ch = arr(o.chapters);
      const hl = arr(o.highlights);
      return {
        html: `${o.video_title ? `<h3 class="cv-title">${esc(o.video_title)}</h3>` : ''}
          ${section('CHƯƠNG', `<table class="cv-table"><tbody>${ch.map((c) => `<tr><td class="cv-ts">${esc(c.start)}${c.end ? `–${esc(c.end)}` : ''}</td>
            <td><b>${esc(c.title)}</b><div class="cv-muted">${esc(c.summary || '')}</div></td></tr>`).join('')}</tbody></table>`)}
          ${hl.length ? section('HIGHLIGHT ĐỂ CẮT CLIP', `<table class="cv-table"><tbody>${hl.map((h) => `<tr><td class="cv-ts">${esc(h.timestamp)}</td>
            <td><b>${esc(h.label)}</b><div class="cv-muted">${esc(h.reason || '')}</div></td></tr>`).join('')}</tbody></table>`) : ''}
          ${section('GHI CHÚ CHO NGƯỜI DỰNG', list(o.media_handoff_notes))}
          ${o.removed_unsupported_items ? `<small class="cv-muted">Đã loại ${esc(o.removed_unsupported_items)} mục có mốc thời gian không có trong transcript.</small>` : ''}`,
        markdown: md(`# ${o.video_title || 'Timeline coaching'}`, '## Chương',
          ch.map((c) => `- ${c.start}${c.end ? `–${c.end}` : ''} ${c.title}`).join('\n'),
          hl.length ? `## Highlight\n${hl.map((h) => `- ${h.timestamp} ${h.label}: ${text(h.reason)}`).join('\n')}` : '',
          arr(o.media_handoff_notes).length ? `## Ghi chú dựng\n${mdList(o.media_handoff_notes)}` : ''),
      };
    },

    emp_knowledge_support(o) {
      const c = o.classification || {};
      return {
        html: `<div class="cv-meta">📚 ${esc(c.category || '')}${c.urgency ? ` · khẩn: ${esc(c.urgency)}` : ''}${c.requester_type ? ` · ${esc(c.requester_type)}` : ''}
            ${pct(o.confidence) ? ` · độ tin cậy ${pct(o.confidence)}` : ''}</div>
          ${o.escalate ? `<div class="cv-callout warn">⚠ Chuyển người xử lý: ${esc(o.escalation_reason || 'chưa đủ căn cứ')}</div>` : ''}
          ${text(o.answer).trim() ? `<div class="cv-block"><div class="cv-block-head"><span class="label">CÂU TRẢ LỜI · chưa gửi</span>${copyBtn(o.answer)}</div>${para(o.answer)}</div>` : ''}
          ${section('NGUỒN', list(o.sources))}
          ${section('CÂU HỎI THÊM', list(o.follow_up_questions))}`,
        markdown: md('# Trả lời hỗ trợ', o.escalate ? `CHUYỂN NGƯỜI XỬ LÝ: ${text(o.escalation_reason)}` : '', o.answer,
          arr(o.sources).length ? `## Nguồn\n${mdList(o.sources)}` : ''),
      };
    },
  };

  window.ContentViews = {
    get copyTexts() { return copyTexts; },
    render(employeeId, output) {
      copyTexts = [];
      const view = VIEWS[employeeId];
      if (!view || !output || typeof output !== 'object') return null;
      try { return view(output); } catch { copyTexts = []; return null; }
    },
  };
})();
