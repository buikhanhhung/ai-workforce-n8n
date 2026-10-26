-- AI Workforce Orchestration: persistent state (source of truth for plans, tasks, executions).
-- Idempotent: safe to re-run. All task state transitions go through the functions below.

CREATE SCHEMA IF NOT EXISTS wf;

-- ───────────────────────────── Organization ─────────────────────────────

CREATE TABLE IF NOT EXISTS wf.departments (
  department_id text PRIMARY KEY CHECK (department_id ~ '^[a-z][a-z0-9_]{2,63}$'),
  name          text NOT NULL,
  purpose       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wf.employees (
  employee_id        text PRIMARY KEY CHECK (employee_id ~ '^[a-z][a-z0-9_]{2,63}$'),
  employee_name      text NOT NULL,
  department_id      text NOT NULL REFERENCES wf.departments,
  job_title          text NOT NULL,
  description        text NOT NULL,
  input_schema       jsonb NOT NULL,
  output_schema      jsonb NOT NULL,
  workflow_reference text NOT NULL,          -- n8n workflow id of the employee workflow
  current_status     text NOT NULL DEFAULT 'available' CHECK (current_status IN ('available', 'disabled')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, department_id)        -- lets tasks enforce employee/department consistency
);

-- How many tasks an employee works on at the same time; extra tasks wait in its queue.
ALTER TABLE wf.employees ADD COLUMN IF NOT EXISTS max_concurrent int NOT NULL DEFAULT 1
  CHECK (max_concurrent BETWEEN 1 AND 5);

CREATE TABLE IF NOT EXISTS wf.employee_skills (
  employee_id text NOT NULL REFERENCES wf.employees ON DELETE CASCADE,
  skill_name  text NOT NULL,
  description text NOT NULL,
  PRIMARY KEY (employee_id, skill_name)
);

-- ───────────────────────────── Plans & tasks ─────────────────────────────

CREATE TABLE IF NOT EXISTS wf.plans (
  plan_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  objective           text NOT NULL,
  request             jsonb NOT NULL DEFAULT '{}',  -- validated request (objective, context, requested_by)
  plan_summary        text,
  status              text NOT NULL CHECK (status IN
                        ('planning', 'rejected', 'running', 'reviewing', 'awaiting_approval', 'completed', 'blocked', 'failed', 'cancelled')),
  status_reason       text,
  validation_errors   jsonb,
  raw_plan            jsonb,                         -- planner output kept for audit when rejected
  revision_cycle      int NOT NULL DEFAULT 0,
  max_revision_cycles int NOT NULL DEFAULT 1 CHECK (max_revision_cycles BETWEEN 0 AND 3),
  review              jsonb,                         -- latest CEO review
  final_report        jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);
CREATE INDEX IF NOT EXISTS plans_status_idx ON wf.plans (status, updated_at);
-- Department that owns the plan (requested from a department tab); NULL = company-wide (CEO).
ALTER TABLE wf.plans ADD COLUMN IF NOT EXISTS department_id text REFERENCES wf.departments;
CREATE INDEX IF NOT EXISTS plans_department_idx ON wf.plans (department_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wf.tasks (
  plan_id              uuid NOT NULL REFERENCES wf.plans ON DELETE CASCADE,
  task_id              text NOT NULL CHECK (task_id ~ '^[A-Za-z0-9_-]{1,40}$'),
  task_name            text NOT NULL,
  description          text NOT NULL,
  assigned_employee_id text NOT NULL,
  department_id        text NOT NULL,
  input_data           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(input_data) = 'object'),
  expected_output      text NOT NULL,
  acceptance_criteria  jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(acceptance_criteria) = 'array'),
  priority             text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN
                         ('pending', 'blocked', 'ready', 'running', 'completed', 'failed', 'cancelled', 'awaiting_approval')),
  retry_count          int NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  max_retries          int NOT NULL DEFAULT 2 CHECK (max_retries BETWEEN 0 AND 5),
  requires_approval    boolean NOT NULL DEFAULT false,
  revision_cycle       int NOT NULL DEFAULT 0,
  not_before           timestamptz,                  -- retry backoff: not claimable before this time
  status_reason        text,
  last_error           jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  completed_at         timestamptz,
  PRIMARY KEY (plan_id, task_id),
  FOREIGN KEY (assigned_employee_id, department_id) REFERENCES wf.employees (employee_id, department_id)
);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON wf.tasks (status);
CREATE INDEX IF NOT EXISTS tasks_employee_idx ON wf.tasks (assigned_employee_id, status);

