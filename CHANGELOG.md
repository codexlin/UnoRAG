# Changelog

This file records user-visible UnoRAG changes. Release evidence and environment-specific acceptance
results remain in [`docs/evidence/`](./docs/evidence/).

## [Unreleased]

## [0.4.1] - 2026-11-24

- **Deployment rerank kill-switch & Ask policy optimistic locking (#320)**:
  - Add `TS_RETRIEVAL_RERANK_ALLOWED` deployment-level kill-switch so operators can disable reranking globally even when workspace settings request it.
  - Enforce same-origin checks, `policy_version` optimistic locking (`409` on stale concurrent writes), and transactional audit logging on `PATCH /api/workspace/settings`, with aligned bilingual Workspace Settings UI.
- **Grounded table lookup hardening & live retrieval accuracy fixes (#322, #323, #324)**:
  - Guard duplicate/omitted table headers in `deriveGroundedTableLookup()` and `selectRowValues()`, eliminating uncaught `TypeError` (HTTP `503`) failures on financial tables with repeated column headers.
  - Enable parent `section` expansion for table-projection chunks (`record_type === "chunk" && !figure_id`) so surrounding footnotes, units, and split-table continuations stay attached while keeping prose sibling lookup untouched; broaden `baseTopK` to `>= 10` for derived calculation queries (e.g., static P/E, CAGR, ratios).
  - Add bounded adjacent micro-section coalescing (`src/core/retrieval/section-window.ts`) for short numbered chapters and sequential Arabic/Chinese sub-items within the existing tenant/workspace/library/document/generation/ACL boundary, and infer nested heading depths in `mineru-provider.ts` when MinerU outputs flattened `text_level: 1` headings.
- **UI zoom layout, evaluation cost controls & dependency maintenance (#311, #321, #325)**:
  - Fix 200%-zoom wrapping in `workspace-ask-settings-panel.tsx` and align the full 324-test Playwright E2E suite.
  - Raise default ingestion timeout in `scripts/evaluation/run-hf-benchmark.ts` to 60 minutes with fail-fast on incomplete corpora unless `--allow-incomplete-corpus` is set, and add `--reuse-or-create [name]`, `--only-ids <csv>`, and `--only-failed-from <report.json>` for zero-reingest and targeted regression reruns.
  - Apply Dependabot maintenance bump for `tools/landing-video` (#311).
- **Upgrade note**: Upgrading from `v0.4.0` requires no database migration, configuration change, or mandatory reindex. Adjacent micro-section coalescing improves existing indexed corpora immediately; reindexing PDFs additionally persists inferred MinerU heading depths.

## [0.4.0] - 2026-11-24

- **Token-aware chunking (`v2`) & balanced comparison context (#308)**:
  - Introduce a deterministic pure-TypeScript token estimator (`src/core/text/token-estimate.ts`) for CJK/Latin/symbol-mixed text and advance default chunking to `CHUNK_POLICY_VERSION = "v2"` (400 tokens target / 60 overlap / 1,800-char cap), while keeping explicit character `chunkSize` overrides backward compatible.
  - Auto-select `table_heavy` when Markdown tables exceed 40% of a document's text volume (zero extra LLM cost).
  - Budget parent context expansion by estimated tokens (`1,200` tokens / `4,500`-char hard cap) and allocate comparison context (`8,000` tokens) evenly across subjects via round-robin while preserving contiguous verbatim conflict excerpts.
- **Default-on Hybrid retrieval, short-term memory compaction & embedding preflight (#307, #300)**:
  - Require Qdrant server-side named Dense + `lexical_v1 (modifier: "idf")` Sparse/RRF and remove the 10,000-chunk application-layer BM25 fallback.
  - Enable Hybrid retrieval by default for workspaces while preserving independent workspace (`on`/`off`/`auto`) and deployment-level (`TS_RETRIEVAL_HYBRID_ENABLED=false`) kill-switches, and keep `auto`-mode first-pass reranking for retrieval-sensitive questions.
  - Compact long assistant replies into bounded structured context projections when building model prompt history, leaving archived full text and `MemoryProvenance` untouched.
  - Detect Qdrant/Embedding dimension mismatches at startup, `/api/rag/health`, and ingestion preflight with actionable, credential-safe operator guidance.
- **Ephemeral Retrieval Trace Inspector (#306)**:
  - Add Admin/Editor-only (`writeLibraries`, excluding `service_key`) ephemeral `include_trace_details: true` inspection on `/api/rag/ask` (JSON and SSE) showing coarse Top-K vs reranked/selected diff, dropped candidates with fresh ACL reauthorization, `cache-control: no-store`, and `ScopedRetrievalCache` bypass.
  - Keep persisted request logs 100% `metadata-only` (no raw chunks or snippets stored) and surface a 4-section trace drawer in Ask UI.
- **Streamlined deployment configuration & hot workspace policies (#305, #304)**:
  - Add canonical environment aliases (`LLM_API_KEY`, `LLM_BASE_URL`, `UNORAG_BASE_URL`) and slim `deploy/config/runtime.advanced.env.example` (108 → 74 keys) while preserving legacy overrides during `init-config.sh`.
  - Add workspace-level alert thresholds (`alert_thresholds` JSONB with optimistic `alert_policy_version` locking) and independent Hybrid/Rerank controls editable live in Workspace Settings.
  - Consolidate documentation, slim `docs/DESIGN.md`, calibrate ADR-0002/0003/0005/0007/0008, and remove legacy residue.
- **Pre-release security, RAG, UI & deployment hardening (#313–#318)**:
  - **Security, ACL & DBOS lifecycle (#313, #316)**: Prevent `removeWorkspaceMember` from turning sole-grantee restricted documents workspace-wide public (preserving locked-down ACL, triggering `document.acl.project`, revoking active sessions, and writing audit logs); enforce same-origin checks on Cookie write endpoints, `POST /api/auth/password` length/rate limits, fail-closed Service Key scope/`library_ids` validation, and cross-provider credential origin binding; fix custom `library_id` figure asset FK errors, pre-dispatch cancelled jobs starving DBOS reconciliation, and `cancel` overwriting `deleting` tombstones.
  - **RAG core, tables, parsing & prompt fidelity (#313, #317, #318)**: Fix `grounded_table_lookup` Judge retry loop, score sparse-only exact hits when Rerank is off, deduplicate after full reranking rather than truncating `topN` prematurely, fix unit-scaled table aggregation (`万元`/`%` headers and JSON numeric predicates), bound oversized `table`/`code` chunks, detect numeric/year sub-headers in merged XLSX tables, populate MinerU `section_path` and scoped `record_id` parent/sibling expansion, guard `ScopedRetrievalCache` (`expandParentContext` and non-caching degraded results) and MinerU redirect/ZIP bounds, and restore parallel-metric qualifier preservation in `chat@1.17.0`.
  - **UI contrast, Ask state isolation & bilingual coverage (#313, #315)**: Bring all 4 built-in themes (light/dark) and hover/highlight states to WCAG AA (`>= 4.5:1`), isolate Ask cross-thread/library state and archived trace authorization, surface `health.recovery` guidance and localize remaining English-mode labels/toasts/errors, distinguish post-retrieval trace outcomes, and align the full 5-spec Playwright suite.
  - **Compose, Helm, alerting & release pipeline (#314)**: Wire missing COS environment variables to Helm `dbos-worker` and per-privilege runtime role grants/verification to Helm migrations, align Compose `web` and `dbos-control` Qdrant settings, support `critical -> warning` alert de-escalation with peak-severity recovery emails and per-workspace control-cycle isolation, fix `init-config.sh` typo, and gate GHCR/ACR image publishing behind Trivy vulnerability scans.
- **Product UI, bilingual i18n & evaluation tooling (#299, #301, #309)**:
  - Add browser-aware EN/ZH interface language switching, redesigned landing and auth shells, 4 built-in themes (`vercel`, `claude`, `violet-bloom`, `modern-minimal`) with circular View Transitions toggle, and server-side audit filtering/CSV export.
  - Add bounded `--concurrency <1..8>` execution to `scripts/evaluation/run-hf-benchmark.ts`.
- **Upgrade note**: Apply migration `0036` (`drizzle/0036_workspace_alert_thresholds.sql`) using the documented drain/backup procedure. Fresh and upgraded deployments require a Qdrant collection with named Dense + `lexical_v1 (modifier: "idf")` sparse vectors; on pre-v0.4 collections without `lexical_v1`, recreate the collection or switch `QDRANT_COLLECTION_NAME` before serving traffic.

## [0.3.6] - 2026-11-21

- Recognize supported Chinese query verbs attached directly to filenames. Exact
  filenames still take precedence, quoted names remain literal, and ambiguous or
  inaccessible sources are not used as evidence.
- No database migration, configuration change, or reindex is required.

## [0.3.5] - 2026-11-20

[Release acceptance](./docs/evidence/2026-11-20-v0.3.5-release.md) covers the exact
signed build, the test-only browser rerun, and the Hong Kong rollout.

- Accept multi-sheet Excel workbooks with bounded decompression and structured
  table extraction. Add optional MinerU figure crops and opt-in model-assisted
  chart reading; figure access follows the active document version and ACL.
- Expand retrieved context within the same authorized generation, bound
  comparison context, and support deterministic arithmetic. Selective conflict
  bypass remains opt-in; normal fact verification stays enabled by default.
- Add a guarded sparse-vector backfill for a new collection without re-embedding.
  It is an operator tool, not an automatic upgrade step.
- Let qualified first-turn document descriptions reach authorized retrieval and
  evidence judgment. Bare references and references remaining elsewhere in the
  question still require clarification; a description does not prove identity.
- Ground follow-up retrieval, table planning and evidence judgment in entities from
  recent, continuously authorized conversation history. Keep the original question
  in archives; history never substitutes for current authorized evidence.
- Preserve bounded clarification choices across temporary sessions and archives.
  Unknown choices do not renew the five-minute deadline; expired, revoked, replaced
  or deleted sources cannot be revived by old conversation text. Private memory
  provenance stays out of public conversation/debug responses.
- Track accepted asynchronous document deletion until its actual terminal state.
  Prevent stale list responses and cross-library navigation from hiding jobs or
  updating the wrong cache; failed deletion remains visible and retryable.
- Preserve a deleted-library tombstone for empty libraries, matching asynchronous
  deletion and avoiding foreign-key failures when archived conversations remain.
- Add a versioned multi-turn acceptance matrix using real product APIs and isolated
  synthetic libraries. The runtime release gate includes clarification expiry;
  development runs and skipped scenarios cannot grant release approval.
- Stop old topics from competing with a newer explicit question, preserve failed
  or cancelled request boundaries and expired clarification markers, and restore
  deterministic table execution after a short clarification choice.
- Add Ask feedback reasons, operational triage and an export skeleton for manually
  reviewed golden cases. Add scope-bound, process-local short-TTL retrieval caching
  and an optional Redis-backed cross-Web LLM concurrency gate, with explicit
  fail-closed configuration rather than a Provider RPM/TPM quota guarantee.
- Parse Markdown pipe tables into TableIR, retrieve authorized document catalog
  candidates with pg_trgm, and retain numeric qualifiers and deterministic table
  inline citations. Qdrant Sparse/RRF and conditional Contextual Retrieval remain
  experimental and disabled by default.
- Upgrade note: apply migrations `0033` (feedback), `0034` (pg_trgm catalog
  indexes), and `0035` (figure assets) with the documented drain/backup procedure.

## [0.3.4] - Not Released

The signed candidate passed three-round quality, multi-turn evaluation, isolation,
provider fault, and isolated restore gates. The complete browser suite was
298/300: the same external-delete-retry case timed out on both viewports. The
original run is retained as failed; a later focused pass does not change it.

## [0.3.3] - Not Released

The immutable signed build passed fresh installation, isolation, infrastructure
recovery and application upgrade/rollback, but its own three-round quality gate
failed at 120/126. Two qualified first-turn document lookups were incorrectly
treated as dangling conversation references before retrieval in every round.
The tag and original failures remain immutable; no GitHub Release was published
and the Hong Kong reference instance remained on v0.3.2.

## [0.3.2] - 2026-11-15

Signed images passed their own HK acceptance: three-round quality 126/126,
27-file business matrix (88 positive, 15 refusal, 8 lifecycle workflows),
282 browser cases and fresh agent semantic review. This promotes the unreleased
UI, theme and token-accounting changes below; earlier failed tags stay immutable.
See [release evidence](https://github.com/codexlin/UnoRAG/blob/b70b9546a6ac67a4be6dc1d35bd79421d9ad1988/docs/evidence/2026-11-15-v0.3.2-release.md) for exact
digests, boundaries and the known P2 numeric-qualifier/inline-attribution gaps.

- Keep already-selected figure/table companions directly linked to cited passages
  in the same document version and generation. Final source projection runs once;
  JSON, SSE, archives and the ledger share the exact result. Unrelated documents,
  ordinary unused passages and transitive lineage remain excluded.
- Explicitly require the known cross-project budget regression not to report a
  conflict; expected facts, supporting sources and image evidence gates are unchanged.
- Require explicit incompatible evidence before reporting a conflict; unknown
  trigger dates and unproven relationships are not contradictions. Add negative
  definition controls and positive date/condition controls. Only a proposed conflict
  triggers one independent, bounded review of exact authorized excerpts; ordinary
  non-conflict answers do not add a call. Review failures stay technical errors.
- Keep the complete selected comparison/summary evidence set as a joint result,
  even when the generated response anchors only part of it.

## [0.3.1] - Not Released

Its own real-file acceptance exposed a figure-lineage regression: a correct chart
answer lost its selected image companion during final citation pruning. The signed
tag/images and raw failure remain immutable; no GitHub Release was published.

- Finalize successful generated-answer citations from validated emitted source
  anchors, keeping their original numbers. JSON, SSE completion, archives and
  the request ledger use the same final subset; authorization and memory retain
  all context dependencies. Table execution keeps every contributing source;
  refusals, anchorless answers and interrupted streams preserve existing evidence.
- Bind bounded document identity context to the exact authorized document and
  generation for evidence judgment, conflict checks and answer generation, using
  one scoped catalog lookup rather than inferring the subject of "this project"
  from isolated fragments.

## [0.3.0] - Not Released

The signed image/tag was deployed for acceptance, but its own three-round quality
gate failed at 124/126: one answer retained an unused cross-project citation and
another falsely classified different projects as conflicting. No GitHub Release
was published. The tag and original evidence remain
immutable; a passing RC3 run does not override this failure.

- Replace model-written conflict quotations with request-local excerpt selections.
  The server materializes exact original text while retaining source scope,
  provenance validation, the six-excerpt limit and bounded-attempt diagnostics.
  No reindex or public response migration is required.
- Select a newly created library from its confirmed response before closing the
  editor. A slow or failed list refresh no longer leaves immediate uploads pointed
  at the previously selected library or makes a successful creation look failed.
- Fold answer sources with the official shadcn Trace pattern and preview inline
  citations with HoverCard. Preserve per-turn source snapshots, document versions,
  keyboard/touch access and full-source focus return without extra reads. Unify
  suggested prompts and measured stage details with shadcn compositions.
- Add whole-answer copying with temporary confirmation, explicit Clipboard failures,
  per-turn isolation and in-flight deduplication. Group Ask copy/retry/trace actions
  into a quiet icon footer, compact the inline prompt input and remove redundant
  refusal copy while preserving real reasons, evidence and streaming behavior.
- Adopt official shadcn AI Elements for message layout, prompt composition and
  conversation scrolling. Preserve the existing SSE engine, authorized source
  snapshots, retry/cancel semantics and diagnostics; do not invent model reasoning.
- Keep explicit source selection scoped to its turn through streaming completion;
  restore the exact citation focus even when activation does not move browser focus.
  Separate archive restoration from new-message scroll anchors, resize programmatic
  prompt changes and distinguish Ask library loading/errors from a truly empty list.
- Replace NativeSelect with standard shadcn Select compositions across settings,
  libraries, archives and request filters, retaining controlled values and permissions.
- Replace the long workspace settings page with desktop section navigation and
  a mobile selector. Load only the active section; move invitation/key creation
  into dialogs, protect unsaved settings and clear one-time values on dismissal.
  Keep audit records separate and service diagnostics expandable. Reduce repeated
  instructional copy with keyboard/touch-accessible help, retaining critical
  permission, privacy, error and delivery-state information.
- Redesign the public homepage around a local, read-only answer/source/trace example,
  current product captures and self-hosted deployment. Adopt the selected Uno
  diagonal-weave symbol with a transparent SVG master, positive/reversed assets,
  16/32px favicon tiles and an opaque Apple touch icon; no fixed teal accent.
- Harden UI acceptance details: name icon-only navigation and combobox controls,
  add a keyboard bypass, improve small-text contrast, and allow keyboard scrolling
  of email delivery records. Keep failed library reads distinct from empty results.
- Unify account entry, invitation, email access and first-password layouts with
  accessible field feedback, stable waiting states and existing token/auth guards.
- Refine workspace and document-access dialogs, member filtering, retry feedback,
  menu touch targets and bounded scrolling. Prevent collapsed navigation labels
  from intercepting workspace clicks; keep permission writes and projection semantics unchanged.
- Add built-in tweakcn Vercel (default), Claude and Violet Bloom theme presets,
  with local fonts, theme previews, independent light/dark/system mode and a live
  0–8px radius slider with 0.5px steps and exact input. Migrate saved radius presets,
  restore preferences before rendering and synchronize tabs;
  diagnostic status colors remain independent of palette selection. No runtime
  theme/CDN requests are required.
- Simplify application navigation and library layout with a narrower, searchable,
  independently collapsible library sidebar. Preserve existing document actions.
- Use theme-primary styling for library creation, uploads and form confirmations;
  keep refresh/filter/settings secondary and deletion destructive. Improve the
  readability of library policy labels without changing technical-data typography.
- Standardize ordinary form controls on shadcn/ui base-nova Slider, RadioGroup,
  Checkbox, Switch and Select. Preserve scoped form writes, disabled states,
  keyboard behavior and theme-aware menus; no additional UI framework.
- Improve large-text layout in appearance, login and the library workbench: wrap
  primary actions and filters, retain readable statistics, and prevent decorative
  theme previews from squeezing their labels.
- Keep workspace creation, notification recipient rows and pending Ask turns usable
  on trusted HTTP LAN previews via cryptographic UUID generation when the browser's
  secure-context-only `randomUUID` method is unavailable. Production still requires HTTPS.
- Refine Ask into an unframed reading layout with on-demand responsive source
  details and larger interaction targets. Show source-version snapshots without
  guessing the current version; keep received answers visible after stream errors.
- Preserve local turn and Markdown renderer identities through completion so
  closing a source panel can restore citation focus even during a streamed answer.
- Present stage timings and model usage earlier in request details, label the
  sequential waterfall explicitly, and keep retrieval scores in their native scale.
- Unify operations, archive reading and grouped workspace settings. Keep unknown
  metrics and stale probes explicit; preserve request filters, retry actions,
  historical source snapshots and the separate audit/CSV destination.
- Mount login credential fields after hydration so password-manager icons cannot
  invalidate the server-rendered form and trigger root-script recovery warnings.
  Keep the page shell and appearance bootstrap server-rendered; show an explicit
  JavaScript requirement instead of a credential-submitting no-script fallback.
- Keep login submissions POST-only;
  support an explicit development-only origin allowlist for trusted LAN previews.
- Reuse the complete local Compose data/services with source-mounted Web hot reload
  and watched Worker/control processes via `pnpm dev:full`; preserve existing data
  and accounts instead of starting a separate UI-only database.
- Add latest-task filters and per-file upload submission results. Keep asynchronous
  acceptance distinct from completed indexing, and retain failures and original
  library scope while navigating between libraries.
- Distinguish initial document loading and failed reads from truly empty libraries;
  show unknown counts and allow in-place retry without clearing cached rows on refresh.
- Organize document details around active/desired versions, files, jobs, version
  history and parser diagnostics, preserving authorized lifecycle actions.
- Record per-attempt LLM token usage for routing, rewriting, evidence assessment,
  table planning and answer generation. Share the safe snapshot across Ask traces,
  archives and operational request details; missing usage stays unknown, not zero.
- Preserve usage through temporary-session archival, failed attempts, retries and
  cancellation. Keep the existing generation retry policy and content privacy boundary.
- Report Rerank configuration readiness separately from request-level execution.
- Apply migration `0032_ask_model_usage` before upgrading. Streamed usage is requested
  by default; set advanced `AI_INCLUDE_USAGE=false` only for incompatible endpoints.
  The themed UI and token accounting are deployed in `0.3.0-rc.2` on the reference
  instance; the new conflict-selection protocol awaits candidate acceptance. This is
  not a stable promotion: the RC1 three-round quality gate remains 125/126,
  blocked by #231. See the [candidate report](https://github.com/codexlin/UnoRAG/blob/c0346cc2965236362194316499dd80ca92f5a353/docs/evidence/2026-11-15-v0.3.0-rc-closeout.md).

## [0.2.11] - Acceptance Pending

Signed images from `288677a` were deployed to the Hong Kong reference instance on
2026-11-12. Upgrade smoke, 7/7 fresh ingestion and 34 browser checks passed. The raw
three-round matrix is 122/126: three quarter-expression lexical failures and one
real conflict-quote validation failure. No formal Release or stable promotion is
approved; see the [original acceptance report](https://github.com/codexlin/UnoRAG/blob/bcd4203901d6f491616d79d695a9ff23f8dcf453/docs/evidence/2026-11-12-v0.2.11-release-closeout.md).

### Fixed

- Treat the ParserProvider total deadline as terminal `parser_budget_exhausted`, not
  a transient error that can restart staging and submit another external task. Keep
  bounded in-budget request retries and explicit cancellation semantics unchanged.
- Emit safe budget-exhaustion diagnostics and explain remote-task uncertainty before manual retry.
- Preserve the last observed Job stage/timestamps at batch wait timeout, bound polling
  by the remaining budget, and block further stability rounds when the corpus is incomplete.
- Verify actual document readiness, including supporting sources, when reusing an
  evaluation library instead of manufacturing completed jobs.

### Maintenance

- Run the same complete read-only CI gates on release-branch pushes. Keep protected
  branch requirements intact; queued checks are never reported as passing.

### Upgrade notes

- Drain unfinished DBOS jobs and retain a verified backup before changing application
  version. Existing active generations are not reindexed automatically.
- A local parser budget failure does not confirm remote cancellation. Check the
  provider task before manually retrying; upstream long-running tasks remain under investigation.

## [0.2.10] - Acceptance Pending

Signed images deployed to the Hong Kong reference instance on 2026-11-12, but the
fresh-ingestion gate exceeded its unchanged 900-second batch deadline. The three-round
matrix is 87/126; no formal Release is published. The
[original report](https://github.com/codexlin/UnoRAG/blob/288677a217c4ac788e91d6083079d3f1a0d6fd1c/docs/evidence/2026-11-12-v0.2.10-release-closeout.md)
remains unchanged in history.

The evaluation readiness correction made after this tag is included in 0.2.11,
not in the 0.2.10 images. The original failed matrix and its classifications remain unchanged.

### Fixed

- Use request-local evidence references for sufficiency, refusal review and conflict checks,
  then strictly restore canonical source IDs. Invalid references still fail closed; no reindex is required.
- Preserve completed Judge substage attempts/timings and distinguish local evidence validation
  from structured-request and unknown errors in JSON/SSE, the run ledger, logs and diagnostics UI.
- Keep unknown errors unclassified instead of guessing a provider failure. Existing request
  retry policy and evidence-provenance checks are unchanged.

## [0.2.9] - Acceptance Pending

Built and deployed to the Hong Kong reference instance on 2026-11-11. The GitHub Release
remains draft: a live Judge failure blocks the quality gate; see [#231](https://github.com/codexlin/UnoRAG/issues/231).

### Added

- Manage alert email recipients, severity and recovery notifications in Workspace settings,
  with per-recipient delivery history and test mail.
- Send HTML/plain-text invitations, existing-account sign-in links and password resets
  through Resend HTTPS. Registration remains invitation-only.

### Fixed

- Fence concurrent invite acceptance, credential changes, expired account links and
  password-reset/session-issuance races. Existing members must verify their password
  when joining another workspace; invitations cannot replace it.
- Keep notification retries scoped, idempotent and content-stable; redact provider errors
  and distinguish service acceptance from inbox delivery.
- Include the reviewed pilot evidence, parser/evaluation contract and dependency maintenance
  updates made after v0.2.8.

### Upgrade notes

- Back up and drain DBOS before applying forward-only migrations 0028–0031. Existing
  document generations are not automatically reindexed.
- Configure transport credentials server-side and account-link origin via `APP_BASE_URL`.
  Save recipients in the application; old global recipient/toggle settings are not imported.
- Account mail is bounded request/`after` work, not a durable mail queue. A process interruption
  can require another link request. Alert mail retains durable retries.

## [0.2.8] - 2026-11-10

### Fixed

- Keep document versions and original downloads aligned through replacement, failed
  replacement, and reindexing. Retain the active version until the new version is ready.
- Recover from failed permissions and Ask settings requests without carrying stale
  state into another document or conversation.
- Keep the first knowledge-library render consistent when the layout fetches the
  library list before the page bundle loads.
- Preserve source qualifiers and exact entity names in answers. Check those boundaries
  in the evaluation suite while accepting equivalent wording and numeric notation.

### Upgrade notes

- Drain unfinished document jobs before upgrading and retain the previous image
  manifest for application rollback. This release includes migration
  `0027_document_version_source_metadata` for version-specific filenames and MIME types.
  Existing active generations are not reindexed automatically.

## [0.2.7] - 2026-11-07

### Fixed

- Match namespaced Service Key principals safely in the active document catalog without
  casting them to UUIDs or inheriting a user ACL from a matching UUID suffix.
- Resolve named documents and policy identifiers against authorized active-version metadata;
  preserve source scope instead of substituting similar documents or operation phases.
- Answer bounded complete-heading queries from parser outlines with verifiable source citations,
  and retain MinerU figure captions and footnotes with their lineage.
- Keep ordinary sufficiency, minimal evidence selection and refusals independent from conflict
  verification. Fact/follow-up answers can surface unresolved same-scope provisions using
  validated original excerpts instead of silently choosing one conclusion.
- Separate internal source tokens from clause and row numbers, validate generated citations,
  and expose content-minimized citation and Judge stage diagnostics.

### Evaluation and upgrade notes

- Preserve versioned machine results and separate per-answer review. The expanded mixed-file
  matrix includes source constraints, scope-specific provisions, ambiguity and unsupported questions.
- Existing active generations are not patched in place. Reindex through the normal lifecycle
  to obtain new document identity/outline metadata; drain unfinished jobs before upgrading.
- No database schema or public Knowledge API change. Conflict verification is bounded to retrieved
  evidence for fact/follow-up paths, not global contradiction detection or a replacement for expert review.
- The final signed images passed Hong Kong acceptance: 25 fresh uploads and matching originals,
  three 95-case rounds (285/285), 8 lifecycle checks, 36 browser checks and 3 real SSE checks.
  Isolated install, upgrade/rollback, 29 isolation cases, dependency/provider faults and restore
  drills also passed. See the [version-bound report](https://github.com/codexlin/UnoRAG/blob/0d52120e15943ada7740493717559b22ec47ad2d/docs/evidence/2026-11-07-v0.2.7-release-closeout.md)
  for retained failures, review boundaries and capacity limitations.

## [0.2.6] - Not published

- The immutable build was rejected by the fresh-install Public API Ask smoke gate before
  production deployment. A Service Key principal was incorrectly cast to UUID in the new
  document catalog query. The tag and image digests remain unchanged for traceability;
  use the later accepted release, not these artifacts. Tracked in
  [#209](https://github.com/codexlin/UnoRAG/issues/209).
- The evidence-quality changes originally prepared for this version are carried forward
  in the accepted 0.2.7 release above; Hong Kong stayed on 0.2.5 until that release passed acceptance.

## [0.2.5] - 2026-11-06

### Fixed

- Wrap long answer text, links, and inline code without clipping; preserve scrollable,
  copyable fenced code with or without a language label.
- Print sanitized ACR push diagnostics before propagating the original failure or timeout
  status; do not continue mirroring or record a failed target digest.
- Mirror only the selected runtime platform to ACR instead of an OCI index containing
  unsupported artifact manifests; preserve canonical SBOM/provenance in GHCR.

## [0.2.4] - 2026-11-06

### Added

- Workspace administrator request records with scoped filters, safe stage diagnostics and correlated
  error-response Request IDs; optional offline Ragas semantic evaluation remains outside the product runtime.

### Fixed

- Enforce one parser Provider budget across submission, polling and result consumption, abort
  stalled HTTP requests/bodies, and bound best-effort cancellation without changing routing or quality gates.
- Keep ingestion polling from cancelling the authoritative post-create library refresh, so a
  newly created library remains selected while other documents are indexing.
- Record PDF analysis, submission, observed task wait, result retrieval/conversion, and application
  poll/retry counts separately; correlate parser status logs without exposing full Provider task IDs.
- Preserve bounded comparison evidence and figure lineage, and expose correlated failed Qdrant
  operations and partial Ask graph timings without adding automatic read retries.
- Preserve sanitized, nonretryable Public API authorization denials instead of reporting retryable 502 errors.
- Distinguish Judge outages from insufficient evidence in JSON/SSE messages, stage diagnostics, traces,
  metrics and the Ask run ledger; retain bounded retry metadata and fail fast on nonretryable Provider errors.
- Allow explicitly declared, fact-bound corroborating sources in golden cases while retaining primary-source,
  fact-coverage and citation gates; operational refusals no longer pass negative-case evaluation.
- Revalidate Ask identity and evidence at model/output checkpoints and authorize provenance-backed
  archived and temporary history before reuse, preserving transitive source dependencies.
- Isolate browser generation attempts from stale stream callbacks and batch token updates without
  losing received text on cancellation or failure.
- Keep the initial Ask hydration snapshot stable when parent queries populate the shared cache
  before the Suspense subtree hydrates.
- Reject multiple files in one document replacement request and verify exact generation record
  manifests on ingestion retries instead of relying only on point counts.
- Honor bounded Provider Retry-After hints without retrying early, retain cancellation/deadline
  limits, and add jitter to transient Embedding/Rerank retries.
- Recover trusted temporary-memory provenance during archiving so verified follow-ups keep their
  context; edited or expired exchanges remain view-only rather than trusting client metadata.
- Start a clean conversation on library changes and ignore archive responses from the old context.
- Let in-flight answers finish with already admitted source versions after normal publication,
  while still enforcing current ACL, deletion, and active-only evidence for new requests.

### Compatibility notes

- Historical answers without verifiable provenance remain viewable but are not reused as model
  memory. Authorization checkpoints do not recall content already delivered before revocation.
- Pre-upgrade unfinished staging generations without manifests fail closed; submit a fresh
  replacement/reindex if needed. Drain existing jobs before upgrading as usual.
- Changes are not a new release or proof of deployment acceptance; validation remains bound to
  the tested candidate and environment.
- Production dependency audit passed for this candidate after reviewed dependency updates;
  rerun the audit and release gates for the final release artifact. Three development-only
  advisories remain outside the production dependency tree.

## [0.2.3] - 2026-09-25

UnoRAG 0.2.3 is a release-confidence maintenance update. It does not change the public Knowledge
API contracts, retrieval behavior, database schema, or required production configuration.

### Added

- A version-bound release gate for immutable candidate manifests, Provider fault injection,
  digest-pinned upgrade and application rollback, destructive backup/restore drills, and final
  lifecycle invariants.
- Explicit evidence for ARM development-host platform emulation. Emulated runs remain limited to
  functional and recovery validation and cannot be used as production capacity evidence.

### Changed

- Manual candidate publishing now defaults to GHCR only. ACR mirroring requires an explicit opt-in,
  while stable tags continue to mirror automatically when the complete ACR secret set is present.
- ACR pull and push operations have bounded timeouts so an unavailable mirror cannot consume the
  entire image-release workflow window.

### Validation

- The final code candidate passed a clean isolated install, candidate upgrade, `0.2.2` application
  rollback, and candidate re-upgrade cycle, plus LLM and parser fault injection, active-version
  preservation, and a destructive backup/delete-volumes/restore drill.
- The restore drill observed zero data loss, restored the stack in 50 seconds, and finished with
  zero dead jobs, stuck jobs, or pending ACL projections.

### Upgrade notes

- Existing `v0.2.2` deployments use the normal digest-manifest upgrade path. No database migration
  or configuration change is required.
- Public `POST /api/v1/retrieve` and `POST /api/v1/ask` contracts are unchanged.

## [0.2.2] - 2026-09-20

UnoRAG 0.2.2 is a production-hardening release for private deployments. It strengthens native
alerting, login and API security, and long-term maintainability without changing the public
Knowledge API request or response contracts.

### Added

- Configurable Ask P95 alert thresholds, minimum sample counts, consecutive-breach and recovery
  windows, and persisted alert streaks so transient samples do not page operators and recovered
  incidents close correctly.
- Redis-backed login throttling and public Knowledge API rate limiting, with fail-closed production
  behavior when the shared limiter is unavailable.
- A server-side session registry that immediately revokes existing sessions after password changes,
  administrator recovery, user disablement, or credential replacement.
- Production security headers covering CSP, HSTS, clickjacking, MIME sniffing, referrer policy, and
  browser capability restrictions.
- Deployment contract tests that keep Compose and Helm runtime settings aligned.

### Changed

- Split deployment configuration into a concise common file and an optional advanced file. Existing
  values are migrated and preserved by the standard install and upgrade scripts.
- Removed the retired legacy Ask policy, proxy, and write-permission runtime paths after migrating
  persisted Ask profiles to the current TypeScript contract.
- Split the Library workspace, Ask workspace, ingestion transaction implementation, and Drizzle
  schema into domain-owned modules while retaining their existing public import surfaces.

### Upgrade notes

- The normal digest-manifest upgrade path applies two forward-only migrations for persisted alert
  streaks and normalized Ask profiles. Take the standard pre-upgrade backup; no manual SQL is needed.
- Redis is required for production authentication and public API rate limiting. The bundled Compose
  topology already provides it; external deployments must configure the shared Redis endpoint.
- Public `POST /api/v1/retrieve` and `POST /api/v1/ask` contracts are unchanged.

## [0.2.1] - 2026-09-19

UnoRAG 0.2.1 is a focused DOCX parser security maintenance release. It contains no public API,
schema, retrieval, or product UI changes.

### Security

- Updated Mammoth from `1.12.2` to `1.12.3`. The upstream fix prevents excessive regular-expression
  backtracking when a maliciously crafted DOCX contains an unterminated string with many escape
  sequences, reducing the risk of parser CPU denial of service.

### Upgrade notes

- Existing `v0.2.0` deployments can use the normal digest-manifest upgrade path. No database
  migration or configuration change is required.
- Public `POST /api/v1/retrieve` and `POST /api/v1/ask` contracts are unchanged.

## [0.2.0] - 2026-09-19

UnoRAG 0.2.0 turns complex-document quality from an aggregate test result into explicit release
contracts. It also completes the administrator-facing audit and recovery loop for library deletion.
The public Knowledge API request and response contracts remain unchanged.

### Added

- Independent release scorecards for cross-page tables and low-contrast scanned documents. Missing
  required dimensions, a single failed case, incorrect evidence type, or cross-document citation now
  fails the release instead of being hidden by an average.
- Parser-provider scorecards covering file completion, partial results, failed pages, warnings,
  parsing P50/P95, downstream question quality, document recall, and citation precision.
- Real-file golden coverage for both cross-page row boundaries and cross-page OCR facts: 36 positive
  cases and 5 refusal cases across seven Markdown, DOCX, and PDF fixtures.
- Library create, update, synchronous delete, asynchronous delete, failure, and retry audit events
  linked by request ID, plus an administrator-visible idempotent recovery action for failed deletion.

### Changed

- Deterministic table lookup accepts a bounded list of up to 50 exact values, allowing one question
  to retrieve adjacent rows split across pages or row-group records without weakening table evidence.
- Citation precision is now a hard global gate. Any citation from a document other than the declared
  golden source fails that case even when the answer text is otherwise correct.
- Provider parsing latency falls back to the existing durable job-stage waterfall when a parser does
  not report its own latency. Benign partial-parser warnings remain visible without blocking a release;
  failed pages, missing reports, and non-completed jobs still fail closed.
- Applied controlled patch updates for JSZip, Lucide React, Zod, Biome, and the Langfuse client. The
  OpenTelemetry family remains coordinated to avoid incompatible mixed-version updates.

### Validation

- A fresh local production stack ingested all seven real files through Tencent COS, TypeScript
  parsers, and the configured 302.AI MinerU provider. All 36 positive and 5 refusal cases passed.
- Cross-page table and low-contrast scan scorecards both reached 100% fact coverage, document recall,
  citation precision, and expected evidence-type accuracy; cross-document citation rate was 0%.
- Provider reports covered all seven files with zero missing reports and zero failed pages. Observed
  parsing P50 was 22.981 seconds for 302.AI MinerU and 262 milliseconds for native TypeScript parsing
  in the recorded local environment.

## [0.1.4] - 2026-09-14

UnoRAG 0.1.4 is a least-privilege and runtime-image security hotfix for the native operations
dashboard introduced in 0.1.2. It supersedes the unpublished 0.1.3 release candidate, whose
security gate stopped before signing or release publication.

### Fixed

- The DBOS control process can read the privacy-safe Ask and job execution-stage tables required to
  refresh operational signals and stage latency summaries.
- Runtime role verification now fails the install or upgrade when either diagnostic read grant is
  missing.
- The real PostgreSQL integration suite validates effective role privileges in addition to static
  deployment SQL contracts.

### Security

- All four published Node runtime image families explicitly install the current Debian
  `libpcre2-8-0` security revision, addressing CVE-2026-86145 and CVE-2026-89161.
- Release-safety tests ensure the web, migrator, operations, and DBOS worker image paths continue
  to receive the package update before publication.

### Validation

- 51/51 real PostgreSQL, Qdrant, and Redis integration tests passed with zero skips.
- Repository tests, 378 TypeScript core tests, lint, type checking, production build, image build,
  secret scanning, and protected-branch CI passed.
- The same grants restored consecutive observability cycles on UnoRAG-HK; lifecycle inspection
  returned zero dead, stuck, deleting, cleanup-error, tombstone, and ACL-projection rows.

Public `POST /api/v1/retrieve` and `POST /api/v1/ask` contracts are unchanged. No schema migration
is required.

## [0.1.2] - 2026-09-10

UnoRAG 0.1.2 is an observability and reliability patch for private deployments. It adds native
diagnostic waterfalls for document ingestion and Ask execution, while tightening cleanup and error
classification around failed document parsing.

### Added

- Native ingestion and Ask stage waterfalls with queue, parsing, indexing, retrieval, generation,
  and end-to-end timing in the operations and document views.
- Actionable recent-error diagnostics with stable error codes, sanitized detail, recovery guidance,
  and correlated request, workflow, job, document-version, and trace identifiers.
- Release and runtime metadata in the operations surface so administrators can bind diagnostics to
  the exact application build.

### Fixed

- Generation cleanup no longer requests a PostgreSQL row lock through the least-privilege active
  generation view; document-level advisory and row locks continue to serialize activation safely.
- Empty text documents and invalid UTF-8 now preserve `document_ingest_empty` and
  `document_parse_invalid` instead of collapsing into a generic worker failure.
- Local Compose builds no longer report a stale hard-coded development version.

### Validation

- 216 static tests, 353 TypeScript core tests, and 50 real PostgreSQL/Qdrant/Redis integration tests
  passed with only environment-dependent cases skipped in the non-integration suites; all
  deterministic build, lint, type, license, asset, NOTICE, and dependency-audit gates passed.
- A fresh isolated Compose installation passed the full product smoke flow, parser-failure cleanup,
  worker/Qdrant restart recovery, desktop and mobile browser checks, and a seven-file real MinerU
  matrix with 33/33 positive and 5/5 refusal cases.

Public `POST /api/v1/retrieve` and `POST /api/v1/ask` contracts are unchanged.

## [0.1.1] - 2026-09-09

UnoRAG 0.1.1 is a security and maintenance release for private deployments. It strengthens the
first-run administrator flow and refreshes the supported web, AI, parsing, workflow, and developer
toolchain dependencies without changing the public Knowledge API contracts.

### Added

- A unique, cryptographically generated initial administrator password for every new installation,
  written only to the local bootstrap credential file with owner-only permissions.
- A mandatory first-login password-change flow, including a dedicated authenticated endpoint,
  guarded application routing, session state, and audit event.
- A shared password policy for administrator bootstrap, recovery, invitations, and password changes:
  7 to 256 characters with at least one uppercase and one lowercase letter.

### Changed

- Updated Next.js, AI SDK, LiteParse, DBOS, LangChain Core, Base UI, TanStack Query, Lucide, Motion,
  Zod, and the supported development toolchain to their validated patch or minor releases.
- Updated one-click installation, production bootstrap, administrator recovery, pilot smoke tests,
  and deployment documentation for the generated initial credential and first-login flow.

### Security

- Removed the shared default administrator credential from new installations.
- Patched audited transitive `qs`, `@xmldom/xmldom`, and `fast-uri` vulnerabilities; the production
  dependency audit and GitHub Dependabot alert set are clean at release preparation time.

### Upgrade notes

- Existing administrators are not forced to rotate their password by the migration. The mandatory
  change applies to newly bootstrapped or explicitly reset administrator credentials.
- The database migration is forward-only. Application rollback follows the documented image
  rollback procedure and does not reverse schema migrations.
- Public `POST /api/v1/retrieve` and `POST /api/v1/ask` request and response contracts are unchanged.

## [0.1.0] - 2026-08-23

UnoRAG 0.1.0 is the first stable, fully open-source release of the TypeScript runtime. It targets one
isolated private deployment per customer, with workspaces for internal departments, projects, and
permission boundaries.

### Added

- Next.js product and Knowledge API as the only browser and external application boundary.
- Organization, workspace, member, role, principal, group, document ACL, service-key, and audit
  controls with scoped PostgreSQL queries and Qdrant filters.
- Durable DBOS workflows for upload, replace, reindex, ACL projection, delete, cleanup, retry,
  cancellation, reconciliation, and atomic generation activation.
- TXT, Markdown, DOCX, digital PDF, scanned PDF, and complex PDF routing through LiteParse and
  optional MinerU providers.
- DocumentIR and TableIR with page, section, table header, unit, row-group, source, and quality
  metadata.
- Policy-driven structural, recursive, fixed-window, and optional semantic chunking, plus layered
  storage for complete tables, summaries, and row groups.
- Dense retrieval, optional reranking, application-level BM25 + RRF for small and medium libraries,
  deterministic table execution, and source-mapped citations.
- LangGraph.js Ask orchestration for routing, planning, rewriting, retrieval, evidence judgment,
  clarification, refusal, table execution, and SSE generation.
- Shared, abort-aware LLM concurrency and bounded backpressure with Prometheus metrics.
- Conversation continuation and archives, native operations views, OpenTelemetry Ops Stack,
  metadata-only Langfuse export, versioned prompts, and evaluation gates.
- Local filesystem and Tencent COS document storage, Compose reference deployment, Helm starter,
  backup/restore, forward-only migration, application rollback, and lifecycle inspection tools.
- Four digest-pinned, non-root runtime images with Trivy gates, SPDX SBOM, SLSA provenance,
  third-party notices, and GitHub OIDC Cosign signatures. GHCR is the primary registry and ACR is an
  optional mirror.

### Stable public contracts

- `POST /api/v1/retrieve`
- `POST /api/v1/ask`
- Digest-pinned Compose release manifests and the documented backup, restore, upgrade, and
  application rollback procedures.

Workspace-internal browser APIs are not public compatibility contracts unless explicitly documented
in [`docs/INTEGRATION.md`](./docs/INTEGRATION.md).

### Known limitations

- OIDC/SSO and SCIM are not included. The release provides local administrator authentication,
  member invitations, roles, and a break-glass administrator recovery path.
- The default product boundary is one isolated deployment per customer, not a shared public
  multi-tenant SaaS or multi-region active-active service.
- The Helm chart is a starter and does not yet include built-in NetworkPolicy, PDB, HPA, or
  digest-native values for every runtime image.
- Application-level BM25 + RRF is intended for small and medium libraries. Native sparse retrieval
  has not been adopted without customer-corpus evidence.
- ChartIR and chart-value reasoning are not implemented. Complex PDF acceptance currently proves
  routing, structural parsing, and narrative recovery rather than numeric chart extraction.
- Documents, Versions, and Jobs remain workspace-internal APIs rather than stable public v1
  lifecycle contracts.
- Very large transactional tables are intentionally not treated as document chunks or an embedded
  SQL engine; query the source database or expose a dedicated governed tool.
- Capacity and production approval remain environment-specific. The published single-host results
  do not certify arbitrary models, parser providers, hardware, replica counts, or customer data.

### Install and upgrade

- New local evaluations can use [`./start.sh`](./start.sh).
- Production installations must use a release asset's digest-pinned manifest and follow
  [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).
- Existing RC deployments use the forward-only upgrade and application rollback process in
  [`docs/RELEASE.md`](./docs/RELEASE.md). Database migrations are not rolled back.

[0.2.8]: https://github.com/codexlin/UnoRAG/releases/tag/v0.2.8
[0.2.7]: https://github.com/codexlin/UnoRAG/releases/tag/v0.2.7
[0.2.5]: https://github.com/codexlin/UnoRAG/releases/tag/v0.2.5
[0.2.4]: https://github.com/codexlin/UnoRAG/releases/tag/v0.2.4
[0.2.2]: https://github.com/codexlin/UnoRAG/releases/tag/v0.2.2
[0.2.1]: https://github.com/codexlin/UnoRAG/releases/tag/v0.2.1
[0.2.0]: https://github.com/codexlin/UnoRAG/releases/tag/v0.2.0
[0.1.4]: https://github.com/codexlin/UnoRAG/releases/tag/v0.1.4
[0.1.2]: https://github.com/codexlin/UnoRAG/releases/tag/v0.1.2
[0.1.1]: https://github.com/codexlin/UnoRAG/releases/tag/v0.1.1
[0.1.0]: https://github.com/codexlin/UnoRAG/releases/tag/v0.1.0
