# ADR-0005: TypeScript Core Runtime

- Status: Implemented; live re-acceptance in progress
- Date: 2026-07-30
- Branch: `refactor/ts-core-runtime`
- Supersedes: ADR-0004
- Implementation: `5061ac0` ports the native core; `8b38294` retires the Python
  service, outbox and old deployment topology. A new Docker/browser acceptance
  report is still required before production promotion.

## Context

ADR-0004 established the correct product boundary: Next.js owns identity,
workspaces, ACL, document metadata, jobs, audit, and the browser security
boundary. The Python data plane retained parsing, lifecycle execution,
chunking, indexing, retrieval, LangGraph Ask, and compatibility projections.

That intermediate design proved the product invariants, but it now has three
costs:

1. Product behavior is split between TypeScript and Python.
2. `app.*`, `rag.*`, and compatibility `public.*` require projection and
   reconciliation machinery.
3. Python owns orchestration and database side effects even when the expensive
   parser, MinerU, is already an HTTP provider.

The desired product is a private-deployment-first knowledge service. Business
truth, authorization, lifecycle orchestration, retrieval policy, Ask delivery,
and database access should therefore live in one TypeScript ownership boundary.
External compute services may use any implementation language, but they must
not own UnoRAG business state.

## Decision

UnoRAG will migrate to a TypeScript core runtime.

```text
Browser / Customer Backend
             |
             v
Next.js + embedded Elysia API
  - session, service keys, RBAC, RLS
  - organizations, workspaces, libraries, documents
  - threads, turns, audit, usage
  - Ask SSE
             |
       +-----+-------------------------+
       |                               |
       v                               v
LangGraph.js                    DBOS worker process
Ask decision graph              durable document workflows
       |                               |
       v                               v
RetrievalService                ParserRouter
  - mandatory scope filter        - native format parser
  - embedding                     - LiteParse provider
  - Qdrant hybrid query           - MinerU HTTP provider
  - rerank                        - LlamaParse cloud provider
                                  - customer HTTP provider
       |                               |
       v                               v
Vercel AI SDK                    DocumentIR / TableIR
LLM + SSE                              |
                                       v
                                chunk -> embed -> index
```

There is no UnoRAG-owned Python application in the target topology.

- Hosted MinerU is called directly by the TypeScript worker.
- Self-hosted MinerU remains an external parser container.
- LlamaParse is an optional cloud provider and is never required for a private
  deployment.
- Customer-specific Python OCR or parsing is exposed through the same
  `ParserProvider` HTTP contract.
- The existing Python implementation remains operational during migration and
  is removed only after behavioral parity and rollback gates pass.

## Ownership

| Area | Target owner |
|---|---|
| Product schema and migrations | Drizzle / TypeScript |
| Public HTTP validation and OpenAPI | Elysia application mounted in Next.js |
| Organization, workspace, users, groups, ACL | Next.js + PostgreSQL RLS |
| Product jobs and visible progress | `app.jobs` projection |
| Durable workflow execution | DBOS system schema |
| Parser selection and provider policy | TypeScript worker |
| Heavy parsing | LiteParse locally or external `ParserProvider` |
| DocumentIR, TableIR, chunk policy | TypeScript core modules |
| Embedding and Qdrant writes | TypeScript worker |
| Retrieval and mandatory security filters | TypeScript `RetrievalService` |
| Ask control flow | LangGraph.js |
| LLM provider calls and SSE | Vercel AI SDK |
| Conversations and archive | `app.threads` / `app.turns` |
| Tracing | OpenTelemetry; LangSmith is an optional backend |

The Python SDK remains a supported HTTP client. Removing the Python server does
not imply removing the Python SDK or MCP adapter.

## Process Topology

The target deployment has two UnoRAG application processes built from the
same `apps/web` TypeScript application package:

| Process | Responsibility | Scaling |
|---|---|---|
| `web` | UI, public API, authorization, retrieval, Ask SSE | horizontal, request driven |
| `worker` | DBOS queues, parsing, indexing, cleanup | horizontal, queue constrained |

Heavy parsing must not execute in the Next.js request process. Native modules
such as LiteParse belong in the worker dependency boundary so they do not
inflate or complicate the web server bundle.

UnoRAG does not introduce internal npm workspace packages for this migration.
Domain and transport boundaries live under `apps/web/src/core`,
`apps/web/src/server`, and `apps/web/src/worker`. A module may be extracted
into a separately versioned package only when a real second application or
external consumer needs to depend on it. Process isolation does not require
package or repository isolation.