CREATE TABLE IF NOT EXISTS wf.task_dependencies (
  plan_id            uuid NOT NULL,
  task_id            text NOT NULL,
  depends_on_task_id text NOT NULL,
  PRIMARY KEY (plan_id, task_id, depends_on_task_id),
  FOREIGN KEY (plan_id, task_id) REFERENCES wf.tasks ON DELETE CASCADE,
  FOREIGN KEY (plan_id, depends_on_task_id) REFERENCES wf.tasks ON DELETE CASCADE,
  CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX IF NOT EXISTS task_deps_reverse_idx ON wf.task_dependencies (plan_id, depends_on_task_id);

CREATE TABLE IF NOT EXISTS wf.task_executions (
  execution_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id          uuid NOT NULL,
  task_id          text NOT NULL,
  attempt          int NOT NULL,
  status           text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'timed_out')),
  n8n_execution_id text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  error            jsonb,
  metadata         jsonb NOT NULL DEFAULT '{}',
  FOREIGN KEY (plan_id, task_id) REFERENCES wf.tasks ON DELETE CASCADE
);
-- Storage-level duplicate-dispatch guard: at most one running execution per task.
CREATE UNIQUE INDEX IF NOT EXISTS task_executions_one_running_idx
  ON wf.task_executions (plan_id, task_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS wf.task_outputs (
  output_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id       uuid NOT NULL,
  task_id       text NOT NULL,
  execution_id  uuid NOT NULL REFERENCES wf.task_executions,
  output        jsonb NOT NULL,
  artifact_refs jsonb NOT NULL DEFAULT '[]',      -- URLs / references to large artifacts
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (plan_id, task_id) REFERENCES wf.tasks ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS task_outputs_task_idx ON wf.task_outputs (plan_id, task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wf.approvals (
  approval_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id       uuid NOT NULL REFERENCES wf.plans ON DELETE CASCADE,
  task_id       text,
  approval_type text NOT NULL CHECK (approval_type IN ('task_output', 'final_deliverables')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  reason        text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  decided_by    text,
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  FOREIGN KEY (plan_id, task_id) REFERENCES wf.tasks ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_idx
  ON wf.approvals (plan_id, coalesce(task_id, '')) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS wf.execution_events (
  event_id   bigserial PRIMARY KEY,
  plan_id    uuid REFERENCES wf.plans ON DELETE CASCADE,
  task_id    text,
  event_type text NOT NULL,
  details    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS execution_events_plan_idx ON wf.execution_events (plan_id, event_id);

-- Approved knowledge used by the Knowledge & Support employee ('simple' config works for any language).
CREATE TABLE IF NOT EXISTS wf.knowledge_articles (
  article_id bigserial PRIMARY KEY,
  title      text NOT NULL,
  content    text NOT NULL,
  source_url text,
  tags       text[] NOT NULL DEFAULT '{}',
  approved   boolean NOT NULL DEFAULT false,
  search     tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_articles_search_idx ON wf.knowledge_articles USING gin (search);

-- ───────────────────────────── Integrity guards ─────────────────────────────

-- Only legal status transitions are accepted, whatever the caller (AI output never sets status directly).
CREATE OR REPLACE FUNCTION wf.guard_task_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed text[];
BEGIN
  NEW.updated_at := now();
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  allowed := CASE OLD.status
    WHEN 'pending'           THEN ARRAY['ready', 'blocked', 'cancelled']
    WHEN 'blocked'           THEN ARRAY['pending', 'cancelled']
    WHEN 'ready'             THEN ARRAY['running', 'cancelled']
    WHEN 'running'           THEN ARRAY['completed', 'failed', 'ready', 'awaiting_approval', 'cancelled']
    WHEN 'awaiting_approval' THEN ARRAY['completed', 'failed', 'cancelled']
    WHEN 'failed'            THEN ARRAY['pending', 'cancelled']
    ELSE ARRAY[]::text[]     -- completed and cancelled are terminal
  END;
  IF NOT (NEW.status = ANY (allowed)) THEN
    RAISE EXCEPTION 'invalid task status transition % -> % (task %/%)', OLD.status, NEW.status, OLD.plan_id, OLD.task_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tasks_guard_transition ON wf.tasks;
CREATE TRIGGER tasks_guard_transition BEFORE UPDATE ON wf.tasks
  FOR EACH ROW EXECUTE FUNCTION wf.guard_task_transition();

CREATE OR REPLACE FUNCTION wf.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS plans_touch ON wf.plans;
CREATE TRIGGER plans_touch BEFORE UPDATE ON wf.plans FOR EACH ROW EXECUTE FUNCTION wf.touch_updated_at();

CREATE OR REPLACE FUNCTION wf.log_event(p_plan uuid, p_task text, p_type text, p_details jsonb DEFAULT '{}')
RETURNS void LANGUAGE sql AS $$
  INSERT INTO wf.execution_events (plan_id, task_id, event_type, details)
  VALUES (p_plan, p_task, p_type, coalesce(p_details, '{}'));
$$;

-- Returns the first dependency cycle found in a plan as a path of task ids, or NULL.
CREATE OR REPLACE FUNCTION wf.find_dependency_cycle(p_plan uuid) RETURNS text[] LANGUAGE sql STABLE AS $$
  WITH RECURSIVE walk(cur, path, is_cycle) AS (
    SELECT d.depends_on_task_id, ARRAY[d.task_id, d.depends_on_task_id], false
    FROM wf.task_dependencies d WHERE d.plan_id = p_plan
    UNION ALL
    SELECT d.depends_on_task_id, w.path || d.depends_on_task_id, d.depends_on_task_id = ANY (w.path)
    FROM walk w
    JOIN wf.task_dependencies d ON d.plan_id = p_plan AND d.task_id = w.cur
    WHERE NOT w.is_cycle
  )
  SELECT path FROM walk WHERE is_cycle LIMIT 1;
$$;

-- ───────────────────────────── Planning ─────────────────────────────

DROP FUNCTION IF EXISTS wf.get_employee_catalog();
-- p_department limits the catalog to one department (department-manager requests).
CREATE OR REPLACE FUNCTION wf.get_employee_catalog(p_department text DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'employee_id', e.employee_id,
           'employee_name', e.employee_name,
           'department_id', e.department_id,
           'job_title', e.job_title,
           'description', e.description,
           'skills', (SELECT coalesce(jsonb_agg(s.skill_name ORDER BY s.skill_name), '[]')
                      FROM wf.employee_skills s WHERE s.employee_id = e.employee_id),
           'input_schema', e.input_schema
         ) ORDER BY e.department_id, e.employee_id), '[]')
  FROM wf.employees e WHERE e.current_status = 'available' AND (p_department IS NULL OR e.department_id = p_department);
$$;

-- Inserts tasks + dependencies from planner JSON. Status, retry_count are never taken from AI output.
CREATE OR REPLACE FUNCTION wf.insert_tasks(p_plan uuid, p_tasks jsonb, p_revision_cycle int)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
  v_cycle text[];
  v_disabled text;
BEGIN
  IF jsonb_typeof(p_tasks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_tasks) = 0 THEN
    RAISE EXCEPTION 'task list must be a non-empty array' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT string_agg(DISTINCT t->>'assigned_employee_id', ', ') INTO v_disabled
  FROM jsonb_array_elements(p_tasks) t
  JOIN wf.employees e ON e.employee_id = t->>'assigned_employee_id'
  WHERE e.current_status <> 'available';
  IF v_disabled IS NOT NULL THEN
    RAISE EXCEPTION 'employees not available: %', v_disabled USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- A department-owned plan may only use that department's employees (also covers revision tasks).
  SELECT string_agg(DISTINCT (t->>'assigned_employee_id') || ' (' || (t->>'department_id') || ')', ', ') INTO v_disabled
  FROM jsonb_array_elements(p_tasks) t
  JOIN wf.plans p ON p.plan_id = p_plan
  WHERE p.department_id IS NOT NULL AND t->>'department_id' IS DISTINCT FROM p.department_id;
  IF v_disabled IS NOT NULL THEN
    RAISE EXCEPTION 'plan belongs to one department; employees from other departments are not allowed: %', v_disabled
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO wf.tasks (plan_id, task_id, task_name, description, assigned_employee_id, department_id,
                        input_data, expected_output, acceptance_criteria, priority, max_retries,
                        requires_approval, revision_cycle)
  SELECT p_plan, t->>'task_id', t->>'task_name', t->>'description', t->>'assigned_employee_id', t->>'department_id',
         coalesce(t->'input_data', '{}'), t->>'expected_output', coalesce(t->'acceptance_criteria', '[]'),
         coalesce(t->>'priority', 'medium'),
         least(greatest(coalesce((t->>'max_retries')::int, 2), 0), 3),
         coalesce((t->>'requires_approval')::boolean, false), p_revision_cycle
  FROM jsonb_array_elements(p_tasks) t;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO wf.task_dependencies (plan_id, task_id, depends_on_task_id)
  SELECT DISTINCT p_plan, t->>'task_id', dep
  FROM jsonb_array_elements(p_tasks) t,
       jsonb_array_elements_text(coalesce(t->'depends_on', '[]')) dep;

  v_cycle := wf.find_dependency_cycle(p_plan);
  IF v_cycle IS NOT NULL THEN
    RAISE EXCEPTION 'circular dependency: %', array_to_string(v_cycle, ' -> ') USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v_count;
END $$;

-- Creates an executable plan atomically (any constraint violation rolls back the whole plan).
CREATE OR REPLACE FUNCTION wf.create_plan(p_objective text, p_request jsonb, p_plan jsonb, p_max_revision_cycles int DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_plan uuid;
  v_count int;
BEGIN
  INSERT INTO wf.plans (objective, request, plan_summary, status, max_revision_cycles)
  VALUES (p_objective, coalesce(p_request, '{}'), p_plan->>'plan_summary', 'running',
          least(greatest(coalesce(p_max_revision_cycles, 1), 0), 3))
  RETURNING plan_id INTO v_plan;

  v_count := wf.insert_tasks(v_plan, p_plan->'tasks', 0);
  PERFORM wf.log_event(v_plan, NULL, 'plan_created', jsonb_build_object('task_count', v_count));
  RETURN jsonb_build_object('plan_id', v_plan, 'status', 'running', 'task_count', v_count);
END $$;

-- Persists a rejected plan with explicit validation errors (audit trail; never executed).
CREATE OR REPLACE FUNCTION wf.record_rejected_plan(p_objective text, p_request jsonb, p_errors jsonb, p_raw_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_plan uuid;
BEGIN
  INSERT INTO wf.plans (objective, request, status, status_reason, validation_errors, raw_plan)
  VALUES (p_objective, coalesce(p_request, '{}'), 'rejected', 'plan validation failed', p_errors, p_raw_plan)
  RETURNING plan_id INTO v_plan;
  PERFORM wf.log_event(v_plan, NULL, 'plan_rejected', jsonb_build_object('errors', p_errors));
  RETURN jsonb_build_object('plan_id', v_plan, 'status', 'rejected', 'errors', p_errors);
END $$;

-- ───────────────────────────── Dispatching ─────────────────────────────

-- Re-evaluates dependencies from stored records and advances plan status.
-- review_needed is true for exactly one caller (transition happens under the plan row lock).
CREATE OR REPLACE FUNCTION wf.refresh_plan(p_plan uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_status   text;
  v_changed  int;
  v_n        int;
  v_total    int;
  v_done     int;
  v_active   int;
  v_review   boolean := false;
  v_counts   jsonb;
BEGIN
  SELECT status INTO v_status FROM wf.plans WHERE plan_id = p_plan FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan % not found', p_plan USING ERRCODE = 'no_data_found';
  END IF;

  IF v_status IN ('running', 'blocked') THEN
    LOOP
      v_changed := 0;

      -- prerequisites that can no longer complete block their dependents
      WITH upd AS (
        UPDATE wf.tasks t SET status = 'blocked', status_reason = 'waiting on failed/cancelled/blocked prerequisite'
        WHERE t.plan_id = p_plan AND t.status = 'pending'
          AND EXISTS (SELECT 1 FROM wf.task_dependencies d
                      JOIN wf.tasks p ON p.plan_id = d.plan_id AND p.task_id = d.depends_on_task_id
                      WHERE d.plan_id = t.plan_id AND d.task_id = t.task_id
                        AND p.status IN ('failed', 'cancelled', 'blocked'))
        RETURNING t.plan_id, t.task_id),
      ev AS (INSERT INTO wf.execution_events (plan_id, task_id, event_type)
             SELECT plan_id, task_id, 'task_blocked' FROM upd)
      SELECT count(*) INTO v_n FROM upd;
      v_changed := v_changed + v_n;

      -- unblock when prerequisites were retried
      WITH upd AS (
        UPDATE wf.tasks t SET status = 'pending', status_reason = NULL
        WHERE t.plan_id = p_plan AND t.status = 'blocked'
          AND NOT EXISTS (SELECT 1 FROM wf.task_dependencies d
                          JOIN wf.tasks p ON p.plan_id = d.plan_id AND p.task_id = d.depends_on_task_id
                          WHERE d.plan_id = t.plan_id AND d.task_id = t.task_id
                            AND p.status IN ('failed', 'cancelled', 'blocked'))
        RETURNING t.plan_id, t.task_id),
      ev AS (INSERT INTO wf.execution_events (plan_id, task_id, event_type)
             SELECT plan_id, task_id, 'task_unblocked' FROM upd)
      SELECT count(*) INTO v_n FROM upd;
      v_changed := v_changed + v_n;

      -- ready only when every prerequisite completed successfully
      WITH upd AS (
        UPDATE wf.tasks t SET status = 'ready', status_reason = NULL
        WHERE t.plan_id = p_plan AND t.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM wf.task_dependencies d
                          JOIN wf.tasks p ON p.plan_id = d.plan_id AND p.task_id = d.depends_on_task_id
                          WHERE d.plan_id = t.plan_id AND d.task_id = t.task_id
                            AND p.status <> 'completed')
        RETURNING t.plan_id, t.task_id),
      ev AS (INSERT INTO wf.execution_events (plan_id, task_id, event_type)
             SELECT plan_id, task_id, 'task_ready' FROM upd)
      SELECT count(*) INTO v_n FROM upd;
      v_changed := v_changed + v_n;

      EXIT WHEN v_changed = 0;
    END LOOP;

    SELECT count(*),
           count(*) FILTER (WHERE status = 'completed'),
           count(*) FILTER (WHERE status IN ('pending', 'ready', 'running', 'awaiting_approval'))
      INTO v_total, v_done, v_active
    FROM wf.tasks WHERE plan_id = p_plan;

    IF v_total > 0 AND v_total = v_done THEN
      UPDATE wf.plans SET status = 'reviewing', status_reason = 'all tasks completed' WHERE plan_id = p_plan;
      PERFORM wf.log_event(p_plan, NULL, 'plan_review_started');
      v_status := 'reviewing';
      v_review := true;
    ELSIF v_active = 0 THEN
      IF v_status <> 'blocked' THEN
        UPDATE wf.plans SET status = 'blocked',
               status_reason = 'no runnable tasks remain; retry failed tasks or cancel the plan'
        WHERE plan_id = p_plan;
        PERFORM wf.log_event(p_plan, NULL, 'plan_blocked');
      END IF;
      v_status := 'blocked';
    ELSIF v_status = 'blocked' THEN
      UPDATE wf.plans SET status = 'running', status_reason = NULL WHERE plan_id = p_plan;
      v_status := 'running';
    END IF;
  END IF;

  SELECT coalesce(jsonb_object_agg(status, n), '{}') INTO v_counts
  FROM (SELECT status, count(*) AS n FROM wf.tasks WHERE plan_id = p_plan GROUP BY status) s;

  RETURN jsonb_build_object('plan_id', p_plan, 'plan_status', v_status,
                            'review_needed', v_review, 'task_counts', v_counts);
END $$;

-- Atomically claims ready tasks (ready -> running) and opens an execution record for each.
-- The plan row lock serializes claimers per plan; the status predicate and the unique
-- running-execution index make double claiming impossible.
CREATE OR REPLACE FUNCTION wf.claim_ready_tasks(p_plan uuid, p_max_running int DEFAULT 3)
RETURNS TABLE (execution_id uuid, plan_id uuid, task_id text, assigned_employee_id text,
               workflow_reference text, attempt int)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
BEGIN
  PERFORM 1 FROM wf.plans p WHERE p.plan_id = p_plan AND p.status = 'running' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH cap AS (
    SELECT greatest(p_max_running - count(*), 0) AS n
    FROM wf.tasks t WHERE t.plan_id = p_plan AND t.status = 'running'),
  picked AS (
    SELECT t.plan_id, t.task_id FROM wf.tasks t
    WHERE t.plan_id = p_plan AND t.status = 'ready' AND coalesce(t.not_before, now()) <= now()
    ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
             t.created_at, t.task_id
    LIMIT (SELECT n FROM cap)
    FOR UPDATE SKIP LOCKED),
  claimed AS (
    UPDATE wf.tasks t SET status = 'running', started_at = now(), not_before = NULL, status_reason = NULL
    FROM picked k
    WHERE t.plan_id = k.plan_id AND t.task_id = k.task_id AND t.status = 'ready'
    RETURNING t.plan_id, t.task_id, t.assigned_employee_id, t.retry_count),
  ex AS (
    INSERT INTO wf.task_executions (plan_id, task_id, attempt, status)
    SELECT c.plan_id, c.task_id, c.retry_count + 1, 'running' FROM claimed c
    RETURNING task_executions.execution_id, task_executions.plan_id, task_executions.task_id, task_executions.attempt),
  ev AS (
    INSERT INTO wf.execution_events (plan_id, task_id, event_type, details)
    SELECT x.plan_id, x.task_id, 'task_claimed', jsonb_build_object('execution_id', x.execution_id, 'attempt', x.attempt)
    FROM ex x)
  SELECT x.execution_id, x.plan_id, x.task_id, c.assigned_employee_id, e.workflow_reference, x.attempt
  FROM ex x
  JOIN claimed c ON c.plan_id = x.plan_id AND c.task_id = x.task_id
  JOIN wf.employees e ON e.employee_id = c.assigned_employee_id;
END $$;

-- Called by the task runner before invoking the employee: attaches the n8n execution id and
-- returns the standardized task payload (task, plan context, prerequisite outputs).
CREATE OR REPLACE FUNCTION wf.begin_task_run(p_execution uuid, p_n8n_execution_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  x wf.task_executions;
  t wf.tasks;
  p wf.plans;
  e wf.employees;
BEGIN
  SELECT * INTO x FROM wf.task_executions WHERE execution_id = p_execution FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'execution not found');
  END IF;
  SELECT * INTO t FROM wf.tasks WHERE plan_id = x.plan_id AND task_id = x.task_id;
  IF x.status <> 'running' OR t.status <> 'running' THEN
    RETURN jsonb_build_object('ok', false, 'reason',
      format('execution is %s and task is %s; nothing to run', x.status, t.status));
  END IF;
  UPDATE wf.task_executions SET n8n_execution_id = p_n8n_execution_id WHERE execution_id = p_execution;
  SELECT * INTO p FROM wf.plans WHERE plan_id = x.plan_id;
  SELECT * INTO e FROM wf.employees WHERE employee_id = t.assigned_employee_id;

  RETURN jsonb_build_object(
    'ok', true,
    'execution_id', x.execution_id,
    'attempt', x.attempt,
    'employee', jsonb_build_object('employee_id', e.employee_id, 'employee_name', e.employee_name,
                                   'workflow_reference', e.workflow_reference),
    'task', jsonb_build_object(
      'task_id', t.task_id, 'plan_id', t.plan_id, 'task_name', t.task_name, 'description', t.description,
      'assigned_employee_id', t.assigned_employee_id, 'department_id', t.department_id,
      'input_data', t.input_data, 'expected_output', t.expected_output,
      'acceptance_criteria', t.acceptance_criteria, 'priority', t.priority, 'status', t.status,
      'retry_count', t.retry_count, 'max_retries', t.max_retries, 'revision_cycle', t.revision_cycle,
      'depends_on', (SELECT coalesce(jsonb_agg(d.depends_on_task_id ORDER BY d.depends_on_task_id), '[]')
                     FROM wf.task_dependencies d WHERE d.plan_id = t.plan_id AND d.task_id = t.task_id)),
    'plan', jsonb_build_object('plan_id', p.plan_id, 'objective', p.objective,
                               'context', coalesce(p.request->'context', '{}')),
    'dependency_outputs', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'task_id', dt.task_id, 'task_name', dt.task_name,
               'employee_id', dt.assigned_employee_id, 'output', o.output) ORDER BY dt.task_id), '[]')
      FROM wf.task_dependencies d
      JOIN wf.tasks dt ON dt.plan_id = d.plan_id AND dt.task_id = d.depends_on_task_id
      LEFT JOIN LATERAL (SELECT o.output FROM wf.task_outputs o
                         WHERE o.plan_id = dt.plan_id AND o.task_id = dt.task_id
                         ORDER BY o.created_at DESC LIMIT 1) o ON true
      WHERE d.plan_id = t.plan_id AND d.task_id = t.task_id));
END $$;

-- Records a successful employee result. Rejected if the execution is no longer active
-- (e.g. the plan was cancelled or the execution timed out and was retried).
CREATE OR REPLACE FUNCTION wf.complete_task(p_execution uuid, p_output jsonb, p_metadata jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  x wf.task_executions;
  t wf.tasks;
  v_new text;
BEGIN
  SELECT * INTO x FROM wf.task_executions WHERE execution_id = p_execution FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'execution % not found', p_execution USING ERRCODE = 'no_data_found';
  END IF;
  IF x.status <> 'running' THEN
    RETURN jsonb_build_object('accepted', false, 'plan_id', x.plan_id, 'task_id', x.task_id,
                              'reason', 'execution is ' || x.status);
  END IF;
  SELECT * INTO t FROM wf.tasks WHERE plan_id = x.plan_id AND task_id = x.task_id FOR UPDATE;
  IF t.status <> 'running' THEN
    UPDATE wf.task_executions SET status = 'cancelled', finished_at = now(),
           metadata = metadata || coalesce(p_metadata, '{}')
    WHERE execution_id = p_execution;
    RETURN jsonb_build_object('accepted', false, 'plan_id', x.plan_id, 'task_id', x.task_id,
                              'reason', 'task is ' || t.status);
  END IF;

  v_new := CASE WHEN t.requires_approval THEN 'awaiting_approval' ELSE 'completed' END;
  UPDATE wf.task_executions SET status = 'completed', finished_at = now(),
         metadata = metadata || coalesce(p_metadata, '{}')
  WHERE execution_id = p_execution;
  INSERT INTO wf.task_outputs (plan_id, task_id, execution_id, output, artifact_refs)
  VALUES (x.plan_id, x.task_id, p_execution, p_output,
          CASE WHEN jsonb_typeof(p_output->'asset_urls') = 'array' THEN p_output->'asset_urls' ELSE '[]' END);
  UPDATE wf.tasks SET status = v_new, last_error = NULL, status_reason = NULL,
         completed_at = CASE WHEN v_new = 'completed' THEN now() END
  WHERE plan_id = x.plan_id AND task_id = x.task_id;

  IF v_new = 'awaiting_approval' THEN
    INSERT INTO wf.approvals (plan_id, task_id, approval_type, reason, payload)
    VALUES (x.plan_id, x.task_id, 'task_output', 'Task output requires human approval before it is used downstream',
            jsonb_build_object('execution_id', p_execution));
  END IF;
  PERFORM wf.log_event(x.plan_id, x.task_id, 'task_' || v_new,
                       jsonb_build_object('execution_id', p_execution, 'attempt', x.attempt));
  RETURN jsonb_build_object('accepted', true, 'plan_id', x.plan_id, 'task_id', x.task_id, 'status', v_new);
END $$;

-- Records a failure. Retryable failures go back to ready (with backoff) until max_retries is reached.
CREATE OR REPLACE FUNCTION wf.fail_task(p_execution uuid, p_error jsonb, p_retryable boolean, p_metadata jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  x wf.task_executions;
  t wf.tasks;
  v_retry boolean;
BEGIN
  SELECT * INTO x FROM wf.task_executions WHERE execution_id = p_execution FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'execution % not found', p_execution USING ERRCODE = 'no_data_found';
  END IF;
  IF x.status <> 'running' THEN
    RETURN jsonb_build_object('accepted', false, 'plan_id', x.plan_id, 'task_id', x.task_id,
                              'reason', 'execution is ' || x.status);
  END IF;
  SELECT * INTO t FROM wf.tasks WHERE plan_id = x.plan_id AND task_id = x.task_id FOR UPDATE;

  UPDATE wf.task_executions
  SET status = CASE WHEN p_error->>'code' = 'timeout' THEN 'timed_out' ELSE 'failed' END,
      finished_at = now(), error = p_error, metadata = metadata || coalesce(p_metadata, '{}')
  WHERE execution_id = p_execution;

  IF t.status <> 'running' THEN
    RETURN jsonb_build_object('accepted', false, 'plan_id', x.plan_id, 'task_id', x.task_id,
                              'reason', 'task is ' || t.status);
  END IF;

  v_retry := coalesce(p_retryable, false) AND t.retry_count < t.max_retries;
  UPDATE wf.tasks
  SET status = CASE WHEN v_retry THEN 'ready' ELSE 'failed' END,
      retry_count = retry_count + CASE WHEN v_retry THEN 1 ELSE 0 END,
      not_before = CASE WHEN v_retry THEN now() + make_interval(secs => 20 * (t.retry_count + 1)) END,
      last_error = p_error,
      status_reason = CASE WHEN v_retry THEN 'retry scheduled after failure' ELSE 'failed: ' || coalesce(p_error->>'message', 'unknown error') END
  WHERE plan_id = x.plan_id AND task_id = x.task_id;

  PERFORM wf.log_event(x.plan_id, x.task_id, CASE WHEN v_retry THEN 'task_retry_scheduled' ELSE 'task_failed' END,
                       jsonb_build_object('execution_id', p_execution, 'attempt', x.attempt, 'error', p_error,
                                          'retryable', coalesce(p_retryable, false)));
  RETURN jsonb_build_object('accepted', true, 'plan_id', x.plan_id, 'task_id', x.task_id,
                            'status', CASE WHEN v_retry THEN 'ready' ELSE 'failed' END,
                            'retry_count', t.retry_count + CASE WHEN v_retry THEN 1 ELSE 0 END);
END $$;

-- Scheduled safety net: times out stuck executions, lists plans needing a dispatch pass and
-- reviews that never finished (claimed atomically by bumping updated_at).
CREATE OR REPLACE FUNCTION wf.poll_work(p_execution_timeout interval DEFAULT '15 minutes',
                                        p_review_timeout interval DEFAULT '10 minutes')
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  r record;
  v_reaped int := 0;
  v_dispatch jsonb;
  v_reviews jsonb;
BEGIN
  FOR r IN SELECT execution_id FROM wf.task_executions
           WHERE status = 'running' AND started_at < now() - p_execution_timeout
           FOR UPDATE SKIP LOCKED LOOP
    PERFORM wf.fail_task(r.execution_id,
      jsonb_build_object('code', 'timeout', 'message', 'execution exceeded ' || p_execution_timeout::text), true);
    v_reaped := v_reaped + 1;
  END LOOP;

  -- A planner run that died (n8n restart, crash) must not keep the CEO locked forever.
  WITH stale AS (
    UPDATE wf.plans SET status = 'rejected', status_reason = 'planning did not finish within 10 minutes',
           validation_errors = '["planner run did not finish (timed out)"]'
    WHERE status = 'planning' AND created_at < now() - interval '10 minutes'
    RETURNING plan_id),
  ev AS (INSERT INTO wf.execution_events (plan_id, event_type) SELECT plan_id, 'planning_timed_out' FROM stale)
  SELECT NULL INTO v_reviews;

  -- A publish attempt that never reported back must not block the plan's publishing forever.
  IF to_regclass('wf.publications') IS NOT NULL THEN
    UPDATE wf.publications SET status = 'failed', error = 'publisher did not report back within 10 minutes'
    WHERE status = 'pending' AND created_at < now() - interval '10 minutes';
  END IF;

  SELECT coalesce(jsonb_agg(plan_id), '[]') INTO v_dispatch
  FROM wf.plans WHERE status IN ('running', 'blocked');

  WITH stale AS (
    UPDATE wf.plans SET updated_at = now()
    WHERE status = 'reviewing' AND updated_at < now() - p_review_timeout
    RETURNING plan_id)
  SELECT coalesce(jsonb_agg(plan_id), '[]') INTO v_reviews FROM stale;

  RETURN jsonb_build_object('reaped_executions', v_reaped, 'dispatch_plan_ids', v_dispatch,
                            'stale_review_plan_ids', v_reviews);
END $$;

-- ───────────────────────────── Review ─────────────────────────────

CREATE OR REPLACE FUNCTION wf.get_review_context(p_plan uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'plan_id', p.plan_id, 'objective', p.objective, 'plan_summary', p.plan_summary, 'status', p.status,
    'context', coalesce(p.request->'context', '{}'),
    'revision_cycle', p.revision_cycle, 'max_revision_cycles', p.max_revision_cycles,
    'department_id', p.department_id,
    'employee_ids', (SELECT jsonb_agg(employee_id ORDER BY employee_id) FROM wf.employees
                     WHERE current_status = 'available' AND (p.department_id IS NULL OR department_id = p.department_id)),
    'employee_departments', (SELECT jsonb_object_agg(employee_id, department_id) FROM wf.employees),
    'tasks', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'task_id', t.task_id, 'task_name', t.task_name, 'description', t.description,
               'assigned_employee_id', t.assigned_employee_id, 'status', t.status,
               'revision_cycle', t.revision_cycle,
               'expected_output', t.expected_output, 'acceptance_criteria', t.acceptance_criteria,
               'depends_on', (SELECT coalesce(jsonb_agg(d.depends_on_task_id ORDER BY d.depends_on_task_id), '[]')
                              FROM wf.task_dependencies d WHERE d.plan_id = t.plan_id AND d.task_id = t.task_id),
               'output', (SELECT o.output FROM wf.task_outputs o WHERE o.plan_id = t.plan_id AND o.task_id = t.task_id
                          ORDER BY o.created_at DESC LIMIT 1),
               'last_error', t.last_error) ORDER BY t.created_at, t.task_id), '[]')
      FROM wf.tasks t WHERE t.plan_id = p.plan_id))
  FROM wf.plans p WHERE p.plan_id = p_plan;
$$;

-- Adds reviewer-requested revision tasks (bounded by max_revision_cycles) and resumes execution.
CREATE OR REPLACE FUNCTION wf.add_revision_tasks(p_plan uuid, p_tasks jsonb, p_review jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  p wf.plans;
  v_count int;
BEGIN
  SELECT * INTO p FROM wf.plans WHERE plan_id = p_plan FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan % not found', p_plan USING ERRCODE = 'no_data_found';
  END IF;
  IF p.status <> 'reviewing' THEN
    RAISE EXCEPTION 'plan % is %, not reviewing', p_plan, p.status USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p.revision_cycle >= p.max_revision_cycles THEN
    RAISE EXCEPTION 'revision limit reached (% of %)', p.revision_cycle, p.max_revision_cycles
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  v_count := wf.insert_tasks(p_plan, p_tasks, p.revision_cycle + 1);
  UPDATE wf.plans SET status = 'running', revision_cycle = p.revision_cycle + 1, review = p_review,
         status_reason = 'revision cycle ' || (p.revision_cycle + 1)
  WHERE plan_id = p_plan;
  PERFORM wf.log_event(p_plan, NULL, 'revision_tasks_added',
                       jsonb_build_object('cycle', p.revision_cycle + 1, 'task_count', v_count));
  RETURN jsonb_build_object('plan_id', p_plan, 'status', 'running', 'revision_cycle', p.revision_cycle + 1,
                            'task_count', v_count);
END $$;

-- Stores the final review and requests human approval of the deliverables. Never marks the plan
-- completed on its own: a person must approve publication.
CREATE OR REPLACE FUNCTION wf.finalize_review(p_plan uuid, p_review jsonb, p_final_report jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  p wf.plans;
  v_incomplete text;
  v_approval uuid;
BEGIN
  SELECT * INTO p FROM wf.plans WHERE plan_id = p_plan FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan % not found', p_plan USING ERRCODE = 'no_data_found';
  END IF;
  IF p.status <> 'reviewing' THEN
    RAISE EXCEPTION 'plan % is %, not reviewing', p_plan, p.status USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT string_agg(task_id || ':' || status, ', ') INTO v_incomplete
  FROM wf.tasks WHERE plan_id = p_plan AND status <> 'completed';
  IF v_incomplete IS NOT NULL THEN
    UPDATE wf.plans SET status = 'blocked', review = p_review, status_reason = 'incomplete tasks: ' || v_incomplete
    WHERE plan_id = p_plan;
    PERFORM wf.log_event(p_plan, NULL, 'review_blocked', jsonb_build_object('incomplete', v_incomplete));
    RETURN jsonb_build_object('plan_id', p_plan, 'status', 'blocked', 'incomplete', v_incomplete);
  END IF;

  UPDATE wf.plans SET status = 'awaiting_approval', review = p_review, final_report = p_final_report,
         status_reason = 'final deliverables awaiting human approval'
  WHERE plan_id = p_plan;
  INSERT INTO wf.approvals (plan_id, approval_type, reason, payload)
  VALUES (p_plan, 'final_deliverables', 'Final deliverables require human approval before publication',
          jsonb_build_object('reviewer_verdict', p_review->>'verdict'))
  RETURNING approval_id INTO v_approval;
  PERFORM wf.log_event(p_plan, NULL, 'review_finalized',
                       jsonb_build_object('verdict', p_review->>'verdict', 'approval_id', v_approval));
  RETURN jsonb_build_object('plan_id', p_plan, 'status', 'awaiting_approval', 'approval_id', v_approval);
END $$;

-- Review failures stay in 'reviewing' (the poller retries); after 3 failures the plan fails.
CREATE OR REPLACE FUNCTION wf.mark_review_failed(p_plan uuid, p_error jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_failures int;
BEGIN
  PERFORM wf.log_event(p_plan, NULL, 'review_failed', jsonb_build_object('error', p_error));
  SELECT count(*) INTO v_failures FROM wf.execution_events WHERE plan_id = p_plan AND event_type = 'review_failed';
  IF v_failures >= 3 THEN
    UPDATE wf.plans SET status = 'failed', status_reason = 'CEO review failed 3 times: ' || coalesce(p_error->>'message', '')
    WHERE plan_id = p_plan AND status = 'reviewing';
  END IF;
  RETURN jsonb_build_object('plan_id', p_plan, 'review_failures', v_failures);
END $$;

-- ───────────────────────────── Human actions ─────────────────────────────

CREATE OR REPLACE FUNCTION wf.retry_task(p_plan uuid, p_task text, p_requested_by text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  p wf.plans;
  t wf.tasks;
BEGIN
  IF coalesce(trim(p_requested_by), '') = '' THEN
    RAISE EXCEPTION 'requested_by is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO p FROM wf.plans WHERE plan_id = p_plan FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan % not found', p_plan USING ERRCODE = 'no_data_found';
  END IF;
  IF p.status NOT IN ('running', 'blocked') THEN
    RAISE EXCEPTION 'plan is %; only running or blocked plans accept retries', p.status USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT * INTO t FROM wf.tasks WHERE plan_id = p_plan AND task_id = p_task FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task % not found in plan', p_task USING ERRCODE = 'no_data_found';
  END IF;
  IF t.status <> 'failed' THEN
    RAISE EXCEPTION 'only failed tasks can be retried (task is %)', t.status USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE wf.tasks SET status = 'pending', retry_count = 0, not_before = NULL,
         status_reason = 'manual retry requested by ' || p_requested_by
  WHERE plan_id = p_plan AND task_id = p_task;
  UPDATE wf.plans SET status = 'running', status_reason = NULL WHERE plan_id = p_plan;
  PERFORM wf.log_event(p_plan, p_task, 'task_manual_retry', jsonb_build_object('requested_by', p_requested_by));
  RETURN jsonb_build_object('plan_id', p_plan, 'task_id', p_task, 'status', 'pending');
END $$;

-- Cancels a plan. Running n8n executions are not killed, but their results are discarded
-- because complete_task only accepts executions that are still running.
CREATE OR REPLACE FUNCTION wf.cancel_plan(p_plan uuid, p_requested_by text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  p wf.plans;
  v_tasks int;
  v_execs int;
BEGIN
  IF coalesce(trim(p_requested_by), '') = '' THEN
    RAISE EXCEPTION 'requested_by is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO p FROM wf.plans WHERE plan_id = p_plan FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan % not found', p_plan USING ERRCODE = 'no_data_found';
  END IF;
  IF p.status IN ('completed', 'cancelled', 'rejected') THEN
    RAISE EXCEPTION 'plan is already %', p.status USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE wf.tasks SET status = 'cancelled', status_reason = 'plan cancelled'
  WHERE plan_id = p_plan AND status IN ('pending', 'blocked', 'ready', 'running', 'awaiting_approval');
  GET DIAGNOSTICS v_tasks = ROW_COUNT;
  UPDATE wf.task_executions SET status = 'cancelled', finished_at = now()
  WHERE plan_id = p_plan AND status = 'running';
  GET DIAGNOSTICS v_execs = ROW_COUNT;
  UPDATE wf.approvals SET status = 'cancelled', decided_at = now(), decided_by = p_requested_by
  WHERE plan_id = p_plan AND status = 'pending';
  UPDATE wf.plans SET status = 'cancelled', completed_at = now(),
         status_reason = 'cancelled by ' || p_requested_by || coalesce(': ' || nullif(p_reason, ''), '')
  WHERE plan_id = p_plan;
  PERFORM wf.log_event(p_plan, NULL, 'plan_cancelled',
                       jsonb_build_object('requested_by', p_requested_by, 'reason', p_reason,
                                          'cancelled_tasks', v_tasks, 'cancelled_executions', v_execs));
  RETURN jsonb_build_object('plan_id', p_plan, 'status', 'cancelled', 'cancelled_tasks', v_tasks,
                            'cancelled_executions', v_execs);
END $$;

CREATE OR REPLACE FUNCTION wf.decide_approval(p_approval uuid, p_decision text, p_decided_by text, p_note text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  a wf.approvals;
  v_plan_status text;
BEGIN
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'decision must be approved or rejected' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF coalesce(trim(p_decided_by), '') = '' THEN
    RAISE EXCEPTION 'decided_by is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO a FROM wf.approvals WHERE approval_id = p_approval FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval % not found', p_approval USING ERRCODE = 'no_data_found';
  END IF;
  IF a.status <> 'pending' THEN
    RAISE EXCEPTION 'approval is already %', a.status USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  PERFORM 1 FROM wf.plans WHERE plan_id = a.plan_id FOR UPDATE;

  UPDATE wf.approvals SET status = p_decision, decided_by = p_decided_by, decision_note = p_note, decided_at = now()
  WHERE approval_id = p_approval;

  IF a.approval_type = 'task_output' THEN
    UPDATE wf.tasks
    SET status = CASE WHEN p_decision = 'approved' THEN 'completed' ELSE 'failed' END,
        completed_at = CASE WHEN p_decision = 'approved' THEN now() END,
        last_error = CASE WHEN p_decision = 'rejected'
                          THEN jsonb_build_object('code', 'rejected_by_human', 'message', coalesce(p_note, '')) END,
        status_reason = p_decision || ' by ' || p_decided_by
    WHERE plan_id = a.plan_id AND task_id = a.task_id AND status = 'awaiting_approval';
    SELECT status INTO v_plan_status FROM wf.plans WHERE plan_id = a.plan_id;
  ELSE
    UPDATE wf.plans
    SET status = CASE WHEN p_decision = 'approved' THEN 'completed' ELSE 'rejected' END,
        completed_at = now(),
        status_reason = 'final deliverables ' || p_decision || ' by ' || p_decided_by
    WHERE plan_id = a.plan_id AND status = 'awaiting_approval'
    RETURNING status INTO v_plan_status;
  END IF;

  PERFORM wf.log_event(a.plan_id, a.task_id, 'approval_' || p_decision,
                       jsonb_build_object('approval_id', p_approval, 'decided_by', p_decided_by, 'note', p_note));
  RETURN jsonb_build_object('approval_id', p_approval, 'plan_id', a.plan_id, 'task_id', a.task_id,
                            'approval_type', a.approval_type, 'decision', p_decision, 'plan_status', v_plan_status);
END $$;

-- ───────────────────────────── Employee tools ─────────────────────────────

CREATE OR REPLACE FUNCTION wf.search_knowledge(p_query text, p_limit int DEFAULT 5)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH q AS (
    SELECT to_tsquery('simple', string_agg(quote_literal(w) || ':*', ' | ')) AS tsq
    FROM regexp_split_to_table(lower(coalesce(p_query, '')), '[^[:alnum:]]+') w
    WHERE length(w) >= 3)
  SELECT coalesce(jsonb_agg(r ORDER BY (r->>'rank')::float DESC), '[]')
  FROM (
    SELECT jsonb_build_object('article_id', a.article_id, 'title', a.title, 'source_url', a.source_url,
                              'content', left(a.content, 4000), 'rank', ts_rank(a.search, q.tsq)) AS r
    FROM wf.knowledge_articles a, q
    WHERE a.approved AND q.tsq IS NOT NULL AND a.search @@ q.tsq
    ORDER BY ts_rank(a.search, q.tsq) DESC
    LIMIT least(greatest(p_limit, 1), 10)) s;
$$;

-- ───────────────────────────── Dashboard API ─────────────────────────────

CREATE OR REPLACE FUNCTION wf.plan_progress(p_plan uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'total', count(*),
    'completed', count(*) FILTER (WHERE status = 'completed'),
    'percent', CASE WHEN count(*) = 0 THEN 0
                    ELSE round(100.0 * count(*) FILTER (WHERE status = 'completed') / count(*)) END,
    'by_status', (SELECT coalesce(jsonb_object_agg(status, n), '{}')
                  FROM (SELECT status, count(*) n FROM wf.tasks WHERE plan_id = p_plan GROUP BY status) s))
  FROM wf.tasks WHERE plan_id = p_plan;
$$;

-- wf.api_organization() lives in dashboard-functions.sql (it uses wf.employee_activity).

DROP FUNCTION IF EXISTS wf.api_list_plans(int, text);
-- p_department: plans owned by the department or containing any of its tasks.
CREATE OR REPLACE FUNCTION wf.api_list_plans(p_limit int DEFAULT 20, p_status text DEFAULT NULL, p_department text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('plans', coalesce(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]')) FROM (
    SELECT jsonb_build_object('plan_id', p.plan_id, 'objective', p.objective, 'plan_summary', p.plan_summary,
                              'status', p.status, 'status_reason', p.status_reason, 'department_id', p.department_id,
                              'revision_cycle', p.revision_cycle, 'progress', wf.plan_progress(p.plan_id),
                              'created_at', p.created_at, 'updated_at', p.updated_at,
                              'completed_at', p.completed_at) AS x
    FROM wf.plans p
    WHERE (p_status IS NULL OR p.status = p_status)
      AND (p_department IS NULL OR p.department_id = p_department
           OR EXISTS (SELECT 1 FROM wf.tasks t WHERE t.plan_id = p.plan_id AND t.department_id = p_department))
    ORDER BY p.created_at DESC
    LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)) s;
$$;

CREATE OR REPLACE FUNCTION wf.api_plan(p_plan uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'plan_id', p.plan_id, 'objective', p.objective, 'plan_summary', p.plan_summary, 'department_id', p.department_id,
    'status', p.status, 'status_reason', p.status_reason, 'validation_errors', p.validation_errors,
    'revision_cycle', p.revision_cycle, 'max_revision_cycles', p.max_revision_cycles,
    'progress', wf.plan_progress(p.plan_id),
    'created_at', p.created_at, 'updated_at', p.updated_at, 'completed_at', p.completed_at,
    'tasks', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'task_id', t.task_id, 'task_name', t.task_name, 'description', t.description,
        'assigned_employee_id', t.assigned_employee_id, 'department_id', t.department_id,
        'input_data', t.input_data, 'expected_output', t.expected_output,
        'acceptance_criteria', t.acceptance_criteria, 'priority', t.priority, 'status', t.status,
        'status_reason', t.status_reason, 'retry_count', t.retry_count, 'max_retries', t.max_retries,
        'requires_approval', t.requires_approval, 'revision_cycle', t.revision_cycle,
        'depends_on', (SELECT coalesce(jsonb_agg(d.depends_on_task_id ORDER BY d.depends_on_task_id), '[]')
                       FROM wf.task_dependencies d WHERE d.plan_id = t.plan_id AND d.task_id = t.task_id),
        'dependents', (SELECT coalesce(jsonb_agg(d.task_id ORDER BY d.task_id), '[]')
                       FROM wf.task_dependencies d WHERE d.plan_id = t.plan_id AND d.depends_on_task_id = t.task_id),
        'last_error', t.last_error,
        'has_output', EXISTS (SELECT 1 FROM wf.task_outputs o WHERE o.plan_id = t.plan_id AND o.task_id = t.task_id),
        'can_retry', t.status = 'failed' AND p.status IN ('running', 'blocked'),
        'started_at', t.started_at, 'completed_at', t.completed_at
      ) ORDER BY t.created_at, t.task_id), '[]')
      FROM wf.tasks t WHERE t.plan_id = p.plan_id),
    'pending_approvals', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('approval_id', a.approval_id, 'task_id', a.task_id,
                                                   'approval_type', a.approval_type, 'reason', a.reason,
                                                   'created_at', a.created_at) ORDER BY a.created_at), '[]')
      FROM wf.approvals a WHERE a.plan_id = p.plan_id AND a.status = 'pending'),
    'can_cancel', p.status NOT IN ('completed', 'cancelled', 'rejected'))
  INTO v
  FROM wf.plans p WHERE p.plan_id = p_plan;
  IF v IS NULL THEN
    RAISE EXCEPTION 'plan % not found', p_plan USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v;
