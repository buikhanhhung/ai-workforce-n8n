# AI Workforce Orchestration (n8n)

An AI "company" running in local n8n: a CEO Planner turns a business objective into a validated task graph, a dispatcher runs tasks on 8 specialised AI employees (in parallel when independent), a CEO Reviewer checks the results, and a human approves the final deliverables. PostgreSQL is the source of truth for all state.

## Architecture

```
POST /workforce/requests
  └─ A · CEO Planning ── validate request → CEO Planner Agent (structured output)
        → Validate Task Plan (ids, employees, departments, deps, cycles) → wf.try_create_plan
        → wakes B (fire-and-forget) → 202 { plan_id }
B · Task Dispatcher  (woken by A, by every finished task, by the API, and every minute)
  └─ wf.refresh_plan (deps → ready/blocked, plan status)  → wf.claim_ready_tasks (atomic)
        → B · Task Runner per claimed task (fire-and-forget = real concurrency)
        → D · CEO Review when refresh_plan reports review_needed (exactly once)
B · Task Runner ── wf.begin_task_run → resolve "context.<key>" refs → call employee workflow (wait)
        → wf.complete_task | wf.fail_task (bounded retry + backoff) → wakes B
C · 8 employee workflows ── validate input → [tools] → AI Agent (Gemini + parser) → post-process checks
D · CEO Review ── review agent → enforce rules → wf.try_add_revision_tasks (bounded) | wf.finalize_review
        → plan awaiting_approval + approval row (a human decides)
E · Dashboard API ── 9 webhooks → wf.api(action, args)
```

All workflows are generated from `workflows/src` (one module per employee in `workflows/src/employees`). Do not edit them in the n8n UI: changes are overwritten by the next deploy.

| n8n workflow | ID | Purpose |
|---|---|---|
| 0 · Architecture Overview (map only) | `wf0Architecture1` | one-canvas map; each block opens the real workflow; no trigger, never published |
| A · CEO Planning | `wfaCeoPlanning01` | request → validated plan |
| B · Task Dispatcher | `wfbDispatcher001` | dependency evaluation, claiming, scheduling |
| B · Task Runner | `wfbTaskRunner001` | runs one claimed task, records result |
| C · YouTube-to-LinkedIn Agent | `wfcEmpYtLinkdIn1` | Marketing |
| C · Repurpose Studio Agent | `wfcEmpRepurpose1` | Marketing |
| C · Visual Design Agent | `wfcEmpVisualDsg1` | Marketing |
| C · WeCommitDW System Checker Agent | `wfcEmpSysCheck01` | Operations |
| C · Skill Recommendation Agent | `wfcEmpSkillRec01` | Operations |
| C · Circle Community Checker Agent | `wfcEmpCircleChk1` | Customer Success & Community |
| C · Coaching Timeline Agent | `wfcEmpCoachTime1` | Customer Success & Community |
| C · Knowledge & Support Agent | `wfcEmpKnowledge1` | Customer Success & Community |
| D · CEO Review | `wfdCeoReview0001` | review, revisions, final report |
| E · Dashboard API | `wfeDashboardApi1` | REST endpoints for the dashboard |

## Employees: what each one really does

| Employee | Needs | Guarantees enforced in code (not just prompted) |
|---|---|---|
| YouTube-to-LinkedIn | transcript or source text (URL alone is rejected) | post ≤ 3000 chars; video URL added to source refs; title from YouTube oEmbed when a URL is given |
| Repurpose Studio | source material; `formats`, `variations` | every requested format × variation present, else retry |
| Visual Design | concept or prior content; brand guidelines, dimensions | `image_generated=false`, `asset_urls=[]` (no image integration) |
| WeCommitDW System Checker | `system_data` supplied in the request | each finding flagged `evidence_verified` against the supplied data; no live system access |
| Skill Recommendation | task description | recommendation limited to catalog employees/skills; `workflow_reference` taken from DB |
| Circle Community Checker | `community_data` supplied | sensitive/urgent items escalated; replies are drafts only |
| Coaching Timeline | transcript with ≥ 2 timestamps | timestamps not present in the transcript are removed |
| Knowledge & Support | `question`; approved articles in `wf.knowledge_articles` or `knowledge_sources` | only cited, known sources kept; no source or low confidence ⇒ escalate |

Every employee returns `{ status: 'completed', output, metadata }` or `{ status: 'failed', error: { code, message, retryable } }`. Invalid input is not retried; AI/model errors are.

## Database (`wf` schema)

