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
| API / Web | Recreated **worker only**; API kept prior defaults and **no** 302 key |
| Code under test | `4deed36` (`STARTED` → in-progress / `MinerUPendingError`); image rebuilt `meriknow-api:local` |
| Admin login | `admin@example.com` via `deploy/config/bootstrap.env` |

## Browser access

| Path | Result |
|---|---|
| cursor-ide-browser MCP | **SKIP** — previously flaky (tabs vanish); not used this re-run |
| Playwright Chromium | **PASS** — “Google Chrome for Testing” (`ms-playwright` chromium-1217) against `http://localhost:8088` |

## Step results (re-run after `STARTED` fix)

| Step | Result | Notes |
|---|---|---|
| 1. Inject 302 env on worker only | **PASS** | `docker inspect`: worker had key + `302ai`; api/web had no nonempty `MINERU_302_API_KEY` |
| 2. Health `:8088/api/rag/health` | **PASS** | `status=ok`, `live_ready=true` |
| 3. Browser open `:8088` | **PASS** | Via Playwright |
| 4. Login | **PASS** | Bootstrap admin password |
| 5. Upload `crosstable-large.pdf` | **PASS** | Library `302-e2e3-863463`; UI showed file |
| 6. Lifecycle pending → lease release → resume → completed via **302** | **PASS** | Real 302 path: `POST /302/upload-file` → **one** `POST /302/v2/mineru/task` → `GET …/task?task_id=…` → ZIP from `file.302.ai` → embed/index. UI `处理中` → `就绪`. No `STARTED`→`mineru_service_error`, no PyMuPDF degrade. In-container `classify_302_task_state("STARTED")==pending`. Live poll this run returned SUCCESS on first GET (STARTED not observed in logs). |
| 7. Worker restart mid-flight | **PASS** | `docker restart` while UI `处理中`; worker returned healthy. Job finished on the dying worker during restart window (ZIP before new `lifecycle_worker.start`) |
| 8. Resume via saved `task_id` / no duplicate submit | **PASS** | Exactly **one** `POST …/302/v2/mineru/task` and **one** task id (`3382…1943`); no second create after restart |
| 9. Ask / Retrieve table content + citations | **PASS** | Ask returned LIVE answer with Chinese table fields + `mineru-t1`/`mineru-t2` citations (滨海市政府采购中标明细) |
| 10. Logs: no Bearer key on download path; no key in parser path | **PASS** | Worker logs show upload/task/poll/ZIP URLs only; no `Bearer sk-…` / `MINERU_302_API_KEY=sk-…` |
| 11. Pending does not burn attempts while waiting | **PASS** | `requeue_mineru` + `slot_released` observed; `attemptish` log hits = 0; no STARTED→error degrade |
| 12. Restore defaults; no temp key in containers | **PASS** | Restored `runtime.env` / `runtime.secret`; recreated worker. Worker: `MINERU_ENABLED=false`, `MINERU_PROVIDER=self_hosted`, `EXTERNAL_PARSER_ALLOWED=false`, `MINERU_302_API_KEY` empty. API/Web: key absent |

## Comparison to prior FAIL run

Prior run (`f48472e` report body) failed because first poll `STARTED` mapped to
`mineru_service_error` → PyMuPDF degrade (`nodes=3`) → Ask refused.

Fix `4deed36` adds `STARTED` / `WAITING` / `IN_PROGRESS` to the in-progress set.
This re-run completed via **302 ZIP** with table IR citations; Ask quality recovered.

## Redacted identifiers

| Kind | Value |
|---|---|
| 302 task id | `3382…1943` |
| Job id (ingest) | `ec91…2e2b` |
| Library | `302-e2e3-863463` |
| API key | injected then removed; last4 `tgNH` only |

## Overall

**PASS** for 302 lifecycle acceptance (re-run after `STARTED` fix).

Setup isolation, health, login, upload, mid-flight worker restart, single task
submit, 302 ZIP completion, indexed Ask with table citations, and secret hygiene
**passed**. Live STARTED state was not observed on this poll (first GET already
SUCCESS); pending classification is covered by unit tests + in-container
`classify_302_task_state("STARTED") → pending`.

## Cleanup / security

- Temporary key removed from Compose secret/env; worker recreated.
- Containers verified with no nonempty `MINERU_302_API_KEY`.
- MinerU restored to disabled / self-hosted defaults.
- **Rotate the exposed temporary 302 API key** (it appeared in chat/ops context
  for this run).
