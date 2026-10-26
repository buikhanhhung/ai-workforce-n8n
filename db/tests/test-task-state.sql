-- State-machine tests for the wf schema. Runs inside a transaction that is rolled back.
-- Usage: Get-Content -Raw db/tests/test-task-state.sql | docker exec -i wf-postgres psql -U workforce -d workforce -v ON_ERROR_STOP=1
BEGIN;

DO $$
DECLARE
  v_plan uuid;
  v_res jsonb;
  v_ids text[];
  v_exec uuid;
  v_status text;
  v_n int;
  v_ok boolean;
  mk jsonb;
BEGIN
  -- Graph from the spec: Research, Audience parallel; Copy <- both; Design <- Copy; Final <- Copy, Design
  mk := '[
    {"task_id":"research","task_name":"Research","description":"d","assigned_employee_id":"emp_skill_recommender","department_id":"dept_operations","expected_output":"x","acceptance_criteria":["c"],"depends_on":[]},
    {"task_id":"audience","task_name":"Audience","description":"d","assigned_employee_id":"emp_skill_recommender","department_id":"dept_operations","expected_output":"x","acceptance_criteria":["c"],"depends_on":[]},
    {"task_id":"copy","task_name":"Copy","description":"d","assigned_employee_id":"emp_yt_linkedin","department_id":"dept_marketing","expected_output":"x","acceptance_criteria":["c"],"depends_on":["research","audience"]},
    {"task_id":"design","task_name":"Design","description":"d","assigned_employee_id":"emp_visual_design","department_id":"dept_marketing","expected_output":"x","acceptance_criteria":["c"],"depends_on":["copy"],"max_retries":1},
    {"task_id":"final","task_name":"Final","description":"d","assigned_employee_id":"emp_repurpose_studio","department_id":"dept_marketing","expected_output":"x","acceptance_criteria":["c"],"depends_on":["copy","design"]}
  ]';
  v_res := wf.create_plan('test objective', '{}', jsonb_build_object('plan_summary', 's', 'tasks', mk));
  v_plan := (v_res->>'plan_id')::uuid;

  -- 1. only independent tasks become ready
  PERFORM wf.refresh_plan(v_plan);
  SELECT array_agg(task_id ORDER BY task_id) INTO v_ids FROM wf.tasks WHERE plan_id = v_plan AND status = 'ready';
  ASSERT v_ids = ARRAY['audience', 'research'], format('ready after create: %s', v_ids);

  -- 2. claim is exclusive: second claim returns nothing while both are running
  SELECT count(*) INTO v_n FROM wf.claim_ready_tasks(v_plan, 3);
  ASSERT v_n = 2, format('first claim got %s', v_n);
  SELECT count(*) INTO v_n FROM wf.claim_ready_tasks(v_plan, 3);
  ASSERT v_n = 0, format('second claim got %s (duplicate dispatch)', v_n);

  -- 3. copy waits for BOTH prerequisites
  SELECT execution_id INTO v_exec FROM wf.task_executions WHERE plan_id = v_plan AND task_id = 'research';
  PERFORM wf.complete_task(v_exec, '{"r":1}');
  PERFORM wf.refresh_plan(v_plan);
  SELECT status INTO v_status FROM wf.tasks WHERE plan_id = v_plan AND task_id = 'copy';
  ASSERT v_status = 'pending', format('copy should wait for audience, is %s', v_status);
  SELECT execution_id INTO v_exec FROM wf.task_executions WHERE plan_id = v_plan AND task_id = 'audience';
  PERFORM wf.complete_task(v_exec, '{"a":1}');
  PERFORM wf.refresh_plan(v_plan);
  SELECT status INTO v_status FROM wf.tasks WHERE plan_id = v_plan AND task_id = 'copy';
  ASSERT v_status = 'ready', format('copy should be ready, is %s', v_status);

  -- 4. a completed execution cannot be completed twice
  v_res := wf.complete_task(v_exec, '{"a":2}');
  ASSERT (v_res->>'accepted')::boolean = false, 'double completion accepted';

  -- 5. dependency outputs reach the next task
  SELECT execution_id INTO v_exec FROM wf.claim_ready_tasks(v_plan, 3);
  v_res := wf.begin_task_run(v_exec, 'n8n-test');
  ASSERT jsonb_array_length(v_res->'dependency_outputs') = 2, 'copy should receive 2 dependency outputs';
  PERFORM wf.complete_task(v_exec, '{"post":"hi"}');
  PERFORM wf.refresh_plan(v_plan);

  -- 6. bounded retries: design max_retries=1 -> retry once (ready + backoff), then failed
  SELECT execution_id INTO v_exec FROM wf.claim_ready_tasks(v_plan, 3);
  v_res := wf.fail_task(v_exec, '{"code":"ai_error","message":"boom"}', true);
  ASSERT v_res->>'status' = 'ready' AND (v_res->>'retry_count')::int = 1, format('first failure: %s', v_res);
  SELECT count(*) INTO v_n FROM wf.claim_ready_tasks(v_plan, 3);
  ASSERT v_n = 0, 'retry must respect backoff (not_before)';
  UPDATE wf.tasks SET not_before = now() - interval '1 second' WHERE plan_id = v_plan AND task_id = 'design';
  SELECT execution_id INTO v_exec FROM wf.claim_ready_tasks(v_plan, 3);
  ASSERT v_exec IS NOT NULL, 'retry should be claimable after backoff';
  v_res := wf.fail_task(v_exec, '{"code":"ai_error","message":"boom again"}', true);
  ASSERT v_res->>'status' = 'failed', format('second failure should be terminal: %s', v_res);

  -- 7. failed prerequisite blocks dependents and the plan
  v_res := wf.refresh_plan(v_plan);
  SELECT status INTO v_status FROM wf.tasks WHERE plan_id = v_plan AND task_id = 'final';
  ASSERT v_status = 'blocked', format('final should be blocked, is %s', v_status);
  ASSERT v_res->>'plan_status' = 'blocked', format('plan should be blocked: %s', v_res);

  -- 8. manual retry unblocks the chain
  PERFORM wf.retry_task(v_plan, 'design', 'tester');
  v_res := wf.refresh_plan(v_plan);
  SELECT status INTO v_status FROM wf.tasks WHERE plan_id = v_plan AND task_id = 'final';
  ASSERT v_status = 'pending', format('final should be pending after retry, is %s', v_status);
  ASSERT v_res->>'plan_status' = 'running', format('plan should run again: %s', v_res);

  -- 9. finish -> review claimed exactly once
  SELECT execution_id INTO v_exec FROM wf.claim_ready_tasks(v_plan, 3);
  PERFORM wf.complete_task(v_exec, '{"d":1}');
  PERFORM wf.refresh_plan(v_plan);
  SELECT execution_id INTO v_exec FROM wf.claim_ready_tasks(v_plan, 3);
  PERFORM wf.complete_task(v_exec, '{"f":1}');
  v_res := wf.refresh_plan(v_plan);
  ASSERT (v_res->>'review_needed')::boolean AND v_res->>'plan_status' = 'reviewing', format('review: %s', v_res);
  v_res := wf.refresh_plan(v_plan);
  ASSERT NOT (v_res->>'review_needed')::boolean, 'review must be claimed only once';

  -- 10. finalize requires human approval; approval completes the plan
  v_res := wf.finalize_review(v_plan, '{"verdict":"approved"}', '{"title":"t"}');
  ASSERT v_res->>'status' = 'awaiting_approval', format('finalize: %s', v_res);
  v_res := wf.decide_approval((v_res->>'approval_id')::uuid, 'approved', 'tester', 'ok');
  ASSERT v_res->>'plan_status' = 'completed', format('approval: %s', v_res);

  -- 11. illegal transitions are rejected by the trigger
  BEGIN
    UPDATE wf.tasks SET status = 'running' WHERE plan_id = v_plan AND task_id = 'final';
    v_ok := false;
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  ASSERT v_ok, 'completed -> running must be rejected';

  -- 12. invalid plans are rejected atomically
  BEGIN
    PERFORM wf.create_plan('cycle', '{}', '{"tasks":[
      {"task_id":"a","task_name":"a","description":"d","assigned_employee_id":"emp_yt_linkedin","department_id":"dept_marketing","expected_output":"x","depends_on":["b"]},
      {"task_id":"b","task_name":"b","description":"d","assigned_employee_id":"emp_yt_linkedin","department_id":"dept_marketing","expected_output":"x","depends_on":["a"]}]}');
    v_ok := false;
  EXCEPTION WHEN invalid_parameter_value THEN v_ok := SQLERRM LIKE 'circular dependency%';
  END;
  ASSERT v_ok, 'cycle must be rejected';
  BEGIN
    PERFORM wf.create_plan('bad employee', '{}', '{"tasks":[
      {"task_id":"a","task_name":"a","description":"d","assigned_employee_id":"emp_nobody","department_id":"dept_marketing","expected_output":"x","depends_on":[]}]}');
    v_ok := false;
  EXCEPTION WHEN foreign_key_violation THEN v_ok := true;
  END;
  ASSERT v_ok, 'unknown employee must be rejected';
  BEGIN
    PERFORM wf.create_plan('wrong dept', '{}', '{"tasks":[
      {"task_id":"a","task_name":"a","description":"d","assigned_employee_id":"emp_yt_linkedin","department_id":"dept_operations","expected_output":"x","depends_on":[]}]}');
    v_ok := false;
  EXCEPTION WHEN foreign_key_violation THEN v_ok := true;
  END;
  ASSERT v_ok, 'employee/department mismatch must be rejected';
  BEGIN
    PERFORM wf.create_plan('bad dep', '{}', '{"tasks":[
      {"task_id":"a","task_name":"a","description":"d","assigned_employee_id":"emp_yt_linkedin","department_id":"dept_marketing","expected_output":"x","depends_on":["zzz"]}]}');
    v_ok := false;
  EXCEPTION WHEN foreign_key_violation THEN v_ok := true;
  END;
  ASSERT v_ok, 'unknown dependency must be rejected';

  -- 13. department-owned plans cannot use other departments' employees; planning lock is per scope
  v_res := wf.try_start_planning('dept test', '{}', 0, 'dept_marketing');
  ASSERT (v_res->>'ok')::boolean, format('start marketing planning: %s', v_res);
  v_plan := (v_res->>'plan_id')::uuid;
  ASSERT NOT (wf.try_start_planning('second', '{}', 0, 'dept_marketing')->>'ok')::boolean, 'second marketing planning must be refused';
  ASSERT (wf.try_start_planning('ops in parallel', '{}', 0, 'dept_operations')->>'ok')::boolean, 'operations may plan in parallel';
  v_res := wf.try_finish_planning(v_plan, '{"tasks":[{"task_id":"a","task_name":"a","description":"d","assigned_employee_id":"emp_wecommitdw_checker","department_id":"dept_operations","expected_output":"x","acceptance_criteria":["c"],"depends_on":[]}]}');
  ASSERT NOT (v_res->>'ok')::boolean AND v_res->'error'->>'message' LIKE '%other departments%', format('cross-department task: %s', v_res);
  v_res := wf.try_finish_planning(v_plan, '{"tasks":[{"task_id":"a","task_name":"a","description":"d","assigned_employee_id":"emp_yt_linkedin","department_id":"dept_marketing","expected_output":"x","acceptance_criteria":["c"],"depends_on":[]}]}');
  ASSERT (v_res->>'ok')::boolean, format('same-department task: %s', v_res);

  -- 14. company queue: one task at a time per employee (max_concurrent 1), CEO work before department
  --     work even when the department asked first. Other plans are paused so only test work is queued.
  UPDATE wf.plans SET status = 'blocked' WHERE status = 'running';
  UPDATE wf.employees SET max_concurrent = 1 WHERE employee_id = 'emp_repurpose_studio';
  mk := '[{"task_id":"q1","task_name":"q","description":"d","assigned_employee_id":"emp_repurpose_studio","department_id":"dept_marketing","expected_output":"x","acceptance_criteria":["c"],"depends_on":[]}]';
  v_res := wf.create_plan('department asks first', '{}', jsonb_build_object('tasks', mk), 0);
  UPDATE wf.plans SET department_id = 'dept_marketing' WHERE plan_id = (v_res->>'plan_id')::uuid;
  PERFORM wf.refresh_plan((v_res->>'plan_id')::uuid);
  v_res := wf.create_plan('CEO asks second', '{}', jsonb_build_object('tasks', mk || jsonb_build_array(mk->0 || '{"task_id":"q2"}')), 0);
  v_plan := (v_res->>'plan_id')::uuid;
  PERFORM wf.refresh_plan(v_plan);

  SELECT count(*), min(c.plan_id::text) INTO v_n, v_status FROM wf.claim_next_tasks(3) c;
  ASSERT v_n = 1 AND v_status = v_plan::text, format('first claim should be 1 CEO task, got %s from %s', v_n, v_status);
  SELECT count(*) INTO v_n FROM wf.claim_next_tasks(3);
  ASSERT v_n = 0, format('employee is busy, second claim got %s', v_n);
  SELECT execution_id INTO v_exec FROM wf.task_executions WHERE plan_id = v_plan AND status = 'running';
  PERFORM wf.complete_task(v_exec, '{"ok":1}');
  SELECT c.plan_id::text INTO v_status FROM wf.claim_next_tasks(3) c;
  ASSERT v_status = v_plan::text, 'the second CEO task must run before the department task';
  SELECT execution_id INTO v_exec FROM wf.task_executions WHERE plan_id = v_plan AND status = 'running';
  PERFORM wf.complete_task(v_exec, '{"ok":2}');
  SELECT c.plan_id::text INTO v_status FROM wf.claim_next_tasks(3) c;
  ASSERT v_status <> v_plan::text AND v_status IS NOT NULL, 'department task runs once CEO work is done';

  RAISE NOTICE 'ALL STATE TESTS PASSED';
END $$;

ROLLBACK;
