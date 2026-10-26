-- Content library tests: department scoping, search, shared status changes. Rolled back.
-- Usage: docker cp db/tests/test-library.sql wf-postgres:/tmp/t.sql; docker exec wf-postgres psql -U workforce -d workforce -v ON_ERROR_STOP=1 -f /tmp/t.sql
BEGIN;

DO $$
DECLARE
  v_plan uuid;
  v_exec uuid;
  v_res jsonb;
  mk jsonb;
  marker text := 'zz-library-test-marker';
BEGIN
  mk := '[
    {"task_id":"ops","task_name":"Ops check","description":"d","assigned_employee_id":"emp_wecommitdw_checker","department_id":"dept_operations","expected_output":"x","acceptance_criteria":["c"],"depends_on":[]},
    {"task_id":"cs","task_name":"Community check","description":"d","assigned_employee_id":"emp_circle_checker","department_id":"dept_customer_success","expected_output":"x","acceptance_criteria":["c"],"depends_on":[]}
  ]';
  v_plan := (wf.create_plan('library test ' || marker, '{}', jsonb_build_object('plan_summary', 's', 'tasks', mk))->>'plan_id')::uuid;
  PERFORM wf.refresh_plan(v_plan);
  PERFORM wf.claim_ready_tasks(v_plan, 2);
  SELECT execution_id INTO v_exec FROM wf.task_executions WHERE plan_id = v_plan AND task_id = 'ops';
  PERFORM wf.complete_task(v_exec, '{"system_name":"WeCommitDW","overall_health":"warning","findings":[{"title":"Disk 91%"}]}');
  SELECT execution_id INTO v_exec FROM wf.task_executions WHERE plan_id = v_plan AND task_id = 'cs';
  PERFORM wf.complete_task(v_exec, '{"summary":"4 threads","items":[]}');

  -- 1. a department sees only its own agents' outputs; the CEO scope sees both
  v_res := wf.api('library', jsonb_build_object('department_id', 'dept_operations', 'q', marker))->'data';
  ASSERT (v_res->>'total')::int = 1 AND v_res->'items'->0->>'task_id' = 'ops', format('operations scope: %s', v_res);
  ASSERT v_res->'items'->0->>'title' = 'Kiểm tra hệ thống WeCommitDW', format('title: %s', v_res->'items'->0->>'title');
  ASSERT v_res->'items'->0->>'status' = 'new', 'outputs start as new';
  v_res := wf.api('library', jsonb_build_object('q', marker))->'data';
  ASSERT (v_res->>'total')::int = 2, format('ceo scope total: %s', v_res->>'total');

  -- 2. archiving hides it from the default (active) list but not from status=archived / all
  v_res := wf.api('set_library_status', jsonb_build_object('plan_id', v_plan, 'task_id', 'cs', 'status', 'archived', 'updated_by', 'tester'));
  ASSERT (v_res->>'ok')::boolean AND v_res->'data'->>'previous_status' = 'new', format('archive: %s', v_res);
  v_res := wf.api('library', jsonb_build_object('q', marker))->'data';
  ASSERT (v_res->>'total')::int = 1 AND (v_res->'counts'->>'archived')::int = 1, format('active after archive: %s', v_res);
  v_res := wf.api('library', jsonb_build_object('q', marker, 'status', 'archived'))->'data';
  ASSERT (v_res->>'total')::int = 1 AND v_res->'items'->0->>'status_by' = 'tester', format('archived list: %s', v_res);

  -- 3. status change is logged; restoring works
  ASSERT EXISTS (SELECT 1 FROM wf.execution_events WHERE plan_id = v_plan AND event_type = 'library_status_changed'), 'event logged';
  PERFORM wf.api('set_library_status', jsonb_build_object('plan_id', v_plan, 'task_id', 'cs', 'status', 'used', 'updated_by', 'tester'));
  v_res := wf.api('library', jsonb_build_object('q', marker, 'status', 'used'))->'data';
  ASSERT (v_res->>'total')::int = 1, 'restored as used';

  -- 4. errors come back as data
  v_res := wf.api('set_library_status', jsonb_build_object('plan_id', v_plan, 'task_id', 'cs', 'status', 'deleted', 'updated_by', 'tester'));
  ASSERT NOT (v_res->>'ok')::boolean AND (v_res->>'status')::int = 400, format('bad status: %s', v_res);
  v_res := wf.api('set_library_status', jsonb_build_object('plan_id', v_plan, 'task_id', 'nope', 'status', 'used', 'updated_by', 'tester'));
  ASSERT (v_res->>'status')::int = 404, format('missing output: %s', v_res);
  v_res := wf.api('library', jsonb_build_object('status', 'bogus'));
  ASSERT (v_res->>'status')::int = 400, format('bad list status: %s', v_res);

  RAISE NOTICE 'ALL LIBRARY TESTS PASSED';
END $$;

ROLLBACK;