Tables: `departments`, `employees`, `employee_skills`, `plans`, `tasks`, `task_dependencies`, `task_executions`, `task_outputs`, `approvals`, `execution_events`, `knowledge_articles`, `publications`, `library_items`.

- Task statuses: `pending, blocked, ready, running, completed, failed, cancelled, awaiting_approval`. A trigger rejects illegal transitions.
- Duplicate dispatch is prevented three ways: plan row lock in `claim_ready_tasks`, the `status = 'ready'` predicate on the update, and a unique index allowing one `running` execution per task.
- Retries: `fail_task` re-queues retryable failures with backoff (`not_before` = 20 s × attempt) until `max_retries` (≤ 3 from the planner). Stuck executions (> 15 min) are timed out by the minute poller.
- Plan statuses: `running → reviewing → awaiting_approval → completed | rejected`, plus `blocked`, `failed`, `cancelled`; invalid plans are stored as `rejected` with `validation_errors`.
- Add approved knowledge: `INSERT INTO wf.knowledge_articles (title, content, source_url, approved) VALUES (..., true);`

## Setup and deploy

Requirements: Docker Desktop, Node.js. Secrets live in `.env` (generated, git-ignored) and in n8n Credentials.

Step-by-step guide in Vietnamese: `README.md`.

```powershell
node scripts/init-env.js                               # .env with random secrets (template: .env.example; never overwrites)
docker compose up -d                                   # n8n, wf-postgres, wf-dashboard, wf-renderer
# create the n8n owner account at http://localhost:5678, then:
$p = powershell -ExecutionPolicy Bypass -File scripts/n8n-project-id.ps1   # owner's personal project id
$env:GEMINI_API_KEY = '<key>'; node scripts/import-credentials.js $p; Remove-Item Env:GEMINI_API_KEY
powershell -ExecutionPolicy Bypass -File scripts/deploy-workforce.ps1 -ProjectId $p
```

Credentials created: `Workforce Postgres`, `Gemini (Workforce)` (model `gemini-3.5-flash`, fallback `gemini-3.5-flash-lite`), `Workforce API Key` (header `X-API-Key`, value = `WORKFORCE_API_KEY` in `.env`). To rotate the Gemini key, edit the credential in n8n or re-run the import script.

### Reset to sample data

Back up, wipe the work data (organization, agents and integration settings are kept), then create one real result per agent:

```powershell
$dir = "data\backups\$(Get-Date -Format yyMMdd-HHmm)"; New-Item -ItemType Directory -Force "$dir\assets" | Out-Null
docker exec wf-postgres pg_dump -U workforce -d workforce -n wf --data-only -Fc -f /tmp/wf-data.dump; docker cp wf-postgres:/tmp/wf-data.dump "$dir\"
Move-Item data\assets\* "$dir\assets\"
docker exec wf-postgres psql -U workforce -d workforce -c "TRUNCATE wf.plans CASCADE; TRUNCATE wf.execution_events;"
node tests/run-ceo-demo-scenarios.js   # 6 real requests (Gemini), ~5 minutes
```

## Dashboard UI

`http://localhost:3000`, served by the `dashboard` compose service (`dashboard/server.js`, no dependencies). The server proxies `/api/*` to the workforce webhooks (allow-list) and adds `X-API-Key` itself, so the key never reaches the browser. Without Docker: `node dashboard/server.js`.

