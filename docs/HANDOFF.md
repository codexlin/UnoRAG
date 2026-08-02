# Repository Handoff

## Read First

1. [`README.zh-CN.md`](../README.zh-CN.md) for product positioning.
2. [`ARCHITECTURE.md`](./ARCHITECTURE.md) for current ownership and request flow.
3. [`STATUS.md`](./STATUS.md) for verified and unverified boundaries.
4. [`runbooks/private-deployment.md`](./runbooks/private-deployment.md) before touching deployment.

## Repository Map

```text
apps/web/             Next.js product, native RAG core, DBOS worker, migrations, tests
contracts/            public OpenAPI and shared service contracts
deploy/               Compose, Helm and four-image delivery
eval/reference/       preserved quality corpus; not yet a live TS release gate
ops/postgres/         least-privilege roles and login verification
ops/min_alerts/       optional operator-side alert checker
scripts/acceptance/   active isolation and capacity acceptance
sdk/python/           thin Knowledge API client
sdk/mcp/              MCP adapter over the public API
testdata/              real representative document fixtures
docs/acceptance/      runbooks, templates and immutable historical reports
```

Any retired local Python environment or reports are outside the repository and are
not part of the build. Do not reintroduce that service as a runtime dependency.

## Code Ownership

| Concern | Location |
|---|---|
| Auth, organizations, workspaces, RBAC | `apps/web/src/lib/server`, `src/app/api` |
| Database schema and migrations | `apps/web/src/db/schema.ts`, `apps/web/drizzle` |
| DocumentIR/TableIR and parsing | `apps/web/src/core/document-ir`, `src/core/parsing` |
| Chunk and index records | `apps/web/src/core/ingest` |
| Retrieval security and Qdrant | `apps/web/src/core/retrieval` |
| LangGraph Ask runtime | `apps/web/src/core/ask-graph` |
| Public/native HTTP handlers | `apps/web/src/server/http`, `src/app/api/v1` |
| Durable lifecycle | `apps/web/src/worker` |
| Product UI | `apps/web/src/components/app` |

## Invariants

- PostgreSQL `app` is the only business source of truth.
- All new lifecycle jobs use DBOS with `workflow_id=job_id`.
- Qdrant access always includes organization, workspace, ACL, document and active
  generation scope derived by the server.
- ParserProviders return DocumentIR and do not write product tables.
- Replacement activates only after staged index validation; failure preserves the old version.
- Browser and Service Key traffic enter Next.js; workers and stores are not public.
- SDK and MCP are protocol clients, not alternate retrieval implementations.

## Quality Commands

```bash
pnpm --filter web test
pnpm --filter web test:ts-core
pnpm --filter web typecheck
pnpm --filter web lint
pnpm --filter web db:check
source deploy/compose/scripts/compose-env.sh && mk_compose config >/tmp/unorag-compose.yml
helm lint deploy/helm/unorag --set config.openaiBaseUrl=http://llm
```

Environment-dependent PostgreSQL/Qdrant tests may skip locally. A release cannot turn
those skips into PASS; run the Docker acceptance slice and record environment evidence.

## Current Continuation

The next owner should finish in this order:

1. rebuild recovery and fault-injection automation for the four-image topology;
2. complete a clean local Docker install and real-file vertical acceptance;
3. rebaseline `eval/reference` through native product endpoints;
4. run browser, workspace isolation and ACL leakage tests;
5. publish a new commit-bound acceptance report before touching webch.

Historical reports are immutable evidence for their recorded commits. Do not edit them
to make the current branch appear accepted.