Elysia is initially mounted in a Next.js App Router catch-all route. It is a
code boundary, not a third network service. Business handlers and domain
services remain independent of Elysia so the same HTTP application can run as
a standalone Bun process later if profiling or deployment isolation requires
it.

Required infrastructure:

- PostgreSQL
- Qdrant
- object storage or a deployment-supported shared document store

Optional infrastructure:

- Redis for distributed rate limits, Ask concurrency, transient cache, and SSE
  fanout
- MinerU or another external parser provider
- LlamaParse for deployments that explicitly allow cloud document processing
- OpenTelemetry Collector and an observability backend

Redis is not a document-job source of truth.

## Library Decisions

### Elysia: Adopt at the HTTP Edge

Use Elysia for request validation, typed route composition, OpenAPI generation,
error middleware, and streaming responses. Initially export `app.fetch` from a
Next.js App Router catch-all route:

```text
browser -> Next.js route -> embedded Elysia app -> domain services
```

This keeps one public origin and one request process while preserving a path to
an independently deployed Bun API if a measured scaling need appears.

Eden may be used by the first-party web application, but it is not the public
contract. External clients depend on versioned HTTP and OpenAPI.

Shared domain contracts remain Zod-first. Drizzle schemas describe storage,
not public authorization-safe response objects. `drizzle-typebox` may reduce
boilerplate for internal models, but generated database schemas must not be
returned directly from public endpoints. Pin Elysia peer dependencies,
especially `@sinclair/typebox`, to avoid schema symbol/version mismatches.

Mounting Elysia in Next.js does not make Next.js execute on Bun or inherit
standalone Bun throughput. Scale and latency claims must be measured on the
actual Next.js deployment topology.

### DBOS: Adopt

DBOS owns durable document workflows:

```text
accept source
  -> analyze
  -> select parser
  -> submit/poll/fetch parse
  -> normalize DocumentIR
  -> chunk
  -> embed
  -> stage Qdrant generation
  -> validate
  -> activate
  -> schedule old-generation cleanup
```

DBOS checkpoints external side effects and supports deterministic workflow IDs,
queues, cancellation, retry, durable sleep, and recovery. `app.jobs` remains
the stable product-facing status projection; DBOS internal tables are not a
public API.

The first implementation must explicitly prove how a product transaction and
workflow start are reconciled. A deterministic `workflowID = job_id` plus a
missing-workflow reconciler is acceptable. The current outbox must not be
removed until this failure window has a tested replacement.

### LangGraph.js: Adopt

Port the current Ask graph one node at a time:

```text
query_router
  -> build_retrieval_plan
  -> clarify | rewrite
  -> retrieve | table_retrieve/table_execute
  -> judge
  -> retry | refuse | generate
```

The initial port preserves node names, state fields, routes, and archive debug
semantics. It does not redesign retrieval while it is proving parity.

LangGraph initially runs request-scoped without a checkpointer. PostgreSQL
`app.threads` and `app.turns` remain the conversation source of truth. A
LangGraph checkpointer may be added only for a real human-in-the-loop or
long-running agent requirement.

### Vercel AI SDK: Adopt

Use AI SDK for model providers, structured outputs, usage metadata, and SSE.
LangGraph nodes may call AI SDK functions directly. LangChain.js is not a
required dependency.

After the one-to-one graph port is stable, generation may be separated into:

```text
AskDecisionGraph -> AnswerPlan -> AI SDK stream
```

This refactor is not part of the parity cutover.

### Qdrant JavaScript Client: Adopt REST First

Use `@qdrant/js-client-rest` behind a single `RetrievalService`. The client must
never be exposed to route handlers, LangGraph nodes, LlamaIndex tools, MCP, or
the browser.

Every query must receive a server-derived `AuthorizedScope` and add mandatory
filters for:

- `organization_id`
- `workspace_id`
- requested libraries/documents
- active `generation_id`
- allowed principals/groups

REST is the default because it has a higher-level API and is easier to operate.
The gRPC package is lower-level and remains an optimization only after a
profile proves REST client overhead is material.

Collection and client versions must be compatible. Do not disable Qdrant's
compatibility check in production.

### LiteParse: Conditional Adopt

LiteParse is a local Rust parser with Node bindings. Use it as:

