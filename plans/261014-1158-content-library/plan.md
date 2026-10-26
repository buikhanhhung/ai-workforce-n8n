# Content Library per Department

Status: done (2026-10-14) — deployed; SQL test, code-node tests and a browser check (CEO + 3 department scopes, status change survives F5) pass.

## Goal
Everything the agents produce is visible and manageable in the dashboard, scoped like the rest of the UI:
CEO tab = whole company, department tab = only that department's agents.

## Decisions
- Library item = latest output of a task (`wf.task_outputs`), attributed to the task's department.
- Management state (new / used / archived) stored in `wf.library_items` (shared by all users, not localStorage).
- Approval shown from the plan status (awaiting approval / approved / rejected / cancelled).
- Readable renderers per output type in the dashboard; generic key-value fallback for unknown shapes.
- Copy and download (.md text, image file) are client side. Editing content: not in this scope.

## Phases
1. DB: `db/library.sql` (table, `wf.api_library`, `wf.set_library_status`, `wf.api` actions), deploy order, SQL test.
2. API: workflow E endpoints `GET workforce/library`, `POST workforce/library/status`; dashboard proxy allowlist.
3. UI: view switch "Điều hành / Thư viện", filters, search, cards, type renderers, copy/download, status actions.

## Acceptance
- Department tab lists only its agents' outputs; CEO tab lists all.
- Filters by agent, management status, approval; text search; paging.
- Status changes persist after F5 and are visible to other browsers.
- Existing tests still pass.
