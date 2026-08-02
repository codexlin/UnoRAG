# Implementation Status

> Updated 2026-08-02 for branch `refactor/ts-core-runtime`.
> Historical webch reports predate the TS-only cutover and are not acceptance for it.

## Implemented

| Area | Current implementation |
|---|---|
| Product edge | Next.js Workspace, local auth, sessions, invitations, roles, workspace switching, audit and settings |
| Multi-tenancy | organization/workspace scope, RBAC, document ACL, Service Key scopes, mandatory Qdrant filters and isolation tests |
| Knowledge API | native Retrieve v1 and Ask v1, service keys, streaming answers, citations and conversation archive |
| Ask orchestration | LangGraph.js routing, plan, clarification, retrieval, evidence judge, retry, refusal, table execution and generation |
| Ingestion | TXT, Markdown, DOCX and PDF; DocumentIR/TableIR; LiteParse plus self-hosted or 302.AI MinerU |
| Chunking | structure-first profiles, recursive limits, semantic narrative option, chunk/section/table records and table row groups |
| Retrieval | dense Qdrant, active generation gate, ACL scope, optional BM25 hybrid fusion and rerank |
| Versions | staging index, validation, atomic active-version switch, failed replacement preserves previous content |
| Lifecycle | DBOS ingest, ACL projection, delete, generation cleanup, progress, retry, cancellation and reconciliation |
| Delivery | four Node images, Compose reference topology, Helm starter, least-privilege PostgreSQL roles, backup/restore and upgrade scripts |
| Clients | Python SDK and MCP remain thin clients of the public Knowledge API |

The FastAPI service, Python lifecycle worker, outbox worker, duplicate `rag/public`
metadata ownership, and Python runtime migrations have been removed.

## Verified On This Branch

- Web contract suite: 160 pass, 1 environment-dependent skip.
- Native TypeScript core suite: 198 pass, 12 environment-dependent skips.
- TypeScript typecheck, Biome lint, Drizzle migration check, Helm lint/render, Compose
  render and shell syntax pass.
- Migration 0020 blocks cutover while non-terminal Python-owned jobs exist and makes
  DBOS the default for all new jobs.
- A real scanned PDF completed through the TypeScript 302.AI upload/task/ZIP path,
  produced `parser=mineru`, `provider=302ai`, and indexed Qdrant points. The four
  DBOS queues are now part of the deployment contract. See the
  [live acceptance report](./acceptance/reports/2026-08-02-ts-mineru-302-live.md).

The skipped tests require real PostgreSQL or Qdrant. A new full Docker acceptance
has not yet been completed for commits `5061ac0` and `8b38294`; therefore this branch
must not yet be described as production-ready.

## Open Before Preproduction

1. Rebuild and execute live backup/restore, upgrade rollback and fault-injection
   automation against the TS-only Compose topology.
2. Run real files through local Docker: all representative formats, scanned and
   complex PDF through MinerU, replacement failure, ACL changes, deletion and cleanup.
3. Rebaseline `eval/reference` as a live TypeScript golden runner. Preserved old
   scores are reference data, not a current release gate.
4. Add 302.AI provider cost limits, structured metrics and restart/idempotency fault
   acceptance; the live transport path itself is verified.
5. Re-run browser and zero-leakage acceptance, then produce a new dated report bound
   to the final commit and environment.

## Planned Product Work

- OIDC/SSO and customer identity mapping
- first-class S3/MinIO document storage
- OpenAI-compatible API surface
- hardened Kubernetes NetworkPolicy, autoscaling and observability packaging
- group-management UI
- ChartIR and optional structured execution for exceptional large-table use cases

See [architecture](./ARCHITECTURE.md), [roadmap](./ROADMAP.md), and
[acceptance](./acceptance/README.md).
