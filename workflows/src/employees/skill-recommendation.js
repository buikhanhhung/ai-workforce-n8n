// Employee 5 — Operations: recommends which employee/skill/workflow fits a task, using the live
// employee catalog from PostgreSQL (recommendations outside the catalog are rejected).
module.exports = {
  employee_id: 'emp_skill_recommender',
  employee_name: 'Skill Recommendation Agent',
  department_id: 'dept_operations',
  job_title: 'Workforce Capability Advisor',
  description: 'Analyzes a task and recommends the right AI employee, skill and workflow, with rationale, prerequisites, capability gaps and execution steps.',
  workflow_id: 'wfcEmpSkillRec01',
  skills: [
    { skill_name: 'task_analysis', description: 'Break a request into required capabilities' },
    { skill_name: 'capability_matching', description: 'Match capabilities to employees and skills in the catalog' },
    { skill_name: 'gap_analysis', description: 'Identify missing prerequisites and capability gaps' },
  ],
  input_schema: {
    type: 'object',
    'x-primary-input': 'task_description',
    'x-input-hint': 'Mô tả việc cần tìm người phù hợp…',
    properties: {
      task_description: { type: 'string', description: 'Defaults to the task description' },
      constraints: { type: 'string' },
    },
  },
  output_schema: {
    type: 'object',
    properties: {
      recommended_employee_id: { type: 'string', description: 'Must be an employee_id from the catalog, or empty if none fits' },
      recommended_skills: { type: 'array', items: { type: 'string' } },
      rationale: { type: 'string' },
      prerequisites: { type: 'array', items: { type: 'string' } },
      capability_gaps: { type: 'array', items: { type: 'string' } },
      execution_steps: { type: 'array', items: { type: 'string' } },
      alternatives: {
        type: 'array',
        items: { type: 'object', properties: { employee_id: { type: 'string' }, reason: { type: 'string' } }, required: ['employee_id', 'reason'] },
      },
      confidence: { type: 'number', description: '0 to 1' },
    },
    required: ['recommended_employee_id', 'recommended_skills', 'rationale', 'prerequisites', 'capability_gaps', 'execution_steps', 'confidence'],
  },
  system_message: [
    'You are the Skill Recommendation Agent in the Operations department.',
    'Recommend the best employee and skills for the task using ONLY the employee catalog provided.',
    '- recommended_employee_id must be an employee_id from the catalog; if nothing fits, return an empty string and explain the gap.',
    '- recommended_skills must be skill names of the recommended employee.',
    '- List concrete prerequisites (inputs, integrations, approvals) and capability gaps.',
  ].join('\n'),
  temperature: 0.2,

  validate: function () {
    const p = taskPayload();
    const description = textOf(directInput(p, ['task_description', 'task', 'request'])) || textOf(p.task && p.task.description);
    if (description.trim().length < 10) return invalid(['task_description must describe the task (at least 10 characters).']);
    return valid({ task_description: clip(description, 8000), constraints: textOf(directInput(p, ['constraints'])) });
  },

  prefetch(wb, [x, y]) {
    const name = wb.pg('Load Employee Catalog',
      `SELECT coalesce(jsonb_agg(jsonb_build_object(
          'employee_id', e.employee_id, 'employee_name', e.employee_name, 'department_id', e.department_id,
          'job_title', e.job_title, 'description', e.description, 'workflow_reference', e.workflow_reference,
          'current_status', e.current_status,
          'skills', (SELECT jsonb_agg(jsonb_build_object('skill_name', s.skill_name, 'description', s.description))
                     FROM wf.employee_skills s WHERE s.employee_id = e.employee_id))), '[]') AS catalog
       FROM wf.employees e`, null, [x, y]);
    return { first: name, last: name };
  },

  buildPrompt: function () {
    const v = $('Validate Task Input').first().json;
    const catalog = $('Load Employee Catalog').first().json.catalog;
    const prompt = [
      taskBrief(taskPayload()),
      `## Task to analyze\n${v.task_description}`,
      v.constraints ? `Constraints: ${v.constraints}` : '',
      `## Employee catalog\n${JSON.stringify(catalog.map(({ workflow_reference, ...e }) => e), null, 2)}`,
    ].filter(Boolean).join('\n\n');
    return [{ json: { prompt } }];
  },

  postprocess: function () {
    const out = $json.output;
    const catalog = $('Load Employee Catalog').first().json.catalog;
    if (!out) return failed('invalid_ai_output', 'model returned no recommendation', true);
    const warnings = [];
    const gaps = Array.isArray(out.capability_gaps) ? [...out.capability_gaps] : [];
    let employee = catalog.find((e) => e.employee_id === out.recommended_employee_id);
    if (out.recommended_employee_id && !employee) {
      warnings.push(`model recommended unknown employee "${out.recommended_employee_id}"; recommendation removed`);
      gaps.push('No catalog employee matched the recommendation');
    }
    if (employee && employee.current_status !== 'available') {
      warnings.push(`${employee.employee_id} is ${employee.current_status}`);
    }
    const known = employee ? (employee.skills || []).map((s) => s.skill_name) : [];
    const skills = (out.recommended_skills || []).filter((s) => known.includes(s));
    if (employee && skills.length < (out.recommended_skills || []).length) warnings.push('skills not owned by the employee were removed');
    const alternatives = (out.alternatives || []).filter((a) => catalog.some((e) => e.employee_id === a.employee_id));
    return done({
      ...out,
      recommended_employee_id: employee ? employee.employee_id : null,
      recommended_employee_name: employee ? employee.employee_name : null,
      workflow_reference: employee ? employee.workflow_reference : null,  // from the catalog, never from the model
      recommended_skills: skills,
      capability_gaps: gaps,
      alternatives,
      confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0)),
    }, warnings);
  },
};