END $$;

DROP FUNCTION IF EXISTS wf.api_pending_approvals();
-- p_department: approvals of plans owned by that department (company plans are approved by the CEO).
CREATE OR REPLACE FUNCTION wf.api_pending_approvals(p_department text DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('approvals', coalesce(jsonb_agg(jsonb_build_object(
    'approval_id', a.approval_id, 'plan_id', a.plan_id, 'task_id', a.task_id,
    'approval_type', a.approval_type, 'reason', a.reason, 'payload', a.payload,
    'objective', p.objective, 'plan_status', p.status, 'department_id', p.department_id,
    'created_at', a.created_at) ORDER BY a.created_at), '[]'))
  FROM wf.approvals a JOIN wf.plans p ON p.plan_id = a.plan_id
  WHERE a.status = 'pending' AND (p_department IS NULL OR p.department_id = p_department);
$$;

CREATE OR REPLACE FUNCTION wf.api_plan_history(p_plan uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM wf.plans WHERE plan_id = p_plan) THEN
    RAISE EXCEPTION 'plan % not found', p_plan USING ERRCODE = 'no_data_found';
  END IF;
  RETURN jsonb_build_object(
    'plan_id', p_plan,
    'events', (SELECT coalesce(jsonb_agg(jsonb_build_object('event_id', e.event_id, 'task_id', e.task_id,
                                                            'event_type', e.event_type, 'details', e.details,
                                                            'created_at', e.created_at) ORDER BY e.event_id), '[]')
               FROM wf.execution_events e WHERE e.plan_id = p_plan),
    'executions', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                     'execution_id', x.execution_id, 'task_id', x.task_id, 'attempt', x.attempt, 'status', x.status,
                     'n8n_execution_id', x.n8n_execution_id, 'started_at', x.started_at,
                     'finished_at', x.finished_at, 'error', x.error, 'metadata', x.metadata) ORDER BY x.started_at), '[]')
                   FROM wf.task_executions x WHERE x.plan_id = p_plan),
    'approvals', (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.created_at), '[]')
                  FROM wf.approvals a WHERE a.plan_id = p_plan));
