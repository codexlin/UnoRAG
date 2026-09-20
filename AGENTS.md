<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Agent skills

### Project orientation

Read these sources in order before changing the repository:

1. `docs/STATUS.md` for shipped capabilities, gaps, and priorities.
2. `docs/ARCHITECTURE.md` for runtime ownership and security boundaries.
3. `docs/DEVELOPMENT.md` for repository rules and verification commands.
4. `docs/adr/README.md` before individual ADRs; superseded ADRs are history.

The repository uses one documentation hierarchy. Do not create `CONTEXT.md`,
`CONTEXT-MAP.md`, or another documentation tree unless a real bounded context
cannot be described by the formal product documents.

### Code ownership map

- `src/app/`: product pages and HTTP routes
- `src/core/`: parser, IR, chunking, retrieval, and Ask graph
- `src/lib/server/`: identity, authorization, and application services
- `src/db/`: Drizzle schema and repositories
- `src/server/`: transport and observability adapters
- `src/worker/`: DBOS workflows, dispatch, and reconciliation

Flag conflicts with an accepted ADR explicitly instead of silently overriding it.

### Issue tracker

Issues and PRDs live as GitHub Issues in `codexlin/UnoRAG`. Use `gh issue` and
`gh pr` from this clone so the remote is resolved automatically. Do not treat
pull requests as feature-request tickets. Never put credentials, customer data,
prompts, retrieved content, or sensitive logs in a public issue.
