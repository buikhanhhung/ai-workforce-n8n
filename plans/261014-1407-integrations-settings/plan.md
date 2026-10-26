# Integrations Settings Page (LinkedIn, Circle, WeCommitDW)

Status: done (2026-10-14) — deployed. Verified: SQL test; placeholder script idempotent; connection tests
(LinkedIn no-token, Circle 401 from the real API, PostgreSQL success + wrong password, MySQL/SQL Server unreachable,
HTTP GET); browser check (wrong n8n key rejected, save without n8n key explained, secret fields cleared).
Not verifiable without the user's accounts: real PATCH of a credential (needs the n8n API key), LinkedIn Connect.

## Goal
Users enter the LinkedIn app, Circle Admin API token and WeCommitDW connection in the dashboard,
then test each connection, without opening n8n (except LinkedIn's OAuth "Connect", which n8n must run).

## Decisions
- Secrets go only into n8n's encrypted credential store, through the n8n public API
  (`PATCH /api/v1/credentials/{id}`, `isPartialData`). Never stored in Postgres, never sent back to the browser.
- Fixed-id placeholder credentials are created at deploy (CLI import, only when missing) so workflows keep stable references:
  `wfLinkedInCred01`, `wfCircleCred0001`, `wfWcdwPgCred001`, `wfWcdwMyCred001`, `wfWcdwMsCred001`, `wfWcdwApiCred01`.
- n8n API key: pasted once in the page, kept server-side in `data/dashboard/n8n-api-key` (or env `N8N_API_KEY`).
- Non-secret config (Circle URL, WeCommitDW kind/host/db/user, LinkedIn client id hint) + last test result: `wf.integration_settings`.
- Connection test: workflow G (`wfgIntegrations1`) makes one real call per service with the stored credential.
- WeCommitDW kinds: PostgreSQL, MySQL, SQL Server, HTTP API (system type unknown). Read-only accounts recommended.
- Out of scope: making Circle Checker / WeCommitDW Checker fetch live data (next step once tokens work).

## Phases
1. DB `db/integrations.sql` + SQL test; deploy order; placeholder script.
2. Workflow G (test) + E endpoints (get settings, save config); proxy allowlist.
3. Dashboard server module `dashboard/integrations.js` (n8n key, PATCH credentials).
4. UI: sidebar "Kết nối & tài khoản" (`#settings`), three service cards + n8n key card.

## Acceptance
- Saving never echoes secrets; blank secret fields keep the stored value.
- Test button reports the real error (e.g. wrong password, no OAuth token) or success.
- Deploy does not overwrite credentials the user already filled.