END $$;

CREATE OR REPLACE FUNCTION wf.api_deliverables(p_plan uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'plan_id', p.plan_id, 'objective', p.objective, 'status', p.status, 'status_reason', p.status_reason,
    'review', p.review, 'final_report', p.final_report,
    'outputs', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'task_id', t.task_id, 'task_name', t.task_name, 'employee_id', t.assigned_employee_id,
        'status', t.status, 'output', o.output, 'artifact_refs', o.artifact_refs,
        'produced_at', o.created_at) ORDER BY t.created_at, t.task_id), '[]')
      FROM wf.tasks t
      LEFT JOIN LATERAL (SELECT o.output, o.artifact_refs, o.created_at FROM wf.task_outputs o
                         WHERE o.plan_id = t.plan_id AND o.task_id = t.task_id
                         ORDER BY o.created_at DESC LIMIT 1) o ON true
      WHERE t.plan_id = p.plan_id))
  INTO v
  FROM wf.plans p WHERE p.plan_id = p_plan;
  IF v IS NULL THEN
    RAISE EXCEPTION 'plan % not found', p_plan USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v;
END $$;

-- ───────────────────────────── Error-safe entry points for n8n ─────────────────────────────
-- n8n's Postgres node drops the database error text, so these wrappers catch exceptions and
-- return { ok, status, error: { code, message, sqlstate } }. The exception block is a
-- subtransaction: a failed action leaves no partial writes.