Features: command bar to the CEO planner (with typed attachments that become request `context`), assignment banner, recent results, pending approvals (approve/reject), live plan strips with stop, three department columns with employee cards (running timer + stop, waiting reason and step, last result + "Xem", failure + retry) and a per-employee "Giao lại" box that creates a one-task plan for that employee (`task/direct`, text goes to the employee's `x-primary-input`). Polls every 4 s.

## Department tabs

The dashboard has a left sidebar: **Tổng quan · CEO** (whole company) and one tab per department (`#dept_<id>`, survives F5).

- A request sent from a department tab carries `department_id`: the planner only sees that department's employees (`wf.get_employee_catalog(dept)`), and `wf.insert_tasks` rejects any task (including CEO-review revision tasks) assigned outside the department.
- Work no department employee can do is not forced on someone: the planner lists it in `out_of_scope` (with a real department to hand it to) and the dashboard shows it as a warning; if nothing fits, the plan is rejected with that explanation.
- The planning lock is per scope (company, or each department): two departments can plan at the same time, but one department cannot plan twice at once.
- Department tabs show only that department's results, active plans and approvals; direct "Giao lại" plans belong to the employee's department. Permissions (who may open which tab) are not implemented yet.

## Company work queue

Each employee works on at most `employees.max_concurrent` tasks at a time (default 1, settable 1-5 per employee in the database); other ready tasks wait in a company-wide queue. `wf.claim_next_tasks` (used by the dispatcher) picks the next tasks under one advisory lock: CEO/company plans before department plans, then task priority, then first come first served, also keeping the per-plan limit. Priority applies to waiting work: a running task is never interrupted. Direct "Giao lại" from the CEO tab is company work; from a department tab it is department work. Employee cards show what the agent works on ("việc CEO" / "việc phòng") and how many tasks wait.

Tests: `db/tests/test-task-state.sql` (section 14: capacity + CEO-first order) and `bash db/tests/test-concurrent-capacity.sh` (8 sessions race; exactly 1 task runs for a capacity-1 employee).

## LinkedIn post package

The plan modal shows a LinkedIn-style preview built by `wf.find_linkedin_post`: the latest post text of the plan (Markdown stripped by `wf.linkedin_plain_text`, LinkedIn renders plain text) plus the latest rendered image of the same plan. Publishing snapshots exactly that package into `wf.publications` (`content`, `image_file`); workflow F posts only the snapshot, so the post equals the preview. F reads the image file first (missing file -> explicit `failed`), then calls LinkedIn (IMAGE share when there is an image, text otherwise). Pending publications that never report back are failed by the minute poller after 10 minutes.

Not verified yet: the real LinkedIn call (needs the credential). Verified locally: package = preview (text and image), image read by n8n (PNG 86.7 kB), missing image and missing credential both recorded as failed with the reason.

## Content library

Every scope (CEO tab and each department tab) has two views: **Điều hành** (`#<scope>`) and **Thư viện nội dung** (`#<scope>/library`). The library lists the latest output of every task (`wf.api_library`, `db/library.sql`): the CEO tab sees the whole company, a department tab only its own agents' outputs (by `tasks.department_id`).

- Filters: management status chips (Đang dùng được = new + used, Mới, Đã dùng, Lưu trữ, Tất cả, with counts), agent, approval state (from the plan status: chờ duyệt / đã duyệt / đang xử lý / bị từ chối / đã huỷ), text search over task name, request and output; 30 per page.
- Management status `new → used → archived` (restore to `new`) is shared in `wf.library_items` (no row = `new`), set with `wf.set_library_status`, logged as `library_status_changed`. Archiving only hides an item from the default list; nothing is deleted.
- The "Xem" modal (library and everywhere else) renders each employee's output readably (`dashboard/public/content-views.js`: LinkedIn post, repurposed assets, image + card, findings with evidence, recommendation, community threads with draft replies, chapter/highlight tables, support answer or escalation), with per-block copy, "Sao chép nội dung", "Tải .md", image download, and the raw JSON under a fold. Unknown output shapes fall back to the generic key-value view.
- The library tab shows the number of new items and reloads when new outputs arrive. Editing content in the library is not implemented.

## Dashboard API

Base URL `http://localhost:5678/webhook/workforce/`, header `X-API-Key`. Responses: `{ ok, data, error: { code, message } }` with 200 / 202 / 400 / 404 / 409 / 422 / 502 / 503.

Database unreachable → `503 service_unavailable` with a readable message (verified with `wf-postgres` stopped, recovers by itself when it is back). Note: the n8n Postgres node does not use its error output when the connection fails, it passes the request item on without a result, so workflows E and G use `onError: continueRegularOutput` on SQL nodes and treat a missing `result` as "database unavailable".

| Method | Path | Input |
|---|---|---|
| POST | `requests` | `{ objective, context?, requested_by?, max_revision_cycles? (0-3) }` → 202 `{ plan_id, tasks }` |
| GET | `organization` | departments → employees (skills, schemas, status, stats, execution history) |
| GET | `plans` | `?limit=&status=` |
| GET | `plan` | `?plan_id=` → tasks, dependencies, progress, pending approvals, `can_retry`/`can_cancel` |
| GET | `plan/history` | `?plan_id=` → events, executions, approvals |
| GET | `plan/deliverables` | `?plan_id=` → review, final report, latest output per task |
| GET | `approvals` | pending approvals |
| POST | `plan/cancel` | `{ plan_id, requested_by, reason? }` |
| POST | `task/retry` | `{ plan_id, task_id, requested_by }` (failed tasks only) |
| POST | `approval/decision` | `{ approval_id, decision: approved\|rejected, decided_by, note? }` |
| POST | `task/direct` | `{ employee_id, text, requested_by? }` → one-task plan for that employee (no CEO planner) |
| GET | `results/recent` | `?limit=` latest task outputs with one-line summaries |
| GET | `task/output` | `?plan_id=&task_id=` full output of one task, with `approval` and `library_status` |
| GET | `library` | `?department_id=&employee_id=&status=active\|new\|used\|archived\|all&approval=&q=&limit=&offset=` → `{ total, counts, items }` |
| POST | `library/status` | `{ plan_id, task_id, status: new\|used\|archived, updated_by }` |
| GET | `integrations` | non-secret integration settings + last test (the dashboard adds `n8n_admin.configured`) |
| POST | `integrations/config` | `{ service, config, secret_saved, updated_by }`, called by the dashboard server after it patched the n8n credential (not exposed to browsers) |
| POST | `integrations/test` | `{ service: linkedin\|circle\|wecommitdw }` → `{ ok, message, at }` (workflow G) |

`context` is shared with every task (e.g. `transcript`, `brand_guidelines`, `system_data`, `community_data`, `question`, `knowledge_sources`). Do not put secrets in it: it is stored in `wf.plans.request` and sent to the model.

PowerShell helper: `. .\scripts\workforce-api.ps1; Invoke-WorkforceApi POST requests (Get-Content -Raw tests\requests\youtube-linkedin.json)`.

## Testing

| What | How | Verified 2026-10-12 |
|---|---|---|
| State machine (deps, retries, blocking, review-once, approvals, cycles, FK checks) | `Get-Content -Raw db/tests/test-task-state.sql \| docker exec -i wf-postgres psql -U workforce -d workforce -v ON_ERROR_STOP=1` | 12 checks pass |
| Content library (department scoping, search, archive/restore, errors as data) | `docker cp db/tests/test-library.sql wf-postgres:/tmp/t.sql; docker exec wf-postgres psql -U workforce -d workforce -v ON_ERROR_STOP=1 -f /tmp/t.sql` | pass (2026-10-14) |
| Integration settings (allow-listed keys only, validation, test results) | `docker cp db/tests/test-integrations.sql wf-postgres:/tmp/t.sql; docker exec wf-postgres psql -U workforce -d workforce -v ON_ERROR_STOP=1 -f /tmp/t.sql` | pass (2026-10-14) |
| Duplicate-dispatch prevention | `bash db/tests/test-concurrent-claim.sh` (8 sessions race for 6 tasks) | 6 claims, 0 duplicates |
| Code-node logic (plan validation, cycle detection, employee guards, review rules) | `node workflows/build-workflows.js; node tests/code-nodes/run-code-node-tests.js` | 14/14 pass |
| Single + dependent tasks, task approval, revision cycle, final reject | `tests/requests/youtube-linkedin.json` | pass |
| Parallel tasks + fan-in dependency | `tests/requests/parallel-ops-community.json` | T1–T3 claimed at the same ms, T4 started after the last prerequisite |
| Non-retryable failure → blocked → manual retry → cancel | `tests/requests/failure-missing-timestamps.json` | pass |
| Retryable failure with backoff via the scheduler | point an employee's `workflow_reference` at a missing workflow, create a plan | 3 attempts, then failed + plan blocked |
| Remaining employees (Repurpose, Knowledge & Support) | `tests/requests/repurpose-and-support.json` | pass |

## External integrations

| Integration | Status | How |
|---|---|---|
| YouTube content | **Live** (tested 2026-10-12) | oEmbed for the real title/channel; when no transcript is supplied, `gemini-3.5-flash-lite` watches the public video (`file_data.file_uri`, low media resolution) and returns a timestamped transcript. Output marks `transcript_source: gemini_video_transcription`. Direct caption download is blocked by YouTube (empty body). |
| LinkedIn (personal profile, text + image) | **Built, needs the user's LinkedIn app + Connect** (entered on the dashboard page "Kết nối & tài khoản") | Workflow F posts only for `completed` (human-approved) plans, once per plan (`wf.publications`, unique live index). Without the credential it records `failed` with the reason. |
| Images (Visual Design) | **Live** (tested 2026-10-12) | The agent writes a card spec (headline, 2-4 points, highlight number, brand palette) from the source only; the internal `wf-renderer` service (rough.js + resvg + Patrick Hand / Be Vietnam Pro fonts) draws a sketch-style PNG into `data/assets`, served by the dashboard at `/assets/*`. Pollinations.ai was tried and dropped (off-topic images, forced watermark). |
| Circle | **Token entry + connection test built**; the agent does not read Circle yet | Test calls `GET https://app.circle.so/api/admin/v2/community_members?per_page=1` with `Authorization: Bearer <Admin V2 token>` (verified to reach Circle: without a token it answers 401 "API token not found"). |
| WeCommitDW | **Connection entry + test built**; the agent does not query it yet | PostgreSQL / MySQL / SQL Server (test runs one `SELECT` of database, user, version) or HTTP API (GET with Bearer token). Verified: PostgreSQL success + wrong password, MySQL/SQL Server unreachable host, HTTP GET. |

### Integrations page ("Kết nối & tài khoản", `#settings`)

The dashboard sidebar has a **Hệ thống → Kết nối & tài khoản** page with one card per service (n8n admin key, LinkedIn, Circle, WeCommitDW) showing setup steps, fields, "Lưu" and "Kiểm tra kết nối".

- **Secrets never leave n8n's credential store.** `dashboard/integrations.js` (server side) writes them with the n8n public API `PATCH /api/v1/credentials/{id}` (`isPartialData: true`, so a blank secret field keeps the stored value). They are not stored in Postgres or files, not logged, and never returned to the browser.
- **One-time n8n API key:** created by the user in n8n (Settings → n8n API), pasted in the page, validated against `GET /api/v1/credentials`, kept in `data/dashboard/n8n-api-key` (mode 600, git-ignored, mounted into the dashboard container) or env `N8N_API_KEY`. It grants full n8n API access: anyone who can use this machine already can.
- **Fixed-id credentials** (`wfLinkedInCred01`, `wfCircleCred0001`, `wfWcdwPgCred001`, `wfWcdwMyCred001`, `wfWcdwMsCred001`, `wfWcdwApiCred01`) are created empty at deploy by `scripts/ensure-integration-placeholders.js`, only when missing (an existing, filled credential is never overwritten), so workflows keep stable references.
- **Non-secret settings** (Circle URL, WeCommitDW kind/host/port/database/user/SSL or base URL, LinkedIn client id hint) and the last test result live in `wf.integration_settings` (`db/integrations.sql`); `wf.save_integration_config` rejects any key outside a per-service allow-list, so a password typed in a wrong field cannot land in the database.
- **LinkedIn** still needs the OAuth consent in n8n: after saving Client ID/Secret, "Mở n8n để Connect" opens the credential, the user clicks Connect. Tokens last 60 days (no refresh for standard apps).
- **Connection test:** workflow G `wfgIntegrations1` (`POST workforce/integrations/test { service }`) makes one read-only call with the stored credential, explains the usual cause (no OAuth token, 401, unreachable host, wrong password) and stores the result. The n8n Postgres node drops the error text on failure, so PostgreSQL failures get a generic explanation.
- Hosts must be reachable from the n8n container (`localhost` is the container itself; use `host.docker.internal` for this machine). Read-only accounts are recommended.

API: `GET plan/publications?plan_id=`, `POST plan/publish-linkedin { plan_id, requested_by }`.

## Limits and manual setup still needed

- **Not configured:** AI illustration (Gemini image models need billing; the free tier quota is 0). Circle, WeCommitDW and LinkedIn accounts are entered on the "Kết nối & tài khoản" page; the Circle and WeCommitDW agents still analyze pasted data only (live fetching is the next step once a connection test passes).
- **Gemini free tier:** `gemini-3.5-flash` has ~20 requests/day; the system uses the lite models. A video transcription costs ~100k input tokens.
- **Knowledge base is empty:** add approved articles to `wf.knowledge_articles`, otherwise the Knowledge agent escalates unless sources are supplied.
- **Cancel does not kill in-flight n8n executions:** their results are discarded (`complete_task` accepts only running executions).
- **Free-tier Gemini:** Pro models return 429; Flash can return 503 during demand spikes (node retries + fallback model + task retries absorb most of it). Max 3 running tasks per plan (`MAX_RUNNING_PER_PLAN`).
- **Request headers (including `X-API-Key`) appear in n8n execution data** for the planning workflow; the Dashboard API does not store successful executions. n8n's own UI is protected by its login.
- **Dashboard has no login of its own:** it listens on 127.0.0.1 only; anyone using this machine can act through it.
- **Deploy SQL with `docker cp` + `psql -f`** (as `deploy-workforce.ps1` does): piping files from Windows PowerShell 5.1 corrupts Vietnamese text.
