// "0 · Architecture Overview": a map of the whole system on one canvas. It has no trigger and is
// never published. Blocks are Execute Workflow nodes referencing the real workflows (their settings
// panel links to them); sticky-note links open each workflow directly. Arrows show who calls whom.
const { WorkflowBuilder } = require('../lib/n8n-builders');
const { WORKFLOW_IDS, WORKFLOW_NAMES } = require('../lib/ids');
const { departments, employees } = require('./organization');

const OVERVIEW_ID = 'wf0Architecture1';

module.exports = function buildArchitectureOverview() {
  const wb = new WorkflowBuilder(OVERVIEW_ID, '0 · Architecture Overview (map only)');
  const note = (name, content, [x, y], width, height, color) =>
    wb.add(name, 'n8n-nodes-base.stickyNote', 1, { content, width, height, color }, [x, y]);
  const marker = (name, position) => wb.add(name, 'n8n-nodes-base.noOp', 1, {}, position);
  const link = (name, id, position) => wb.callWorkflow(name, id, position, { targetName: name });
  // Sticky-note markdown links open the real workflow in a new tab with a single click.
  const url = (id) => `/workflow/${id}`;
  const core = [WORKFLOW_IDS.planning, WORKFLOW_IDS.dispatcher, WORKFLOW_IDS.taskRunner, WORKFLOW_IDS.review,
                WORKFLOW_IDS.dashboardApi, WORKFLOW_IDS.linkedinPublisher];

  note('Read Me', [
    '# AI Workforce — architecture map',
    'Bản đồ tổng của hệ thống. **Không chạy workflow này.**',
    'Bấm link để mở workflow thật (tab mới):',
    ...core.map((id) => `- [${WORKFLOW_NAMES[id]}](${url(id)})`),
    '',
    '1. Request → **A** lập & kiểm tra plan',
    '2. **B Dispatcher** đọc trạng thái trong PostgreSQL, claim task sẵn sàng',
    '3. **B Task Runner** gọi đúng employee (song song nếu độc lập), ghi kết quả, đánh thức lại Dispatcher',
    '4. Hết task → **D CEO Review** → chờ người duyệt',
    '5. **E Dashboard API**: xem tiến độ, retry, cancel, duyệt',
  ].join('\n'), [-60, -900], 520, 480, 7);

  marker('POST /workforce/requests', [0, 0]);
  link('A · CEO Planning', WORKFLOW_IDS.planning, [260, 0]);
  link('B · Task Dispatcher', WORKFLOW_IDS.dispatcher, [560, 0]);
  link('B · Task Runner', WORKFLOW_IDS.taskRunner, [860, 0]);
  link('D · CEO Review', WORKFLOW_IDS.review, [860, 420]);
  marker('Human approval', [1160, 420]);
  link('F · LinkedIn Publisher', WORKFLOW_IDS.linkedinPublisher, [1160, 620]);
  link('E · Dashboard API', WORKFLOW_IDS.dashboardApi, [260, 420]);
  marker('Every minute (poller)', [560, -220]);
  note('State', '### PostgreSQL `wf` schema\nNguồn sự thật: plans, tasks, dependencies, executions, outputs, approvals, events. Mọi workflow đọc/ghi trạng thái ở đây.',
    [460, 260], 300, 140, 4);

  wb.chain('POST /workforce/requests', 'A · CEO Planning', 'B · Task Dispatcher', 'B · Task Runner');
  wb.connect('B · Task Runner', 'B · Task Dispatcher');   // wake after each finished task
  wb.connect('Every minute (poller)', 'B · Task Dispatcher');
  wb.connect('B · Task Dispatcher', 'D · CEO Review');
  wb.connect('D · CEO Review', 'Human approval');
  wb.connect('Human approval', 'F · LinkedIn Publisher');   // only when the approver asks to publish
  wb.connect('D · CEO Review', 'B · Task Dispatcher');      // revision tasks
  wb.connect('E · Dashboard API', 'B · Task Dispatcher');   // retry / approval

  // Employees grouped by department, each linked from the task runner.
  const colors = { dept_marketing: 6, dept_operations: 5, dept_customer_success: 3 };
  let y = -760;
  for (const d of departments) {
    const staff = employees.filter((e) => e.department_id === d.department_id);
    const height = 120 + staff.length * 160;
    note(d.name, `## ${d.name}\n${d.purpose}`, [1180, y], 420, height, colors[d.department_id]);
    staff.forEach((e, i) => {
      const name = `C · ${e.employee_name}`;
      link(name, e.workflow_id, [1300, y + 110 + i * 160]);
      wb.connect('B · Task Runner', name);
      note(`Open ${e.employee_name}`, `[Mở workflow ↗](${url(e.workflow_id)})`, [1460, y + 110 + i * 160], 130, 80, colors[d.department_id]);
    });
    y += height + 40;
  }
  return wb.toJSON();
};

module.exports.OVERVIEW_ID = OVERVIEW_ID;
