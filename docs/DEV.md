# Development Guide

UnoRAG's product and RAG runtime are TypeScript. Python is not required to run the
application; it remains only in optional client or operator utilities.

## Prerequisites

- Node.js 22 and pnpm 9
- Docker with Compose v2
- optional Helm 3 for chart validation

## Install And Check

```bash
pnpm install --frozen-lockfile
pnpm --filter web test
pnpm --filter web test:ts-core
pnpm --filter web typecheck
pnpm --filter web lint
pnpm --filter web db:check
```

`test` covers the product control plane and deployment contracts. `test:ts-core`
covers DocumentIR/TableIR, parsers, chunking, retrieval filters, Qdrant projection,
Ask graph, DBOS workflows, lifecycle transactions and failure semantics.

## Local Product

The simplest complete environment is the private-deployment Compose stack:

```bash
cd deploy/compose
./scripts/init-config.sh
# Fill ../config/runtime.env, runtime.secret, and bootstrap.env
./scripts/install.sh
```

For UI-only iteration, start local infrastructure and Next.js separately:

```bash
docker compose up -d
cp -n apps/web/.env.example apps/web/.env.local
pnpm --filter web dev
```

Document lifecycle requires a DBOS system database, worker credentials, Qdrant,
shared document storage, and embedding configuration. Use the deployment Compose
stack when testing upload, replace, reindex, ACL projection, delete, or cleanup.

## Database Changes

Edit `apps/web/src/db/schema.ts`, then generate and validate a forward migration:

```bash
pnpm --filter web db:generate
pnpm --filter web db:check
```

Review generated SQL. Add explicit preflight checks when a migration retires a
runtime, changes ownership, or could reinterpret existing rows. Do not edit old
migrations after they have shipped.

## Parsing And Retrieval

- Parser contracts: `apps/web/src/core/parsing/`
- DocumentIR and chunking: `apps/web/src/core/document-ir/`, `core/ingest/`
- Retrieval and Qdrant: `apps/web/src/core/retrieval/`
- Ask graph: `apps/web/src/core/ask-graph/`
- Durable lifecycle: `apps/web/src/worker/`
- Product routes: `apps/web/src/app/api/`

ParserProviders return DocumentIR and never write business data. Retrieval always
accepts a server-derived AuthorizedScope; tests must prove missing or empty security
dimensions fail closed.

## Before A Pull Request

```bash
just check
source deploy/compose/scripts/compose-env.sh
mk_compose config >/tmp/unorag-compose.yml
helm lint deploy/helm/unorag --set config.openaiBaseUrl=http://llm
git diff --check
```

Use `deploy/compose/scripts/pilot-smoke.sh` for a live vertical slice. Real release
acceptance happens only after the refactor branch is clean and a local Docker stack
has passed real-file ingest, Ask/Retrieve, isolation, replacement and deletion.