- a cheap complexity probe;
- a fast path for ordinary digital PDFs;
- a source of page and bounding-box data for visual citations.

Use structured JSON as the canonical input to `DocumentIR`. Markdown is a
derived/debug representation because its reconstruction can omit or regroup
content.

Do not route solely on `needsOcr`. The real-file spike showed that
`sparse-text` can flag valid digital Chinese PDFs. Routing must combine:

- extracted text amount;
- `scanned`, `garbled`, and `vector-text`;
- table, column, and graphics layout signals;
- parser quality gates.

Production images must package OCR language data explicitly. First-run network
downloads are not an acceptable OCR dependency.

MinerU remains the preferred path for low-quality scans, formulas, complex
tables, dense graphics, and other documents that fail LiteParse quality gates.

### LlamaParse: Conditional Cloud Provider

LlamaParse is an optional high-quality cloud parser for scanned, multi-column,
table-heavy, chart-heavy, and other complex documents. Its structured page
items, table output, images, bounding boxes, and job metadata are normalized
into the same `DocumentIR`, `TableIR`, and `ParserReport` used by local
providers.

It is not the default for every document. `ParserRouter` selects providers from
document signals, customer policy, deployment region, cost budget, and quality
gates:

| Policy | Preferred route |
|---|---|
| Strict private / no egress | LiteParse -> self-hosted MinerU |
| Cloud allowed / balanced | LiteParse -> quality gate -> LlamaParse or MinerU |
| Quality benchmark | selected samples dual-run; never routine fan-out |

The production integration must:

- require an explicit `external_parser_allowed` policy;
- record provider, tier, dated parser version, credits/cost, region, latency,
  quality report, and immutable raw artifact reference;
- pin a dated parsing version rather than `latest`;
- submit asynchronously and let DBOS durably wait for a verified signed
  webhook, with bounded polling as a recovery path;
- enforce upload, timeout, retention, deletion, and monthly credit budgets;
- support North America and EU data-residency choices where available;
- fail over without making cloud availability part of private deployment
  correctness.

The current official pricing model is credit-based. A free account or dashboard
allowance is useful for evaluation but is not an architectural capacity or SLA
assumption.

### LlamaIndex.TS: Optional

LlamaIndex is not the security or lifecycle layer. It may be introduced behind
`RetrievalService` for evaluated capabilities such as:

- sub-question decomposition;
- document/query-engine tools;
- recursive or multi-index retrieval experiments.

It must not own ACL, active generations, Qdrant payload schema, product jobs,
or conversation persistence. Do not add it to the production dependency graph
until one named use case beats the current retrieval baseline.

### LangSmith: Optional Backend

Instrument with OpenTelemetry. Development or preproduction may export traces
to LangSmith, and enterprise customers may use a supported self-hosted
observability stack. UnoRAG must continue to answer when LangSmith is absent.

## Core Contracts

### AuthorizedScope

```ts
type AuthorizedScope = {
  organizationId: string;
  workspaceId: string;
  principalIds: string[];
  libraryIds: string[];
  documentIds?: string[];
  activeGenerationIds: string[];
};
```

Only the server constructs this value. User input and model tool calls cannot
weaken it.

### ParserProvider

```ts
interface ParserProvider {
  readonly name: string;
  readonly version: string;
  readonly capabilities: ParserCapabilities;

  analyze(input: ParseInput): Promise<DocumentAnalysis>;
  submit(input: ParseInput, options: ParseOptions): Promise<ParseSubmission>;
  poll(task: ProviderTask): Promise<ParseProgress>;
  fetchResult(task: ProviderTask): Promise<ParseResult>;
  cancel(task: ProviderTask): Promise<void>;
}
```

Each provider returns a normalized `DocumentIR`, a `ParserReport`, and an
optional immutable reference to its raw artifact. Providers do not access
product PostgreSQL or Qdrant.

### RetrievalService

```ts
interface RetrievalService {
  retrieve(input: {
    query: string;
    plan: RetrievalPlan;
    scope: AuthorizedScope;
  }): Promise<RetrievalResult>;
}
```

The mandatory scope filter is applied inside this service, not at its callers.

## Migration Strategy

This is a strangler migration, not a rewrite-and-replace release.

### M0: Contracts and Characterization

- Create `apps/web/src/core/contracts`,
  `apps/web/src/core/document-ir`, and shared Zod schemas.
- Create a transport-independent domain service boundary and an embedded
  Elysia API characterization route.
