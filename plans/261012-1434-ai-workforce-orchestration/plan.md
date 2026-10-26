# AI Workforce Orchestration in n8n

Status: done (2026-10-12) — all 3 phases implemented, deployed locally and tested. Details: `docs/workforce-system.md`.

## Decisions
- Local Docker: n8n 2.42.6 (SQLite for n8n itself) + separate PostgreSQL 16 (`wf-postgres`) as source of truth.
- All task state transitions are SQL functions in schema `wf` (atomic claim via plan row lock + `FOR UPDATE SKIP LOCKED` + status guard + unique running-execution index).
- LLM: Gemini `gemini-3.5-flash`, fallback `gemini-3.5-flash-lite` (free tier; Pro returns 429; `gemini-2.5-flash` returned empty responses through the n8n agent).
- Workflows generated from `workflows/src` by `workflows/build-workflows.js`, imported with n8n CLI, fixed workflow IDs.
- Event-driven dispatch + 1-minute poller (stale executions, retry backoff, stalled reviews).
- API: static webhook paths (path params need a webhook-id prefix in n8n), `wf.api()` returns errors as data because the n8n Postgres node drops DB error text.

## Phases
1. DB schema + functions, compose, credentials — done
2. Workflows A–E + 8 employees — done
3. Deploy script, tests (SQL, concurrency, code nodes, 5 E2E scenarios), docs — done

## Open items
- Integrations not configured: YouTube transcripts, image generation, Circle API, WeCommitDW live access, publishing.
- Knowledge base empty.
- Rotate the Gemini API key (it was pasted in chat).
