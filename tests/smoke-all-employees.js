// Smoke test: assigns one small real task to each of the 8 employees through the dashboard
// proxy ("Giao lại"), waits for all of them, and prints a status line per employee.
// Usage: node tests/smoke-all-employees.js   (dashboard on http://localhost:3000)
const BASE = process.env.DASHBOARD_URL || 'http://localhost:3000/api';
const TASKS = {
  emp_yt_linkedin: 'https://www.youtube.com/watch?v=aircAruvnKk',
  emp_repurpose_studio: '[Smoke test] Nhóm mình tự động hoá xử lý hoá đơn: sửa quy trình trước, tự động hoá 70% việc nhàm chán, giao ngoại lệ cho một người. Thời gian xử lý giảm từ 6 ngày xuống 2 ngày.',
  emp_visual_design: 'Hình minh hoạ phong cách sketch: quy trình hoá đơn rối rắm trở thành gọn gàng, thời gian giảm từ 6 ngày xuống 2 ngày.',
  emp_wecommitdw_checker: '[Smoke test] 02:00 job dw_sales_load ok rows=1,204,331\n03:00 ERROR dw_customer_sync: connection timeout to crm-replica\n03:10 dw_customer_sync finished rows=0\nDisk /data 91% (threshold 85%)',
  emp_skill_recommender: 'Cần soạn bài LinkedIn từ một video YouTube về tự động hoá. Ai nên làm?',
  emp_circle_checker: '[Smoke test] Thread #501 by An: "Video bài 3 không phát được trên iPhone" (chưa ai trả lời, 1 ngày)\nThread #502 by Bình: "Cảm ơn buổi live hôm qua!"',
  emp_coaching_timeline: '[Smoke test] 00:00 Mở đầu: chủ đề phản hồi.\n03:10 Sai lầm 1: góp ý chung chung.\n07:45 Bài tập: góp ý theo tình huống - hành vi - tác động.\n11:20 Hỏi đáp và tổng kết.',
  emp_knowledge_support: 'Làm sao để đổi email đăng nhập tài khoản?',
};

const call = async (method, path, body) => {
  const r = await fetch(`${BASE}/${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${path}: ${j.error && j.error.message}`);
  return j.data;
};

(async () => {
  const started = Date.now();
  const plans = {};
  for (const [employee_id, text] of Object.entries(TASKS)) {
    plans[employee_id] = (await call('POST', 'task/direct', { employee_id, text, requested_by: 'smoke-test' })).plan_id;
  }
  const done = {};
  while (Object.keys(done).length < Object.keys(plans).length && Date.now() - started < 8 * 60000) {
    await new Promise((r) => setTimeout(r, 5000));
    for (const [emp, planId] of Object.entries(plans)) {
      if (done[emp]) continue;
      const p = await call('GET', `plan?plan_id=${planId}`);
      const t = p.tasks[0];
      if (['completed', 'failed', 'cancelled'].includes(t.status) || ['awaiting_approval', 'blocked', 'failed'].includes(p.status)) {
        const out = t.has_output ? await call('GET', `task/output?plan_id=${planId}&task_id=T1`) : null;
        done[emp] = { status: t.status, retries: t.retry_count, error: t.last_error && t.last_error.message,
                      warnings: out && out.output ? undefined : undefined, output: out && out.output, secs: Math.round((Date.now() - started) / 1000) };
      }
    }
  }
  for (const emp of Object.keys(plans)) {
    const d = done[emp];
    if (!d) { console.log(`TIMEOUT  ${emp}`); continue; }
    const o = d.output || {};
    const gist = o.post ? `post ${o.post.length} chars, transcript=${o.transcript_source}`
      : o.assets ? `${o.assets.length} assets: ${o.assets.map((a) => a.format).join(',')}`
      : o.image_generation_prompt ? `brief "${o.concept_title}", image_generated=${o.image_generated}`
      : o.findings ? `health=${o.overall_health}, ${o.findings.length} findings, verified=${o.findings.filter((f) => f.evidence_verified).length}`
      : o.recommended_employee_id !== undefined ? `recommends ${o.recommended_employee_id}`
      : o.items ? `${o.items.length} items, escalated=${o.items.filter((i) => i.escalate).length}`
      : o.chapters ? `${o.chapters.length} chapters, removed=${o.removed_unsupported_items}`
      : o.classification ? `escalate=${o.escalate}, confidence=${o.confidence}` : '';
    console.log(`${d.status.padEnd(9)} ${emp.padEnd(24)} ${String(d.secs).padStart(4)}s retries=${d.retries} ${d.error ? `ERROR ${d.error}` : gist}`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
