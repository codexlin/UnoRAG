# Changelog

This file records user-visible UnoRAG changes. Release evidence and environment-specific acceptance
results remain in [`docs/evidence/`](./docs/evidence/).

## Unreleased

### Added

- Generic enterprise OIDC Authorization Code + PKCE login for private deployments, with signed
  short-lived flow state, invitation-gated first login, independent external identity bindings,
  OIDC-aware UnoRAG sessions, audit events, and a retained local break-glass administrator path.
- Fail-closed Compose and Helm OIDC configuration, migration, deployment tests, and an enterprise
  authentication runbook.

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

[0.1.0]: https://github.com/codexlin/UnoRAG/releases/tag/v0.1.0
