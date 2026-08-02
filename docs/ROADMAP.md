# UnoRAG Roadmap

This roadmap starts from the TS-only architecture implemented on
`refactor/ts-core-runtime`. Completed migration history belongs in ADR-0005 and
acceptance reports, not in the active backlog.

## R0: Cutover Closure

- [x] Native Next.js Retrieve/Ask and LangGraph.js orchestration
- [x] Native DocumentIR/TableIR parsing, chunking, Qdrant indexing and retrieval
- [x] DBOS ingest, ACL projection, delete and generation cleanup
- [x] Remove FastAPI, Python lifecycle, outbox and duplicate metadata ownership
- [x] Four-image Compose/Helm/release topology and DBOS-only migration guard
- [ ] Clean Docker build of all four targets
- [ ] Clean local install from empty volumes
- [ ] Real-file vertical acceptance and new commit-bound report

## R1: Restore Production Gates

- [ ] Rebuild live TypeScript golden runner from `eval/reference`
- [ ] Rebuild isolated backup/restore drill for app DB, DBOS DB, documents and Qdrant
- [ ] Rebuild upgrade/application rollback drill using four digest-pinned images
- [ ] Rebuild DBOS, Qdrant, model and ParserProvider fault injection
- [ ] Browser acceptance for upload, replace, reindex, delete, Ask, archive and settings
- [ ] Zero-leakage fuse across organization, workspace, principal and group

R1 is the release boundary. No preproduction deployment or production-ready claim
before every blocking item has evidence for the same commit.

## R2: Private Deployment Productization

- [ ] OIDC/SSO Provider interface and customer identity mapping
- [ ] first-class S3/MinIO document object store
- [ ] Kubernetes NetworkPolicy, PDB, HPA and topology guidance
- [ ] OpenTelemetry dashboards and alert packaging for jobs, retrieval and providers
- [ ] signed/SBOM release artifacts and approved promotion workflow
- [ ] tested RPO/RTO profiles for single-node and Kubernetes delivery

## R3: Knowledge Quality

- [ ] Query-router and refusal regression set based on real customer question classes
- [ ] citation precision/coverage adjudication and answer-support scoring
- [ ] ParserProvider scorecard for LiteParse, self-hosted MinerU and future external providers
- [ ] add cost controls and restart/idempotency fault acceptance for the live-tested TypeScript 302.AI Provider
- [ ] ChartIR for chart evidence and provenance
- [ ] optional summary indexes based on measured recall gains

Large-table SQL execution remains deferred. Operational tables should normally be
queried from their source database; UnoRAG will add a structured execution backend
only after a real use case justifies its security and operational cost.

## R4: Platform Surface

- [ ] public document lifecycle API with stable version/job contracts
- [ ] OpenAI-compatible retrieval/response adapter
- [ ] JavaScript SDK generated from the public OpenAPI contract
- [ ] group-management UI and external directory synchronization
- [ ] pluggable tool boundary for LlamaIndex or domain query engines where measured

## Priority Rule

Security isolation, atomic versions, durable lifecycle, recovery and measurable
quality outrank new parser, agent or UI breadth. A feature that cannot be scoped,
observed, restored and evaluated is not complete enterprise functionality.