- Serialize representative Python DocumentIR/TableIR fixtures.
- Freeze current Ask state, route names, debug fields, and public API tests.
- Add Python-to-TypeScript contract fixtures.
- Add normalized LiteParse, MinerU, and LlamaParse result fixtures; live cloud
  credentials are not required for deterministic contract tests.
- Decide the supported Qdrant server/client version pair.

Exit gate:

- TS schemas accept every committed representative fixture.
- Public Retrieve/Ask v1 tests remain unchanged.
- No runtime traffic changes.

### M1: TypeScript Retrieval

- Create `apps/web/src/core/retrieval`.
- Implement Qdrant payload schema, collection manager, mandatory scope filter,
  dense/sparse hybrid query, and result mapping.
- Dual-run Python and TS retrieval against the same active generation.
- Keep response generation in Python.

Implementation note: the M1 kernel and opt-in `shadow` execution mode are
implemented. Shadow mode never changes the customer response and remains off
by default. Production cutover is still an M4 decision.

Exit gate:

- Cross-organization/workspace/ACL leakage is zero.
- Candidate and citation parity meets the agreed golden-set threshold.
- P50/P95 does not regress beyond the release budget.

### M2: TypeScript Ask Graph

- Create `apps/web/src/core/ask-graph` and `apps/web/src/core/ai`.
- Port deterministic nodes first, then table nodes, then generation.
- Load conversation history from `app.threads` / `app.turns`.
- Shadow Python and TS graphs for deterministic and live evaluation.

Exit gate:

- Query type, retrieval plan, refusal, retry route, table execution, and
  citation coverage meet parity thresholds.
- Existing public API and Workspace SSE event contracts remain compatible.

### M3: DBOS Lifecycle and Parser Providers

- Create a worker entrypoint under `apps/web/src/worker` and run it as an
  independently scalable process/image from the same application package.
- Add DBOS system schema and least-privilege worker identity.
- Implement `ParserProvider`, MinerU provider, LiteParse provider, optional
  LlamaParse provider, and DocumentIR normalizers.
- Port chunking, TableIR, embedding, Qdrant staging, activation, cancellation,
  and cleanup.
- Keep the Python lifecycle worker available for rollback.

Implementation note: the DBOS runtime, independent system database,
least-privilege deployment, deterministic dispatch/reconciliation,
generation-cleanup workflow, and opt-in staged `document.delete` workflow are
implemented. LiteParse and MinerU provider foundations are also present.
`document.ingest`, normalization/chunking/embedding/activation, and the
real-corpus cutover gate are not yet ported, so M3 is still in progress.

Exit gate:

- Real file corpus passes parse/index/Ask tests.
- Failure injection covers process crash, MinerU pending/429, Qdrant outage,
  cancellation, duplicate dispatch, stale desired version, and activation
  failure.
- A failed new version continues serving the old active version.

### M4: Controlled Cutover

- Cut Retrieve/Ask to TS behind an environment/configuration gate.
- Cut selected ingest jobs to DBOS by deterministic cohort.
- Run shadow comparison and production-style soak in preproduction.
- Keep rollback to Python at the API and job-dispatch boundaries.

Exit gate:

- Zero leakage fuse passes.
- Golden and real-file gates pass.
- Job reconciliation has no missing or duplicate terminal workflows.
- Capacity and operational runbooks are updated.

### M5: Retirement

Only after the rollback window expires:

- stop FastAPI and the Python lifecycle worker;
- retire internal HMAC proxy hops that no longer exist;
- retire compatibility `public.*` and `rag.*` projections after backfill and
  read checks;
- retire the old outbox paths after DBOS dispatch reconciliation is proven;
- remove Python server images and dependencies;
- retain the Python HTTP SDK and MCP adapter.

## Library Spike Results

Environment:

| Item | Version |
|---|---|
| Node.js | 22.22.2 |
| pnpm | 9.7.1 |
| Bun | 1.3.13 |
| `@dbos-inc/dbos-sdk` | 4.24.16 |
| `@langchain/langgraph` | 1.4.8 |
| `llamaindex` | 0.12.1 |
| `@llamaindex/liteparse` | 2.10.1 |
| Qdrant JS clients | 1.18.0 |
| AI SDK | 7.0.42 |
| Zod | 4.4.3 |
| Elysia | 1.4.29 |
| Elysia Eden / OpenAPI / OTel | 1.4.9 / 1.4.15 / 1.4.11 |
| `drizzle-typebox` | 0.3.3 |
| `@llamaindex/llama-cloud` | 2.13.0 |

