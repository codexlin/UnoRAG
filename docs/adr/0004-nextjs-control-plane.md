# ADR-0004: Next.js Control Plane and Python RAG Data Plane

- Status: Accepted
- Date: 2026-07-24

## Context

MeriKnow began as a vertical Python slice: FastAPI owns product metadata and
also runs parsing, retrieval, LangGraph Ask, and archive persistence. The web
client calls FastAPI directly. This was useful while DocumentIR, MinerU,
chunking, TableIR, and retrieval contracts were still changing.

Private enterprise delivery now requires identity, workspace membership, ACL,
document versions, jobs, audit, and customer-owned secrets. Keeping all of
that in the RAG process would couple product evolution to Python compute
workers and expose the data plane directly to browsers.

## Decision

Use two explicit ownership boundaries:

1. Next.js is the product control plane and browser-facing BFF.
2. FastAPI and Python workers are the internal RAG data plane.

Drizzle exclusively manages the PostgreSQL `app` schema. Python continues to
manage its existing tables during migration and may later own a separate
`rag` schema for graph checkpoints and processing internals. Drizzle and
SQLAlchemy/Alembic must never migrate the same table.

Browser calls use same-origin `/api/rag/*`. Next.js proxies one streaming
request to FastAPI and attaches a short-lived HMAC request context containing
tenant, workspace, principal, groups, request binding, an exact body digest,
and a one-time `jti`. FastAPI can require this context with
`INTERNAL_AUTH_ENABLED=true`; production requires Redis-backed replay
protection.

Private deployments bootstrap a local recovery administrator credential.
Browser sessions are HttpOnly HMAC cookies signed with a key separate from the
internal RAG key. Every BFF request reloads the active user, workspace
membership, and groups from PostgreSQL before signing the internal context.
The provider contract also defines the OIDC callback boundary; an OIDC adapter
can replace local authentication without changing the RAG context.

`app.libraries` is the business source of truth and is served by native Next.js
routes. Library mutations transactionally append ordered events to
`app.outbox_events`. Independent workers claim events with
`FOR UPDATE SKIP LOCKED`, call idempotent FastAPI projection endpoints using a
signed service context, retry transient failures, and retain terminal failure
details for operators. Workers heartbeat long-running leases and abort work
after losing ownership. Library deletion uses a service-only, idempotent
projection endpoint and fails closed when vector or object cleanup is
unavailable. Successful ingest responses and document list probes
still project RAG document state into `app.documents`; document lifecycle
callbacks will move to the same protocol when asynchronous ingest ownership is
finalized. Existing FastAPI `public.*` metadata remains a derived compatibility
representation.

The compatibility `rag_library_id` remains globally unique while FastAPI uses
it as the primary key. Product-facing names are not unique. Supporting the
same external library identifier in multiple organizations requires a future
composite-key data-plane migration; it must not be simulated with scope-only
control-plane uniqueness.

Qdrant points require tenant, workspace, and ACL payload. Dense retrieval,
BM25 corpus scroll, table-group loading, document deletion, and session memory
all consume the same `AccessScope`. Missing-scope legacy points are invisible
and must be reindexed. New documents are workspace-visible by default;
restricted principal/group filters are implemented in the data plane, while
the product API for editing document ACL remains a later slice.

## Data Ownership

The `app` schema owns:

- organizations, users, groups, and memberships;
- workspaces and roles;
- libraries and documents as product metadata;
- document versions and the constrained `document_active_versions` pointer;
- document ACL;
- user-visible jobs;
- audit logs.

The Python data plane owns:

- DocumentIR, TableIR, and parser reports during processing;
- chunking, embedding, Qdrant records, and retrieval;
- LangGraph execution and RAG evaluation;
- worker-local processing state and future graph checkpoints.

Object storage, PostgreSQL, Qdrant, model credentials, and encryption keys are
customer-owned in private deployments.

## Consequences

- The browser no longer needs the FastAPI network address.
- SSE and downloads stream through the BFF. Upload request bodies are buffered
  within the configured 50 MiB limit so their exact digest can be signed.
- Heavy parsing and model calls remain outside the Next.js request process.
- Internal API versioning, idempotency, retries, and callbacks become explicit
  engineering requirements.
- The migration keeps two metadata representations temporarily. Library
  projection is transactionally queued and eventually consistent; each system
  still writes only the tables it owns.
- Existing Qdrant data needs reindexing before enabling authenticated retrieval.
