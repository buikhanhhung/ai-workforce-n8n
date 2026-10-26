// The organization: departments and their AI employees. Add an employee by creating a module in
// ./employees and listing it here; the build generates its workflow and its database seed row.
const departments = [
  { department_id: 'dept_marketing', name: 'Marketing', purpose: 'Content production, brand development and content repurposing.' },
  { department_id: 'dept_operations', name: 'Operations', purpose: 'Internal systems, process improvement and automation.' },
  { department_id: 'dept_customer_success', name: 'Customer Success & Community', purpose: 'Community management, customer support and coaching media coordination.' },
];

const employees = [
  require('./employees/youtube-to-linkedin'),
  require('./employees/repurpose-studio'),
  require('./employees/visual-design'),
  require('./employees/wecommitdw-system-checker'),
  require('./employees/skill-recommendation'),
  require('./employees/circle-community-checker'),
  require('./employees/coaching-timeline'),
  require('./employees/knowledge-support'),
];

module.exports = { departments, employees };
