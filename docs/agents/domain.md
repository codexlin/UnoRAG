# Domain Docs

How engineering agents should orient themselves before changing this repository.

## Read in this order

1. [`../STATUS.md`](../STATUS.md) for shipped capability, known gaps and current priorities.
2. [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for runtime ownership and security boundaries.
3. [`../DEVELOPMENT.md`](../DEVELOPMENT.md) for repository rules and verification commands.
4. [`../adr/README.md`](../adr/README.md) before opening individual ADRs; superseded ADRs are history, not guidance.

The repository does not currently use `CONTEXT.md` or `CONTEXT-MAP.md`. Do not invent a second documentation
hierarchy unless a real bounded context needs a glossary that the formal product documents cannot provide.

## Current code map

```text
src/app/          product pages and HTTP routes
src/core/         parser, IR, chunking, retrieval and Ask graph
src/lib/server/   identity, authorization and product application services
src/db/           Drizzle schema and repositories
src/server/       transport and observability adapters
src/worker/       DBOS workflows, dispatch and reconciliation
```

Use the vocabulary in `PRODUCT.md`, `ARCHITECTURE.md` and runtime contracts. When a proposed change contradicts
an accepted ADR, identify the conflict explicitly and create a new decision record if the change is adopted.

## Flag ADR conflicts

If your output contradicts a current ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0005 runtime ownership — reopen the decision before implementation._
