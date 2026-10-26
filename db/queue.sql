-- Company-wide work queue. Each employee works on at most employees.max_concurrent tasks at a time;
-- the rest wait. Order: CEO (company) plans first, then department plans; within a level by task
-- priority, then first come first served. Idempotent; applied after schema.sql.

CREATE OR REPLACE FUNCTION wf.claim_next_tasks(p_max_running_per_plan int DEFAULT 3)
RETURNS TABLE (execution_id uuid, plan_id uuid, task_id text, assigned_employee_id text,
               workflow_reference text, attempt int)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  c record;
  v_busy int;
  v_plan_running int;
  v_exec uuid;
BEGIN
  -- One claimer at a time, so the capacity counts below always include every claim made so far.
  PERFORM pg_advisory_xact_lock(hashtext('wf.claim_next_tasks'));
  FOR c IN
    SELECT t.plan_id, t.task_id, t.assigned_employee_id, t.retry_count, e.workflow_reference, e.max_concurrent,
           p.department_id IS NULL AS ceo
    FROM wf.tasks t
    JOIN wf.plans p ON p.plan_id = t.plan_id
    JOIN wf.employees e ON e.employee_id = t.assigned_employee_id
    WHERE t.status = 'ready' AND p.status = 'running' AND coalesce(t.not_before, now()) <= now()
    ORDER BY (p.department_id IS NOT NULL),
             CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
             p.created_at, t.created_at, t.task_id
  LOOP
    SELECT count(*) INTO v_busy FROM wf.tasks x WHERE x.assigned_employee_id = c.assigned_employee_id AND x.status = 'running';
    CONTINUE WHEN v_busy >= c.max_concurrent;
    SELECT count(*) INTO v_plan_running FROM wf.tasks x WHERE x.plan_id = c.plan_id AND x.status = 'running';
    CONTINUE WHEN v_plan_running >= p_max_running_per_plan;

    UPDATE wf.tasks x SET status = 'running', started_at = now(), not_before = NULL, status_reason = NULL
    WHERE x.plan_id = c.plan_id AND x.task_id = c.task_id AND x.status = 'ready';
    CONTINUE WHEN NOT FOUND;
    INSERT INTO wf.task_executions (plan_id, task_id, attempt, status)
    VALUES (c.plan_id, c.task_id, c.retry_count + 1, 'running')
    RETURNING task_executions.execution_id INTO v_exec;
    PERFORM wf.log_event(c.plan_id, c.task_id, 'task_claimed',
      jsonb_build_object('execution_id', v_exec, 'attempt', c.retry_count + 1, 'queue', CASE WHEN c.ceo THEN 'ceo' ELSE 'department' END));

    execution_id := v_exec;
    plan_id := c.plan_id;
    task_id := c.task_id;
    assigned_employee_id := c.assigned_employee_id;
    workflow_reference := c.workflow_reference;
    attempt := c.retry_count + 1;
    RETURN NEXT;
  END LOOP;
END $$;