Verified:

- LangGraph `StateGraph` compiled and executed on Node 22.
- DBOS used a real PostgreSQL 17 database; a workflow with two steps and a
  durable sleep completed, persisted, and replayed by the same workflow ID
  without repeating completed steps.
- LlamaIndex built a local `VectorStoreIndex` with a deterministic embedding
  and retrieved the expected document.
- Qdrant REST created a collection and payload indexes, upserted dense+sparse
  points, executed RRF with organization/workspace/generation/ACL filters, and
  returned only the authorized point.
- Qdrant gRPC connected successfully, but its API is lower-level.
- LiteParse loaded through its native Node binding and parsed seven committed
  PDFs.
- Elysia request validation, Eden calls, a streaming `Response`,
  `drizzle-typebox`, OpenAPI, and OpenTelemetry loaded and executed on both
  Node 22 and Bun 1.3.
- An Elysia catch-all route compiled in a real Next.js 16.2.11 production
  build; live GET and POST requests returned successfully from `next start`.
- The LlamaCloud TypeScript client imported on Node 22 and exposed file-upload
  and parsing APIs. A live LlamaParse parse was not run without a project API
  key, so output normalization remains an M0 contract-fixture task.

LiteParse observations:

| File | Outcome |
|---|---|
| `leave-digital.pdf` | text and bboxes recovered; false-positive `sparse-text` OCR signal |
| `leave-scanned.pdf` | correctly identified as scanned; no text without OCR |
| `manual-with-figure.pdf` | text recovered; embedded-image signal |
| `twocolumn.pdf` | 5,441 text characters recovered; layout quality still needs a gold comparison |
| `crosstable-large.pdf` | table detected; Markdown emitted 78 table rows |
| `scan-lowcontrast.pdf` | correctly identified as scanned; no usable text without OCR |
| `mixed-charts.pdf` | narrative text recovered; chart semantics not extracted |

Important findings:

1. LiteParse JSON is suitable for normalization, but Markdown is not a
   canonical representation. On `leave-digital.pdf`, Markdown regrouped body
   text and omitted useful heading/header structure visible in JSON.
2. LiteParse OCR did not complete within 60 seconds in an environment without
   preinstalled tessdata. Language assets and cold-start behavior require
   explicit image engineering before OCR can be enabled.
3. The repository currently pins Qdrant server `v1.13.2`, while the tested JS
   clients are `1.18.0`. Functional REST/gRPC checks passed, but the official
   compatibility check reports the version gap. M0 must either pin a matching
   1.13 client or perform a backed-up, tested Qdrant upgrade before production
   TS traffic.

Approximate installed package footprints from the isolated spike:

| Package group | Size |
|---|---:|
| DBOS | 2.1 MB |
| LangGraph/LangChain scoped dependencies | 26 MB |
| LlamaIndex top-level package | 1.1 MB |
| LiteParse native package | 33 MB |
| Qdrant REST + gRPC | 2 MB |
| AI SDK | 7.7 MB |

These are development installation sizes, not final compressed image deltas.

## References

- [Elysia with Next.js](https://elysiajs.com/integrations/nextjs.html)
- [Elysia with Drizzle](https://elysiajs.com/integrations/drizzle.html)
- [Elysia with AI SDK](https://elysiajs.com/integrations/ai-sdk.html)
- [Elysia OpenTelemetry](https://elysiajs.com/plugins/opentelemetry.html)
- [LlamaParse TypeScript quickstart](https://developers.llamaindex.ai/llamaparse/)
- [LlamaParse parsing tiers](https://developers.llamaindex.ai/llamaparse/parse/guides/tiers/)
- [LlamaParse pricing](https://developers.llamaindex.ai/llamaparse/general/pricing/)
- [LlamaParse webhooks](https://developers.llamaindex.ai/llamaparse/general/webhooks/)

## Release Invariants

The migration does not relax any current invariant:

1. No cross-organization, cross-workspace, or ACL leakage.
2. Missing scope fails closed.
3. Unactivated generations are never retrievable.
4. A failed replacement never displaces the old active version.
5. Stale jobs cannot activate over a newer desired version.
6. Public API contracts remain backward compatible through the cutover.
7. Parser and observability providers are optional runtime dependencies, not
   business truth.
8. Every phase has a tested rollback before receiving production traffic.
