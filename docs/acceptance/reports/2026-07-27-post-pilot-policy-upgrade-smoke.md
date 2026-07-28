# Post-pilot policy upgrade and OCR degradation smoke

- Date: 2026-07-27 (Asia/Shanghai)
- Candidate SHA: `3ccd58590d82ef45cf9daa8142c3dddb89b19115`
- Acceptance tooling SHA: `0436d91847360b13543724a4324e0855a164d8de`
- Scope: control-plane schema upgrade, document policy routing, MinerU unavailable behavior
- Result: **PASS**
- Evidence worktree: **clean** (`git_status_porcelain=""`)

## Baseline gates

| Gate | Result |
|---|---|
| API full pytest | PASS — 306 passed, 8 skipped |
| OCR/MinerU/lifecycle focused pytest | PASS — 68 passed |
| Web tests | PASS — 93 passed, 3 skipped |
| Web lint | PASS |
| Production build | PASS |
| Drizzle schema check | PASS |

Warnings are dependency deprecations only (Starlette TestClient/httpx and SWIG
types); they did not fail the gates.

## Real `0007` to `0009` schema upgrade

The upgrade was run against a dedicated PostgreSQL 17 container:

1. A detached `b98f014` worktree applied its migrations `0000` through `0007`.
2. The old schema was confirmed to contain 8 Drizzle migration records and no
   `app.libraries.document_profile` column.
3. A legacy organization, workspace, user, library, workspace settings row,
   document, and document version were inserted.
4. Candidate `3ccd585` applied migrations `0008` and `0009`.
5. The current migration command was run a second time to verify idempotency.

Post-upgrade checks:

| Check | Result |
|---|---|
| Drizzle migration count | 10 |
| Legacy library retained | PASS |
| Library `document_profile` default | `auto` |
| Library `scan_handling` default | `auto` |
| Library `ingest_policy_version` default | `1` |
| Existing workspace `ask` JSON retained | PASS |
| Workspace `policy_version` default | `1` |
| Existing document version retained | PASS |
| New document-version policy snapshot fields | `NULL` for the legacy row |
| Second migration run | PASS |

The temporary database container and old worktree were removed after the
verification.

## MinerU unavailable and scan-policy behavior

The real HTTP adapter targeted an unbound localhost port with retries disabled.
The observed failure was `MinerU unreachable: [Errno 61] Connection refused`.

| Case | Result | Route / error |
|---|---|---|
| `auto`, mixed text + scanned pages | PASS — retained extractable text and marked partial | `pymupdf_degrade`, `mineru_unreachable` |
| `auto`, pure scanned PDF | PASS — explicit failure; no empty success | `mineru_failed`, `mineru_unreachable` |
| `disabled`, mixed text + scanned pages | PASS — text-only partial result; no MinerU request | `pymupdf_text_only` |
| `disabled`, pure scanned PDF | PASS — explicit policy failure | `scan recognition is disabled by library policy` |
| `force_ocr`, pure scanned PDF, no Tesseract and no MinerU | PASS — explicit failure | local OCR unavailable, then `mineru_failed` |

`scan_handling=disabled` resolved to:

- `ocr_enabled=false`
- `enhanced_parser_allowed=false`

Therefore it cannot consume a MinerU slot or issue a MinerU HTTP request.

## Important interpretation

Degradation is possible only when the base parser produced trustworthy text.
A pure scan has nothing safe to retain, so succeeding with an empty or invented
document would be incorrect. Its expected terminal state is an explicit failed
ingest when both local OCR and MinerU are unavailable.

## Acceptance automation follow-up

`scripts/acceptance/b3_b4_upgrade_rollback.sh` was originally written while the
old and new candidates had no control-plane migration delta. Its bootstrap phase
used the new migration tools before starting the old application. This gap was
fixed during this verification:

- OLD and NEW now run from separate detached SHA worktrees.
- Source initialization uses OLD control-plane and RAG migrations.
- Upgrade uses NEW control-plane and RAG migrations.
- OLD and NEW Web images use separate SHA-scoped tags and are built on demand.
- The script asserts that each worktree's Drizzle journal count matches the
  database migration count.

The corrected B3 run recorded source migration count `8`, target count `10`, and
passed the post-upgrade application/data/Qdrant verification suite.

## Local artifacts

- Corrected B3 upgrade report:
  `scripts/acceptance/.b3_b4_last_run.json`
- B3 report SHA-256:
  `cd9b7e2611c834907e8dbde827ce21130810dadaa56ec51620f4d1644f1cefce`
- OCR policy report:
  `scripts/acceptance/.ocr_policy_last_run.json`
- OCR policy report SHA-256:
  `d12a23c38ffd2c884eb825772d5b55a165274f2bc396db1f5b2982586a7bc01a`
- SHA-scoped Web images:
  `unorag-web:b3-old-b98f01438045`,
  `unorag-web:b3-new-3ccd58590d82`

The generated JSON evidence remains local and gitignored; this Markdown report
contains only sanitized bindings and outcomes.
