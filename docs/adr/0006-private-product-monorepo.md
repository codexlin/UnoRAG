# ADR-0006: Private Product Monorepo and Edition Boundaries

- Status: Superseded in product/edition direction; package-boundary principles only
- Date: 2026-08-06
- Scope: repository, package, build and edition topology
- Partially supersedes: ADR-0005 repository/package-topology decision that deferred npm
  workspaces; ADR-0005 remains authoritative for the TypeScript-only runtime,
  Next.js boundary, DBOS lifecycle and data ownership.

ADR-0007 supersedes this ADR's private-repository, commercial-edition and
entitlement decisions. The current repository remains one root TypeScript package
with no scheduled monorepo migration. Only the rules “extract packages for a real
runtime/consumer boundary” and “keep one database migration owner” remain active;
the edition topology and migration plan below are historical.

## Context

ADR-0005 deliberately kept UnoRAG as one root TypeScript package. At that time
the work was a runtime migration, not a product-family split: Web and Worker
were two process entries over one implementation, and extracting packages
would have added migration risk without a second application or consumer.

That premise has changed. UnoRAG now has several independently built or operated
composition roots:

- the Next.js Workspace and Knowledge API;
- DBOS workflow execution and its control/reconciliation loop;
- migration, bootstrap, inspection and maintenance commands;
- the standard private-deployment product;
- optional Professional Ops and AI-engineering capabilities;
- Compose, Helm and immutable release artifacts that must remain compatible.

These units share API contracts, domain types, database migrations, lifecycle
invariants and one release identity. Keeping every dependency in one root
package makes process-specific dependency ownership hard to see, encourages
imports across browser/server/worker boundaries and gives commercial editions
no explicit composition contract.

The repository remains private for the current product-validation phase. This
ADR does not make an open-source licensing decision. Any future public Community
distribution requires a separate ADR, legal review, history and secret scanning,
and an explicit export or repository-visibility design.

## Decision

UnoRAG will become one **private product monorepo**, migrated incrementally with
pnpm workspaces. It remains one product and one business data model; Monorepo is
a source/build boundary, not a microservice mandate.

The repository has one lockfile, one Git release identity and one coordinated
migration history. Internal workspace packages initially use `workspace:*` and
are not independently published or versioned. A package is extracted only when
it creates an enforceable dependency boundary or is consumed by more than one
composition root.

The target logical topology is:

```text
apps/
  web/                 Next.js UI, browser boundary and Knowledge API
  worker/              DBOS workflow composition root
  control/             dispatch, reconciliation and scheduled maintenance
  ops/                 bootstrap, inspection, backfill and repair commands

packages/
  contracts/           public HTTP, job, event and IR contracts
  core/                chunking, retrieval, table execution and Ask graph
  database/            Drizzle schema, repositories and migration owner
  auth/                session, RBAC, ACL and Service Key policies
  parser/              ParserProvider, LiteParse and MinerU adapters
  storage/             local and future object-storage adapters
  observability/       logs, metrics, traces, alerts and safe diagnostics
  edition/             build-time edition and capability contract
  professional/        commercial product enhancements
  ai-engineering/      optional Langfuse and evaluation integrations

deploy/
  compose/             reference private deployment
  helm/                Kubernetes starter
  professional/        additive edition deployment assets where required
```

This is a target ownership map, not permission to create empty packages. The
exact physical directory appears only when its boundary is implemented and
tested. `apps/control` and `apps/ops` may continue to share the Worker/Ops image;
an application entry does not automatically require another container image.

## Dependency Rules

Dependencies flow toward stable domain contracts:

```text
apps/*
  -> professional / ai-engineering
  -> auth / parser / storage / observability / database
  -> core
  -> contracts

professional -> edition -> contracts
ai-engineering -> edition -> core/contracts
```

The following rules are mandatory:

1. `contracts` imports no application, database, framework or edition code.
2. `core` imports neither Next.js, React, Drizzle nor Professional modules.
3. `database` is the only Drizzle schema and application-migration owner.
4. `auth` owns policy decisions; UI capability checks are projections, not
   authorization.
5. `parser` returns DocumentIR/TableIR and never writes business metadata.
6. Worker/control packages do not import browser Session or React modules.
7. Core packages never import Professional code. Composition roots select an
   edition and inject implementations through typed contracts.
8. Optional observability and AI-engineering integrations cannot become request,
   ingest or recovery availability dependencies.
9. Qdrant access remains behind scoped retrieval/indexing services; moving code
   between packages cannot bypass organization, workspace, ACL, document or
   active-generation filters.

Package exports, TypeScript configuration and automated dependency-boundary
tests must enforce these rules. Path aliases alone are not an ownership model.

## Edition Model

The repository initially produces two commercial compositions:

| Edition | Required behavior |
|---|---|
| Standard | Complete private deployment with identity, ACL, versioning, parsing, retrieval, Ask, native diagnostics, backup and upgrade support |
| Professional | Standard plus selected enterprise operations, integration and AI-engineering capabilities |

Standard must remain independently operable. Security isolation, atomic document
versions, basic diagnostics, backup/restore and data export must not be withheld
to manufacture an unusable lower edition.

Edition selection is a build/deployment composition, not a browser-only feature
flag. The authoritative capability set is resolved server-side and is applied to:

- Route Handler authorization and service behavior;
- Worker module registration;
- navigation and UI actions;
- deployment dependencies and configuration validation;
- release metadata and support diagnostics.

UnoRAG will not load arbitrary JavaScript plugins, install npm packages at runtime
or discover untrusted Worker code dynamically. Edition modules are registered at
build time, included in the signed image and covered by the same dependency and
security scans.

