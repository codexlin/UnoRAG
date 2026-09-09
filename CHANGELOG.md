# Changelog

This file records user-visible UnoRAG changes. Release evidence and environment-specific acceptance
results remain in [`docs/evidence/`](./docs/evidence/).

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

[0.1.2]: https://github.com/codexlin/UnoRAG/releases/tag/v0.1.2
[0.1.1]: https://github.com/codexlin/UnoRAG/releases/tag/v0.1.1
[0.1.0]: https://github.com/codexlin/UnoRAG/releases/tag/v0.1.0
