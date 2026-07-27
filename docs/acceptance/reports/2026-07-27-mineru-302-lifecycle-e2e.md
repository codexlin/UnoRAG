# MinerU 302 Lifecycle Black-box E2E — 2026-07-27

## Scope

Black-box lifecycle acceptance against private Compose (`meriknow-private`,
`http://localhost:8088`) with temporary `MINERU_PROVIDER=302ai` on
**lifecycle-worker only**. Credential was injected for this run only and removed
afterward. Full API key never appears below (last4 only if needed: `…tgNH`).

## Environment

| Item | Value |
|---|---|
| Compose project | `meriknow-private` |
| HTTP | `:8088` |
| Fixture | `testdata/ab/crosstable-large.pdf` (64,840 bytes) |
| Worker flags (temporary) | `MINERU_ENABLED=true`, `MINERU_PROVIDER=302ai`, `EXTERNAL_PARSER_ALLOWED=true`, `MINERU_302_API_KEY` set |
| API / Web | Recreated worker only; API/Web kept defaults and **no** 302 key |
| Admin login | `admin@example.com` via `deploy/config/bootstrap.env` (`.smoke-admin-password` did **not** authenticate) |

## Browser access

| Path | Result |
|---|---|
| cursor-ide-browser MCP | **FAIL** — `browser_tabs` create returns a `viewId`, then the tab vanishes; `browser_navigate` / `browser_lock` report “No browser tab available” / “Browser view not found”. Reproduced with `localhost`, `127.0.0.1`, and `example.com`. |
| Fallback | **PASS** — Playwright Chromium (“Google Chrome for Testing” from local ms-playwright cache) against `http://localhost:8088` |

UI evidence used for login → libraries → upload → status → ask. MCP blocker is
environmental; stack and app were reachable over HTTP (`/api/rag/health` 200).

## Step results

| Step | Result | Notes |
|---|---|---|
| 1. Inject 302 env on worker only | **PASS** | `docker inspect`: worker had key + `302ai`; api/web had no nonempty `MINERU_302_API_KEY` |
| 2. Health `:8088/api/rag/health` | **PASS** | `status=ok`, `live_ready=true` |
| 3. Browser open `:8088` | **PASS*** | Via Playwright; MCP failed (see above) |
| 4. Login | **PASS** | Bootstrap admin password; smoke file rejected |
| 5. Upload `crosstable-large.pdf` | **PASS** | Library `302-e2e2-318189`; UI showed file |
| 6. Lifecycle pending → lease release → resume → completed via **302** | **FAIL** | First poll returned provider state `STARTED`; adapter treated it as terminal `mineru_service_error` and **degraded** to PyMuPDF (`nodes=3`). UI then `处理中` → `就绪` without 302 SUCCESS/ZIP path |
| 7. Worker restart mid-flight | **PASS** | `docker restart` while UI still `处理中`; worker returned healthy |
| 8. Resume via saved `task_id` / no duplicate submit | **PARTIAL** | Observed **one** `POST …/302/v2/mineru/task` and **one** task id (`bbbd…4851`) in the follow-up window; pending/resume lease-release path was **aborted** by the STARTED misclassification before multi-poll resume could be proven |
| 9. Ask / Retrieve table content + citations | **FAIL** | Ask returned `REFUSED · LIVE` / 无命中; no usable table citations. Consistent with degrade quality on this fixture |
| 10. Logs: no Bearer key on download path; no key in parser path | **PASS** | Worker logs show upload/task/poll URLs only; no `Bearer sk-…` / `MINERU_302_API_KEY=sk-…` |
| 11. Pending does not burn attempts while waiting | **FAIL / N/A** | Pending wait never established; STARTED → immediate degrade. `attemptish` log hits = 0 in window; cannot accept pending-attempt invariant from this run |
| 12. Restore defaults; no temp key in containers | **PASS** | Restored `runtime.env` / `runtime.secret`; recreated worker. Worker: `MINERU_ENABLED=false`, `MINERU_PROVIDER=self_hosted`, `EXTERNAL_PARSER_ALLOWED=false`, `MINERU_302_API_KEY` empty. API/Web: key absent |

\*Counted PASS for product reachability with Playwright when MCP was unusable.

## Root cause (blocking)

In `apps/api/app/services/ingest/backends/mineru.py`, 302 poll treats only
`PENDING|QUEUED|SUBMITTED|RUNNING|PROCESSING` as in-flight. Live 302 responses
used **`STARTED`**, which fell through to:

`302 MinerU task failed: STARTED` → `mineru_service_error` → PyMuPDF degrade.

That prevents:

- lease release while waiting on 302
- resume by saved `task_id`
- real 302 ZIP → Chinese complex-table IR for Ask

**Suggested fix (not applied in this run):** add `STARTED` (and any other
documented non-terminal states) to the pending set, then re-run this E2E.

## Redacted identifiers

| Kind | Value |
|---|---|
| 302 task id | `bbbd…4851` |
| Job id (ingest) | `53ac…225d` |
| API key | injected then removed; last4 `tgNH` only |

## Overall

**FAIL** for 302 lifecycle acceptance.

Setup isolation, health, login, upload, mid-flight worker restart, single task
submit evidence, and secret hygiene **passed**. End-to-end 302 pending/resume/
indexed-via-302 and table Ask quality **failed** due to `STARTED` handling.

## Cleanup / security

- Temporary key removed from Compose secret/env; worker recreated.
- Containers verified with no nonempty `MINERU_302_API_KEY`.
- MinerU restored to disabled / self-hosted defaults.
- **Rotate the exposed temporary 302 API key** (it appeared in chat/ops context
  for this run).

## Appendix — root-cause fix (pending E2E re-run)

Code fix landed in `apps/api/app/services/ingest/backends/mineru.py`:
`classify_302_task_state` treats `STARTED` (plus `WAITING` / `IN_PROGRESS`) as
in-progress → `MinerUPendingError`, not `mineru_service_error`. Unit coverage in
`apps/api/tests/test_mineru_302_provider.py` asserts `STARTED` never maps to
service_error. **This report’s overall FAIL still stands until the lifecycle
E2E is re-run** with temporary 302 credentials on the worker.