CREATE OR REPLACE FUNCTION wf.error_result(p_state text, p_message text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('ok', false,
    'status', CASE WHEN p_state = 'P0002' THEN 404
                   WHEN p_state = '55000' THEN 409
                   WHEN p_state LIKE '22%' OR p_state LIKE '23%' THEN 400
                   ELSE 500 END,
    'error', jsonb_build_object(
      'code', CASE WHEN p_state = 'P0002' THEN 'not_found'
                   WHEN p_state = '55000' THEN 'conflict'
                   WHEN p_state LIKE '22%' OR p_state LIKE '23%' THEN 'invalid_request'
                   ELSE 'internal_error' END,
      'message', p_message, 'sqlstate', p_state));
$$;

-- Dashboard API dispatcher: one action name + JSON arguments per endpoint.
CREATE OR REPLACE FUNCTION wf.api(p_action text, p_args jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  a jsonb := coalesce(p_args, '{}');
  v jsonb;
  v_state text;
  v_msg text;
BEGIN
  CASE p_action
    WHEN 'organization' THEN v := wf.api_organization();
    WHEN 'list_plans' THEN v := wf.api_list_plans(coalesce(nullif(a->>'limit', '')::int, 20), nullif(a->>'status', ''), nullif(a->>'department_id', ''));
    WHEN 'plan' THEN v := wf.api_plan((a->>'plan_id')::uuid);
    WHEN 'plan_history' THEN v := wf.api_plan_history((a->>'plan_id')::uuid);
    WHEN 'deliverables' THEN v := wf.api_deliverables((a->>'plan_id')::uuid);
    WHEN 'pending_approvals' THEN v := wf.api_pending_approvals(nullif(a->>'department_id', ''));
    WHEN 'cancel_plan' THEN v := wf.cancel_plan((a->>'plan_id')::uuid, a->>'requested_by', a->>'reason');
    WHEN 'retry_task' THEN v := wf.retry_task((a->>'plan_id')::uuid, a->>'task_id', a->>'requested_by');
    WHEN 'decide_approval' THEN v := wf.decide_approval((a->>'approval_id')::uuid, a->>'decision', a->>'decided_by', a->>'note');
    WHEN 'direct_task' THEN v := wf.create_direct_task(a->>'employee_id', a->>'text', a->>'requested_by', nullif(a->>'department_id', ''));
    WHEN 'recent_results' THEN v := wf.api_recent_results(coalesce(nullif(a->>'limit', '')::int, 10), nullif(a->>'department_id', ''));
    WHEN 'task_output' THEN v := wf.api_task_output((a->>'plan_id')::uuid, a->>'task_id');
    WHEN 'publications' THEN v := wf.api_publications((a->>'plan_id')::uuid);
    WHEN 'start_linkedin_publication' THEN v := wf.start_linkedin_publication((a->>'plan_id')::uuid, a->>'requested_by');
    WHEN 'library' THEN v := wf.api_library(nullif(a->>'department_id', ''), nullif(a->>'employee_id', ''), nullif(a->>'status', ''),
                                            nullif(a->>'approval', ''), a->>'q', nullif(a->>'limit', '')::int, nullif(a->>'offset', '')::int);
    WHEN 'set_library_status' THEN v := wf.set_library_status((a->>'plan_id')::uuid, a->>'task_id', a->>'status', a->>'updated_by');
    WHEN 'integrations' THEN v := wf.api_integrations();
    WHEN 'save_integration_config' THEN v := wf.save_integration_config(a->>'service', a->'config',
                                                                        coalesce((a->>'secret_saved')::boolean, false), a->>'updated_by');
    ELSE RAISE EXCEPTION 'unknown action %', p_action USING ERRCODE = 'invalid_parameter_value';
  END CASE;
  RETURN jsonb_build_object('ok', true, 'status', 200, 'data', v, 'error', NULL);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  RETURN wf.error_result(v_state, v_msg);
END $$;

CREATE OR REPLACE FUNCTION wf.try_create_plan(p_objective text, p_request jsonb, p_plan jsonb, p_max_revision_cycles int DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_state text;
  v_msg text;
BEGIN
  RETURN jsonb_build_object('ok', true) || wf.create_plan(p_objective, p_request, p_plan, p_max_revision_cycles);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  RETURN wf.error_result(v_state, v_msg);
END $$;

CREATE OR REPLACE FUNCTION wf.try_add_revision_tasks(p_plan uuid, p_tasks jsonb, p_review jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_state text;
  v_msg text;
BEGIN
  RETURN jsonb_build_object('ok', true) || wf.add_revision_tasks(p_plan, p_tasks, p_review);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  RETURN wf.error_result(v_state, v_msg);
END $$;
