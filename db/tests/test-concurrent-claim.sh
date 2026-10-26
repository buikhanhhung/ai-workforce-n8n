#!/usr/bin/env bash
# Duplicate-dispatch test: 8 concurrent sessions race to claim 6 ready tasks of one plan.
# Passes when exactly 6 claims happen and no task is claimed twice. Cleans up after itself.
set -euo pipefail
PSQL=(docker exec -i wf-postgres psql -U workforce -d workforce -qtA -v ON_ERROR_STOP=1)

TASKS=$(for i in 1 2 3 4 5 6; do
  printf '{"task_id":"c%s","task_name":"c","description":"d","assigned_employee_id":"emp_skill_recommender","department_id":"dept_operations","expected_output":"x","acceptance_criteria":["c"],"depends_on":[]}' "$i"
  if [ "$i" -lt 6 ]; then printf ','; fi
done)
PLAN=$("${PSQL[@]}" -c "SELECT wf.create_plan('concurrency test', '{}', '{\"tasks\":[${TASKS}]}')->>'plan_id'")
"${PSQL[@]}" -c "SELECT wf.refresh_plan('${PLAN}')" > /dev/null
trap '"${PSQL[@]}" -c "DELETE FROM wf.plans WHERE plan_id = '"'"'${PLAN}'"'"'" > /dev/null' EXIT

OUT=$(mktemp -d)
for s in $(seq 1 8); do
  "${PSQL[@]}" -c "SELECT task_id FROM wf.claim_ready_tasks('${PLAN}', 10)" > "${OUT}/s${s}.txt" &
done
wait

TOTAL=$(cat "${OUT}"/s*.txt | grep -c . || true)
DISTINCT=$(cat "${OUT}"/s*.txt | grep . | sort -u | wc -l | tr -d ' ')
RUNNING=$("${PSQL[@]}" -c "SELECT count(*) FROM wf.task_executions WHERE plan_id = '${PLAN}' AND status = 'running'")
echo "claims=${TOTAL} distinct=${DISTINCT} running_executions=${RUNNING} per_session=$(for f in "${OUT}"/s*.txt; do grep -c . "$f" || true; done | tr '\n' ' ')"
rm -rf "${OUT}"
if [ "${TOTAL}" = 6 ] && [ "${DISTINCT}" = 6 ] && [ "${RUNNING}" = 6 ]; then echo "PASS: no duplicate dispatch"; else echo "FAIL"; exit 1; fi
