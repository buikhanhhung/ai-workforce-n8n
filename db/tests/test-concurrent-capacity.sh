#!/usr/bin/env bash
# Capacity race test: 8 concurrent sessions call wf.claim_next_tasks while one employee
# (max_concurrent = 1) has 6 ready tasks. Passes when exactly 1 task ends up running for it.
set -euo pipefail
PSQL=(docker exec -i wf-postgres psql -U workforce -d workforce -qtA -v ON_ERROR_STOP=1)
EMP=emp_coaching_timeline

BUSY=$("${PSQL[@]}" -c "SELECT count(*) FROM wf.tasks WHERE assigned_employee_id = '${EMP}' AND status = 'running'")
if [ "${BUSY}" != 0 ]; then echo "SKIP: ${EMP} is busy with real work"; exit 0; fi

TASKS=$(for i in 1 2 3 4 5 6; do
  printf '{"task_id":"k%s","task_name":"k","description":"d","assigned_employee_id":"%s","department_id":"dept_customer_success","expected_output":"x","acceptance_criteria":["c"],"depends_on":[]}' "$i" "$EMP"
  if [ "$i" -lt 6 ]; then printf ','; fi
done)
PLAN=$("${PSQL[@]}" -c "SELECT wf.create_plan('capacity test', '{}', '{\"tasks\":[${TASKS}]}', 0)->>'plan_id'")
"${PSQL[@]}" -c "UPDATE wf.employees SET max_concurrent = 1 WHERE employee_id = '${EMP}'; SELECT wf.refresh_plan('${PLAN}')" > /dev/null
trap '"${PSQL[@]}" -c "DELETE FROM wf.plans WHERE plan_id = '"'"'${PLAN}'"'"'" > /dev/null' EXIT

for s in $(seq 1 8); do
  "${PSQL[@]}" -c "SELECT count(*) FROM wf.claim_next_tasks(10) WHERE assigned_employee_id = '${EMP}'" > /dev/null &
done
wait

RUNNING=$("${PSQL[@]}" -c "SELECT count(*) FROM wf.tasks WHERE plan_id = '${PLAN}' AND status = 'running'")
READY=$("${PSQL[@]}" -c "SELECT count(*) FROM wf.tasks WHERE plan_id = '${PLAN}' AND status = 'ready'")
echo "running=${RUNNING} still_queued=${READY}"
if [ "${RUNNING}" = 1 ] && [ "${READY}" = 5 ]; then echo "PASS: capacity respected under concurrency"; else echo "FAIL"; exit 1; fi
