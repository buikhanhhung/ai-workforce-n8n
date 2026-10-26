-- Planning is a persisted state: a request becomes a plan row with status 'planning' as soon as it
-- is accepted, so every client (after F5, other tabs) sees that the CEO is busy. Only one request
-- may be in planning at a time. Idempotent; applied after schema.sql.

-- Existing databases: widen the status constraint to include 'planning'.
ALTER TABLE wf.plans DROP CONSTRAINT IF EXISTS plans_status_check;
ALTER TABLE wf.plans ADD CONSTRAINT plans_status_check CHECK (status IN
  ('planning', 'rejected', 'running', 'reviewing', 'awaiting_approval', 'completed', 'blocked', 'failed', 'cancelled'));

-- At most one plan in 'planning' per scope: the whole company (CEO, department_id NULL) or one
-- department (its manager). Atomic guard against two requests arriving together.
DROP INDEX IF EXISTS wf.plans_one_planning_idx;
CREATE UNIQUE INDEX IF NOT EXISTS plans_one_planning_per_scope_idx
  ON wf.plans ((coalesce(department_id, ''))) WHERE status = 'planning';

DROP FUNCTION IF EXISTS wf.try_start_planning(text, jsonb, int);
CREATE OR REPLACE FUNCTION wf.try_start_planning(p_objective text, p_request jsonb, p_max_revision_cycles int DEFAULT 1,
                                                 p_department text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_plan uuid;
  v_busy wf.plans;
  v_who text;
BEGIN
  IF p_department IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wf.departments WHERE department_id = p_department) THEN
    RETURN wf.error_result('22023', format('unknown department %s', p_department));
  END IF;
  v_who := CASE WHEN p_department IS NULL THEN 'CEO'
                ELSE 'Trưởng phòng ' || (SELECT name FROM wf.departments WHERE department_id = p_department) END;
  SELECT * INTO v_busy FROM wf.plans
  WHERE status = 'planning' AND department_id IS NOT DISTINCT FROM p_department LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'status', 409, 'error', jsonb_build_object(
      'code', 'planner_busy', 'message', v_who || ' đang lập kế hoạch cho một yêu cầu khác, hãy chờ xong rồi gửi tiếp',
      'planning_plan_id', v_busy.plan_id, 'since', v_busy.created_at));
  END IF;
  INSERT INTO wf.plans (objective, request, status, status_reason, max_revision_cycles, department_id)
  VALUES (p_objective, coalesce(p_request, '{}'), 'planning', v_who || ' is planning',
          least(greatest(coalesce(p_max_revision_cycles, 1), 0), 3), p_department)
  RETURNING plan_id INTO v_plan;
  PERFORM wf.log_event(v_plan, NULL, 'planning_started', jsonb_build_object('department_id', p_department));
  RETURN jsonb_build_object('ok', true, 'plan_id', v_plan, 'department_id', p_department);
EXCEPTION WHEN unique_violation THEN
  -- lost the race against a request inserted at the same moment
  RETURN jsonb_build_object('ok', false, 'status', 409, 'error', jsonb_build_object(
    'code', 'planner_busy', 'message', coalesce(v_who, 'CEO') || ' đang lập kế hoạch cho một yêu cầu khác, hãy chờ xong rồi gửi tiếp'));
END $$;

-- Validated planner output -> tasks; the plan starts running. Any violation rolls the tasks back
-- and leaves the plan in 'planning' for wf.reject_planning.
CREATE OR REPLACE FUNCTION wf.try_finish_planning(p_plan uuid, p_plan_json jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
  v_state text;
  v_msg text;
BEGIN
  PERFORM 1 FROM wf.plans WHERE plan_id = p_plan AND status = 'planning' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN wf.error_result('55000', 'plan is no longer planning (timed out or cancelled)');
  END IF;
  v_count := wf.insert_tasks(p_plan, p_plan_json->'tasks', 0);
  UPDATE wf.plans SET status = 'running', status_reason = NULL, plan_summary = p_plan_json->>'plan_summary'
  WHERE plan_id = p_plan;
  PERFORM wf.log_event(p_plan, NULL, 'plan_created', jsonb_build_object('task_count', v_count));
  RETURN jsonb_build_object('ok', true, 'plan_id', p_plan, 'status', 'running', 'task_count', v_count);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  RETURN wf.error_result(v_state, v_msg);
END $$;

CREATE OR REPLACE FUNCTION wf.reject_planning(p_plan uuid, p_errors jsonb, p_raw_plan jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  UPDATE wf.plans SET status = 'rejected', status_reason = 'plan validation failed',
         validation_errors = p_errors, raw_plan = p_raw_plan
  WHERE plan_id = p_plan AND status = 'planning';
  PERFORM wf.log_event(p_plan, NULL, 'plan_rejected', jsonb_build_object('errors', p_errors));
  RETURN jsonb_build_object('plan_id', p_plan, 'status', 'rejected', 'errors', p_errors);
END $$;