License enforcement details, grace periods and commercial entitlement transport
are deferred to a dedicated ADR. A future mechanism must fail predictably and must
not make customer data unreadable merely because a commercial entitlement expires.

## Data and Migration Ownership

Monorepo packages do not create multiple database owners:

- `packages/database` owns the `app` schema and the single forward Drizzle history;
- DBOS continues to own only its system schema;
- Qdrant remains a derived projection, never the product fact source;
- edition code cannot run an independent migration tool over `app.*`;
- schema changes required by an edition go through the same migration review,
  upgrade, rollback-compatibility and least-privilege tests as core changes.

If Professional later needs a substantial optional persistence model, a separate
`pro` PostgreSQL schema may be proposed. That requires another ADR defining FK,
backup, downgrade and deletion semantics; it is not created pre-emptively here.

## Build and Release Contract

All artifacts in one release are derived from one immutable Git commit and lockfile.
The release manifest records at least:

- Git SHA and DBOS application version;
- edition and server-authoritative capability digest;
- database migration head;
- Web, Worker, Migrator and Ops image digests;
- image platform and dependency/SBOM scan result;
- Parser, model and evaluation identifiers required by the existing release gate.

CI must validate the Standard composition without Professional-only configuration,
then validate the Professional composition. A Professional failure cannot be hidden
by a passing Standard build. Database migration and document-version transaction
tests continue to use real PostgreSQL. Release images remain digest-pinned; workspace
packages do not introduce independently floating runtime versions.

pnpm workspaces are sufficient for the initial migration. Turborepo, Nx, Bazel and
remote build caching are deferred until measured CI duration or build fan-out proves
the need. A workspace layout alone is not a reason to add another task framework.

## Migration Plan

Migration is incremental and every step must leave the repository buildable:

1. Add the pnpm workspace shell, package naming convention and boundary tests while
   retaining the root Next.js application.
2. Extract machine-readable and TypeScript contracts first; preserve public HTTP and
   Job payload shapes exactly.
3. Extract pure core modules and prove they have no Next.js, Drizzle or edition imports.
4. Extract database, observability, parser and storage ownership one boundary at a
   time, with temporary compatibility exports only when needed.
5. Create Worker, control and ops composition roots without changing DBOS workflow
   IDs, queue names, runtime database roles or image count by accident.
6. Move Next.js to `apps/web` last, after Docker standalone tracing, static assets,
   migrations and deployment scripts can resolve workspace paths.
7. Introduce `edition`, Professional and AI-engineering composition only after the
   Standard build is independently green.
8. Remove compatibility exports and enforce the final package graph.
9. Run the full RC acceptance matrix after migration: clean install, upgrade from the
   previous immutable release, browser RBAC, real-file ingest, replace/reindex/delete,
   cross-scope isolation, dependency failure, backup/restore and release evidence.

Large mechanical moves and behavior redesign must not share one commit. File movement
does not justify changing HTTP contracts, database semantics, retrieval policy or UI
behavior. `git diff --check`, deterministic tests, TypeScript, lint and production
build remain required at each stage.

## Alternatives Considered

### Keep the Root Modular Application

This minimized risk during ADR-0005 and remains a valid rollback point. It is no longer
the target because multiple edition and process composition roots now need enforceable
dependency and build boundaries.

### Split Community and Professional into Separate Repositories Now

Rejected for the current private phase. It would introduce version synchronization,
cross-repository migrations and duplicated release coordination before any public
distribution requires the visibility boundary.

### Private Canonical Monorepo with a Public Export

Deferred, not rejected. It may become appropriate if a Community edition is approved.
Public export requires allowlisted files, secret/history scanning, contribution
backflow and commit mapping; none of those mechanisms are implied by this ADR.

### Multiple Runtime Microservices

Rejected as a consequence of package extraction. Web and Worker remain separate
processes for scaling and failure isolation, but package boundaries do not justify
new network hops, databases, queues or duplicated sources of truth.

### Adopt Turborepo or Nx Immediately

Deferred. pnpm supplies the workspace and dependency primitives currently required.
Additional orchestration must earn its operational cost with measured build data.

## Consequences

Positive consequences:

- process and edition dependencies become reviewable and testable;
- Standard and Professional can change atomically under one commit;
- Web bundles need not inherit parser/Worker dependencies accidentally;
- shared contracts stop depending on application path aliases;
- future public export has a clearer technical boundary if the business chooses it.

Costs and risks:

- moving Next.js, Drizzle, Docker and test paths can cause subtle packaging failures;
- too many small packages would increase navigation and build complexity;
- Professional code in the private repository remains visible to every repository
  collaborator, so repository access still requires least privilege;
- a single repository gives coordinated releases, but a broken global migration can
  still affect every edition and therefore needs stronger CI, not weaker review.

## Acceptance Criteria

This ADR is implemented only when all of the following are true:

1. Standard and Professional compositions build from one lockfile and Git SHA.
2. Automated tests reject forbidden package dependency directions.
3. Standard starts and passes core acceptance without Professional configuration.
4. Web and Worker production artifacts contain only their required runtime dependency
   closures, verified through image inspection and vulnerability scanning.
5. Drizzle remains the sole `app` migration owner and clean migration/upgrade tests pass.
6. DBOS workflow IDs, queues and product `app.jobs` projection remain compatible.
7. Compose and Helm render both supported compositions without exposing internal
   services or weakening database roles.
8. The full post-migration RC evidence is bound to image digest, edition, migration
   head and commit.

Until these criteria pass, the current root-package release remains the production
reference and “Monorepo migration complete” must not appear in release evidence.
