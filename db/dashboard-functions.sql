-- Read models and actions used by the dashboard UI (exposed through wf.api in schema.sql).
-- Idempotent; applied after schema.sql.

-- One-line human summary of an employee output (dashboard cards and result lists).
CREATE OR REPLACE FUNCTION wf.output_summary(o jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT left(regexp_replace(coalesce(
    CASE WHEN o ? 'escalate' AND (o->>'escalate')::boolean THEN
      'Chuyển người xử lý: ' || coalesce(nullif(o->>'escalation_reason', ''), 'chưa đủ căn cứ để trả lời') END,
    CASE WHEN o ? 'findings' THEN format('Sức khỏe hệ thống: %s · %s phát hiện. %s', o->>'overall_health',
                                         jsonb_array_length(o->'findings'), coalesce(o->'findings'->0->>'title', '')) END,
    CASE WHEN o ? 'chapters' THEN format('%s chương, %s highlight. Mở đầu: %s', jsonb_array_length(o->'chapters'),
                                         jsonb_array_length(coalesce(o->'highlights', '[]')), coalesce(o->'chapters'->0->>'title', '')) END,
    CASE WHEN o ? 'assets' THEN format('%s nội dung: %s', jsonb_array_length(o->'assets'),
                                       (SELECT string_agg(a->>'format', ', ') FROM jsonb_array_elements(o->'assets') a)) END,
    CASE WHEN o ? 'recommended_employee_id' THEN format('Đề xuất: %s. %s', coalesce(o->>'recommended_employee_name', 'không có'), o->>'rationale') END,
    CASE WHEN o ? 'card' THEN format('%s%s — %s', CASE WHEN (o->>'image_generated')::boolean THEN '🖼 ' ELSE '' END,
                                     o->'card'->>'headline', o->>'visual_concept') END,
    CASE WHEN o ? 'image_generation_prompt' THEN format('%s — %s', o->>'concept_title', o->>'visual_concept') END,
    CASE WHEN o ? 'post' THEN format('%s — %s', o->>'title', o->>'post') END,
    nullif(o->>'summary', ''), nullif(o->>'answer', ''), nullif(o->>'executive_summary', ''), o::text), '\s+', ' ', 'g'), 320);
$$;

-- What an employee is doing now: running task, next queued task (and what it waits for), last result.
CREATE OR REPLACE FUNCTION wf.employee_activity(p_employee text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'current_task', (
      SELECT jsonb_build_object('plan_id', t.plan_id, 'task_id', t.task_id, 'task_name', t.task_name,
                                'started_at', t.started_at, 'retry_count', t.retry_count,
                                'for', CASE WHEN p.department_id IS NULL THEN 'ceo' ELSE 'department' END)
      FROM wf.tasks t JOIN wf.plans p USING (plan_id)
      WHERE t.assigned_employee_id = p_employee AND t.status = 'running'
      ORDER BY t.started_at LIMIT 1),
    -- tasks whose prerequisites are done but wait for this employee to be free
    'queue', (
      SELECT jsonb_build_object('waiting', count(*), 'ceo', count(*) FILTER (WHERE p.department_id IS NULL),
                                'department', count(*) FILTER (WHERE p.department_id IS NOT NULL),
                                'running', (SELECT count(*) FROM wf.tasks r WHERE r.assigned_employee_id = p_employee AND r.status = 'running'),
                                'capacity', (SELECT max_concurrent FROM wf.employees WHERE employee_id = p_employee))
      FROM wf.tasks t JOIN wf.plans p USING (plan_id)
      WHERE t.assigned_employee_id = p_employee AND t.status = 'ready' AND p.status = 'running'),
    'queued_task', (
      SELECT jsonb_build_object('plan_id', t.plan_id, 'task_id', t.task_id, 'task_name', t.task_name, 'status', t.status,
        'step', (SELECT count(*) FROM wf.tasks x WHERE x.plan_id = t.plan_id AND (x.created_at, x.task_id) <= (t.created_at, t.task_id)),
        'total_steps', (SELECT count(*) FROM wf.tasks x WHERE x.plan_id = t.plan_id),
        'waiting_for', (SELECT coalesce(jsonb_agg(jsonb_build_object('task_id', dt.task_id, 'employee_name', de.employee_name,
                                                                     'status', dt.status) ORDER BY dt.task_id), '[]')
                        FROM wf.task_dependencies d
                        JOIN wf.tasks dt ON dt.plan_id = d.plan_id AND dt.task_id = d.depends_on_task_id
                        JOIN wf.employees de ON de.employee_id = dt.assigned_employee_id
                        WHERE d.plan_id = t.plan_id AND d.task_id = t.task_id AND dt.status <> 'completed'))
      FROM wf.tasks t JOIN wf.plans p USING (plan_id)
      WHERE t.assigned_employee_id = p_employee AND t.status IN ('pending', 'ready', 'blocked', 'awaiting_approval')
        AND p.status IN ('running', 'blocked')
      ORDER BY t.created_at LIMIT 1),
    'last_result', (
      SELECT jsonb_build_object('plan_id', o.plan_id, 'task_id', o.task_id, 'task_name', t.task_name,
                                'completed_at', o.created_at, 'summary', wf.output_summary(o.output),
                                'asset_url', o.output->'asset_urls'->>0)
      FROM wf.task_outputs o JOIN wf.tasks t USING (plan_id, task_id)
      WHERE t.assigned_employee_id = p_employee
      ORDER BY o.created_at DESC LIMIT 1),
    'last_failure', (
      SELECT jsonb_build_object('plan_id', t.plan_id, 'task_id', t.task_id, 'message', t.last_error->>'message', 'at', t.updated_at)
      FROM wf.tasks t JOIN wf.plans p USING (plan_id)
      WHERE t.assigned_employee_id = p_employee AND t.status = 'failed' AND p.status IN ('running', 'blocked')
      ORDER BY t.updated_at DESC LIMIT 1));
$$;

-- Dashboard "Giao lại" box: a one-task plan for one employee, skipping the CEO planner (the CEO
-- review and human approval still apply). The text goes into the employee's primary input,
-- declared in its input_schema as "x-primary-input".
DROP FUNCTION IF EXISTS wf.create_direct_task(text, text, text);
-- p_department: NULL = assigned by the CEO (company queue priority), else the requesting department,
-- which must be the employee's own department.
CREATE OR REPLACE FUNCTION wf.create_direct_task(p_employee text, p_text text, p_requested_by text, p_department text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  e wf.employees;
  v_text text := trim(coalesce(p_text, ''));
  v_key text;
  v_result jsonb;
BEGIN
  IF length(v_text) < 3 OR length(v_text) > 100000 THEN
    RAISE EXCEPTION 'text must be 3-100000 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO e FROM wf.employees WHERE employee_id = p_employee;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'employee % not found', p_employee USING ERRCODE = 'no_data_found';
  END IF;
  IF p_department IS NOT NULL AND p_department <> e.department_id THEN
    RAISE EXCEPTION 'employee % belongs to %, not %', e.employee_id, e.department_id, p_department
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_key := coalesce(e.input_schema->>'x-primary-input', 'source_text');
  v_result := wf.create_plan(
    format('Giao trực tiếp cho %s: %s', e.employee_name, left(v_text, 300)),
    jsonb_build_object('requested_by', coalesce(nullif(trim(p_requested_by), ''), 'dashboard'), 'direct', true, 'context', '{}'::jsonb),
    jsonb_build_object('plan_summary', 'Giao trực tiếp cho ' || e.employee_name, 'tasks', jsonb_build_array(jsonb_build_object(
      'task_id', 'T1', 'task_name', 'Việc giao trực tiếp', 'description', left(v_text, 2000),
      'assigned_employee_id', e.employee_id, 'department_id', e.department_id,
      'input_data', jsonb_build_object(v_key, v_text), 'depends_on', '[]'::jsonb,
      'expected_output', 'Kết quả theo đúng vai trò của ' || e.employee_name,
      'acceptance_criteria', jsonb_build_array('Thực hiện đúng yêu cầu được giao: ' || left(v_text, 300)),
      'priority', 'high', 'max_retries', 2))),
    0);
  UPDATE wf.plans SET department_id = p_department WHERE plan_id = (v_result->>'plan_id')::uuid;
  RETURN v_result || jsonb_build_object('department_id', p_department);
END $$;

DROP FUNCTION IF EXISTS wf.api_recent_results(int);
CREATE OR REPLACE FUNCTION wf.api_recent_results(p_limit int DEFAULT 10, p_department text DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('results', coalesce(jsonb_agg(r ORDER BY r->>'completed_at' DESC), '[]')) FROM (
    SELECT jsonb_build_object('plan_id', o.plan_id, 'task_id', o.task_id, 'task_name', t.task_name,
                              'employee_id', t.assigned_employee_id, 'employee_name', e.employee_name,
                              'department_id', t.department_id, 'completed_at', o.created_at,
                              'summary', wf.output_summary(o.output)) AS r
    FROM wf.task_outputs o
    JOIN wf.tasks t USING (plan_id, task_id)
    JOIN wf.employees e ON e.employee_id = t.assigned_employee_id
    WHERE p_department IS NULL OR t.department_id = p_department
    ORDER BY o.created_at DESC
    LIMIT least(greatest(coalesce(p_limit, 10), 1), 50)) s;
$$;

CREATE OR REPLACE FUNCTION wf.api_task_output(p_plan uuid, p_task text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  v jsonb;
BEGIN
  SELECT jsonb_build_object('plan_id', t.plan_id, 'task_id', t.task_id, 'task_name', t.task_name,
                            'description', t.description, 'status', t.status,
                            'employee_id', t.assigned_employee_id, 'employee_name', e.employee_name,
                            'objective', p.objective, 'last_error', t.last_error,
                            'output', o.output, 'produced_at', o.created_at,
                            -- content library (db/library.sql): management status and approval state
                            'department_id', t.department_id, 'approval', wf.library_approval(p.status),
                            'library_status', coalesce((SELECT li.status FROM wf.library_items li
                                                        WHERE li.plan_id = t.plan_id AND li.task_id = t.task_id), 'new'))
  INTO v
  FROM wf.tasks t
  JOIN wf.plans p USING (plan_id)
  JOIN wf.employees e ON e.employee_id = t.assigned_employee_id
  LEFT JOIN LATERAL (SELECT o.output, o.created_at FROM wf.task_outputs o
                     WHERE o.plan_id = t.plan_id AND o.task_id = t.task_id ORDER BY o.created_at DESC LIMIT 1) o ON true
  WHERE t.plan_id = p_plan AND t.task_id = p_task;
  IF v IS NULL THEN
    RAISE EXCEPTION 'task %/% not found', p_plan, p_task USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION wf.api_organization() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('departments', coalesce(jsonb_agg(jsonb_build_object(
    'department_id', d.department_id, 'name', d.name, 'purpose', d.purpose,
    'employees', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'employee_id', e.employee_id, 'employee_name', e.employee_name, 'department_id', e.department_id,
        'job_title', e.job_title, 'description', e.description,
        'skills', (SELECT coalesce(jsonb_agg(jsonb_build_object('skill_name', s.skill_name, 'description', s.description)
                                             ORDER BY s.skill_name), '[]')
                   FROM wf.employee_skills s WHERE s.employee_id = e.employee_id),
        'input_schema', e.input_schema, 'output_schema', e.output_schema,
        'workflow_reference', e.workflow_reference,
        'current_status', CASE WHEN e.current_status = 'disabled' THEN 'disabled'
                               WHEN st.running > 0 THEN 'busy' ELSE 'available' END,
        'stats', jsonb_build_object('running', st.running, 'completed', st.completed, 'failed', st.failed),
        'activity', wf.employee_activity(e.employee_id),
        'execution_history', (
          SELECT coalesce(jsonb_agg(h ORDER BY h->>'started_at' DESC), '[]') FROM (
            SELECT jsonb_build_object('execution_id', x.execution_id, 'plan_id', x.plan_id, 'task_id', x.task_id,
                                      'status', x.status, 'attempt', x.attempt, 'started_at', x.started_at,
                                      'finished_at', x.finished_at, 'error', x.error->>'message') AS h
            FROM wf.task_executions x
            JOIN wf.tasks t ON t.plan_id = x.plan_id AND t.task_id = x.task_id
            WHERE t.assigned_employee_id = e.employee_id
            ORDER BY x.started_at DESC LIMIT 10) hh)
      ) ORDER BY e.employee_id), '[]')
      FROM wf.employees e
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE t.status = 'running') AS running,
               count(*) FILTER (WHERE t.status = 'completed') AS completed,
               count(*) FILTER (WHERE t.status = 'failed') AS failed
        FROM wf.tasks t WHERE t.assigned_employee_id = e.employee_id) st
      WHERE e.department_id = d.department_id)
  ) ORDER BY d.department_id), '[]'))
  FROM wf.departments d;
$$;
