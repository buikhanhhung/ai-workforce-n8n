-- Content library: every output the employees produced, browsable per department, with a shared
-- management status (new / used / archived). Idempotent; applied after publishing.sql.

-- A task without a row here is 'new'. Rows are written only when someone changes the status.
CREATE TABLE IF NOT EXISTS wf.library_items (
  plan_id    uuid NOT NULL,
  task_id    text NOT NULL,
  status     text NOT NULL CHECK (status IN ('new', 'used', 'archived')),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, task_id),
  FOREIGN KEY (plan_id, task_id) REFERENCES wf.tasks ON DELETE CASCADE
);

-- Display title of an output; NULL lets the caller fall back to the task name.
CREATE OR REPLACE FUNCTION wf.output_title(o jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT left(coalesce(
    nullif(o->>'title', ''),
    nullif(o->'card'->>'headline', ''),
    nullif(o->>'concept_title', ''),
    nullif(o->>'video_title', ''),
    CASE WHEN o ? 'findings' THEN 'Kiểm tra hệ thống ' || coalesce(nullif(o->>'system_name', ''), '') END,
    CASE WHEN o ? 'recommended_employee_id' THEN 'Đề xuất nhân sự: ' || coalesce(nullif(o->>'recommended_employee_name', ''), 'không có ai phù hợp') END,
    nullif(o->>'core_message', '')), 160);
$$;

-- Where the plan stands in the human approval flow, as seen from the library.
CREATE OR REPLACE FUNCTION wf.library_approval(p_plan_status text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_plan_status WHEN 'completed' THEN 'approved' WHEN 'awaiting_approval' THEN 'awaiting'
                            WHEN 'rejected' THEN 'rejected' WHEN 'cancelled' THEN 'cancelled' WHEN 'failed' THEN 'cancelled'
                            ELSE 'in_progress' END;
$$;

-- p_status: 'active' (default: new + used), 'new', 'used', 'archived' or 'all'.
-- p_approval: NULL or one of wf.library_approval()'s values. p_q: case-insensitive text search.
CREATE OR REPLACE FUNCTION wf.api_library(p_department text, p_employee text, p_status text, p_approval text,
                                          p_q text, p_limit int, p_offset int)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_status text := coalesce(nullif(p_status, ''), 'active');
  v_q text := lower(nullif(trim(coalesce(p_q, '')), ''));
  v_limit int := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v jsonb;
BEGIN
  IF v_status NOT IN ('active', 'new', 'used', 'archived', 'all') THEN
    RAISE EXCEPTION 'status must be active, new, used, archived or all' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_approval IS NOT NULL AND p_approval NOT IN ('approved', 'awaiting', 'rejected', 'cancelled', 'in_progress') THEN
    RAISE EXCEPTION 'approval must be approved, awaiting, rejected, cancelled or in_progress' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH items AS (
    SELECT t.plan_id, t.task_id, t.task_name, t.assigned_employee_id AS employee_id, e.employee_name,
           t.department_id, p.objective, p.status AS plan_status, wf.library_approval(p.status) AS approval,
           coalesce(li.status, 'new') AS status, li.updated_by, li.updated_at,
           o.output, o.created_at,
           coalesce(wf.output_title(o.output), t.task_name) AS title, wf.output_summary(o.output) AS summary
    FROM wf.tasks t
    JOIN wf.plans p USING (plan_id)
    JOIN wf.employees e ON e.employee_id = t.assigned_employee_id
    JOIN LATERAL (SELECT x.output, x.created_at FROM wf.task_outputs x
                  WHERE x.plan_id = t.plan_id AND x.task_id = t.task_id ORDER BY x.created_at DESC LIMIT 1) o ON true
    LEFT JOIN wf.library_items li ON li.plan_id = t.plan_id AND li.task_id = t.task_id
    WHERE (p_department IS NULL OR t.department_id = p_department)
      AND (p_employee IS NULL OR t.assigned_employee_id = p_employee)
      AND (p_approval IS NULL OR wf.library_approval(p.status) = p_approval)
      AND (v_q IS NULL OR position(v_q IN lower(concat_ws(' ', t.task_name, p.objective, o.output::text))) > 0)
  ), picked AS (
    SELECT * FROM items
    WHERE v_status = 'all' OR status = v_status OR (v_status = 'active' AND status <> 'archived')
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM picked),
    'counts', jsonb_build_object('new', count(*) FILTER (WHERE i.status = 'new'), 'used', count(*) FILTER (WHERE i.status = 'used'),
                                 'archived', count(*) FILTER (WHERE i.status = 'archived'), 'all', count(*)),
    'limit', v_limit, 'offset', v_offset,
    'items', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'plan_id', s.plan_id, 'task_id', s.task_id, 'task_name', s.task_name, 'title', s.title, 'summary', s.summary,
                'employee_id', s.employee_id, 'employee_name', s.employee_name, 'department_id', s.department_id,
                'objective', s.objective, 'approval', s.approval, 'status', s.status,
                'status_by', s.updated_by, 'status_at', s.updated_at, 'created_at', s.created_at,
                'thumbnail_url', s.output->'asset_urls'->>0,
                'published_url', (SELECT x.url FROM wf.publications x
                                  WHERE x.plan_id = s.plan_id AND x.task_id = s.task_id AND x.status = 'published'
                                  ORDER BY x.published_at DESC LIMIT 1))
                ORDER BY s.created_at DESC, s.task_id), '[]')
              FROM (SELECT * FROM picked ORDER BY created_at DESC, task_id LIMIT v_limit OFFSET v_offset) s))
  INTO v
  FROM items i;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION wf.set_library_status(p_plan uuid, p_task text, p_status text, p_by text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_old text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('new', 'used', 'archived') THEN
    RAISE EXCEPTION 'status must be new, used or archived' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF coalesce(trim(p_by), '') = '' THEN
    RAISE EXCEPTION 'updated_by is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM wf.task_outputs WHERE plan_id = p_plan AND task_id = p_task) THEN
    RAISE EXCEPTION 'task %/% has no output', p_plan, p_task USING ERRCODE = 'no_data_found';
  END IF;
  SELECT status INTO v_old FROM wf.library_items WHERE plan_id = p_plan AND task_id = p_task FOR UPDATE;
  INSERT INTO wf.library_items (plan_id, task_id, status, updated_by)
  VALUES (p_plan, p_task, p_status, trim(p_by))
  ON CONFLICT (plan_id, task_id) DO UPDATE SET status = EXCLUDED.status, updated_by = EXCLUDED.updated_by, updated_at = now();
  PERFORM wf.log_event(p_plan, p_task, 'library_status_changed',
                       jsonb_build_object('from', coalesce(v_old, 'new'), 'to', p_status, 'by', trim(p_by)));
  RETURN jsonb_build_object('plan_id', p_plan, 'task_id', p_task, 'status', p_status, 'previous_status', coalesce(v_old, 'new'));
END $$;
