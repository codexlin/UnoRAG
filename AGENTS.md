<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

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

### Product UI and motion

Read `docs/DESIGN.md` before changing product UI, copy, styling, components, or
motion. It is the single accepted target design, not a claim that the redesign
has shipped. Use the existing Base UI/local UI components, CSS-first feedback,
`motion/react`, Sonner, and Lucide; do not add a parallel component or animation
framework for visual polish. Preserve source authorization, stream isolation,
active-version/job distinctions, unknown metrics, and reduced-motion behavior.
For ordinary controls, use the shadcn/ui `base-nova` registry and local
`src/components/ui/` sources before writing a new primitive. Keep the existing
Base UI foundation; use the standard Select composition, not NativeSelect or a
native-event compatibility wrapper. Reuse official Base UI AI Elements for chat
presentation without replacing the authorized citation/SSE contracts. Do not add
a parallel Radix/component framework. Business
compositions remain domain components. Native file inputs, minimal global-error
recovery and specialized inline citations may retain native elements when their
contracts require it. Document any new exception in `docs/DESIGN.md`.
Design decisions live there, not in new parallel blueprints or agent-only rules.
Before replacing a page, check its existing-capability map in that document and
the actual API fields/actions. Simplified mockups are not a feature inventory.
Keep presentation work separate from new data contracts; do not guess version
numbers, introduce per-row history requests, or conflate readiness with job state.

### Issue tracker

Issues and PRDs live as GitHub Issues in `codexlin/UnoRAG`. Use `gh issue` and
`gh pr` from this clone so the remote is resolved automatically. Do not treat
pull requests as feature-request tickets. Never put credentials, customer data,
prompts, retrieved content, or sensitive logs in a public issue.
