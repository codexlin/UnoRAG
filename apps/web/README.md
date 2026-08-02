# UnoRAG Application

`apps/web` contains the complete TypeScript product runtime:

- Next.js UI, authentication, organizations, workspaces, RBAC and audit;
- public Knowledge API and native Retrieve/Ask runtime;
- DocumentIR/TableIR, parsing, chunking, embedding and Qdrant projections;
- LangGraph.js Ask orchestration;
- DBOS document lifecycle workers;
- Drizzle schema, migrations and bootstrap.

PostgreSQL `app` is the only business source of truth. Qdrant is a scoped derived
index. There is no FastAPI or outbox runtime.

## Development

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter web test
pnpm --filter web test:ts-core
pnpm --filter web typecheck
pnpm --filter web lint
pnpm --filter web dev
```

Copy [`.env.example`](./.env.example) to `.env.local` for UI-only development.
Use the full deployment Compose stack for document lifecycle and real RAG testing:

```bash
cd ../../deploy/compose
./scripts/init-config.sh
./scripts/install.sh
```

See [Development Guide](../../docs/DEV.md),
[Architecture](../../docs/ARCHITECTURE.md), and
[Private Deployment](../../docs/runbooks/private-deployment.md).

## Ownership Rules

- Product routes derive organization, workspace, principal, group and resource scope.
- Qdrant access must compose every mandatory scope dimension and active generation.
- ParserProviders return DocumentIR; they never write product tables.
- New lifecycle work always uses DBOS with `workflow_id=job_id`.
- Only Drizzle migrations change the `app` schema; runtime identities have no DDL.
