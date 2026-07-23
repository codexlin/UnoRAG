# MeriKnow Control Plane

Next.js is the browser-facing product service. It owns identity, workspace,
ACL, document version, job, and audit models in PostgreSQL schema `app`.
FastAPI remains an internal RAG data plane.

## Local setup

```bash
cp -n .env.example .env.local
pnpm install
pnpm db:migrate
pnpm db:bootstrap
pnpm dev
```

Open <http://localhost:3000/app>. Browser API calls use the same-origin
`/api/rag/*` route, which streams requests and responses to `RAG_API_URL`.
Sign in with `MERIKNOW_ADMIN_EMAIL` and `MERIKNOW_ADMIN_PASSWORD`.

## Database

```bash
pnpm db:generate  # generate reviewed SQL after changing src/db/schema.ts
pnpm db:check
pnpm db:migrate
pnpm db:studio
```

Drizzle exclusively manages schema `app`. Do not point Drizzle migrations at
the Python-owned compatibility tables in `public`.

## Internal RAG authentication

Set `MERIKNOW_INTERNAL_SECRET` to the same random 32+ character value as
FastAPI `INTERNAL_AUTH_SECRET`. Next.js signs a 60-second context containing
tenant, workspace, principal, groups, method, canonical target, optional JSON
body digest, and a one-time `jti`. Request bodies, including multipart uploads,
are buffered up to the API's configured upload limit so the digest covers the
exact bytes forwarded to FastAPI. Direct `/v1` FastAPI calls are rejected when
`INTERNAL_AUTH_ENABLED=true`.

Browser sessions are signed with the independent `MERIKNOW_SESSION_SECRET`.
It is required, must contain at least 32 characters, and must not equal
`MERIKNOW_INTERNAL_SECRET`; there is no fallback between these trust domains.
Every RAG request reloads the active user, workspace membership, and groups
from `app.*` before creating the internal context. Missing or invalid sessions
return 401 in every environment. `/api/rag/health` remains public for probes.

The environment IDs are private-deployment bootstrap values until OIDC session
claims replace them:

- `MERIKNOW_ORGANIZATION_ID`
- `MERIKNOW_WORKSPACE_ID`
- `MERIKNOW_PRINCIPAL_ID`

`pnpm db:bootstrap` is idempotent and creates the configured private
organization, workspace, local recovery administrator identity, and owner
membership. It creates the local password credential only when absent, so
rerunning bootstrap does not silently reset an administrator password.
Deployment tooling must inject the variables from a customer-owned secret store.

`app.libraries` is the business source of truth and is exposed by the native
`/api/libraries` route. FastAPI `public.*` library/document rows remain derived
compatibility data during the migration.

## Outbox projection

Library create, update, and delete operations write `app.libraries` and an
`app.outbox_events` record in one PostgreSQL transaction. Run at least one
worker process in every deployment:

```bash
pnpm outbox:run
```

Workers claim aggregate heads with `FOR UPDATE SKIP LOCKED`, preserve event
order per library, sign requests with a `service` context, retry transient
failures with bounded exponential backoff, and move exhausted events to
`dead`. Operations can inspect `status`, `attempts`, and `last_error` in
`app.outbox_events`.

After upgrading an installation that already has libraries, enqueue an
idempotent projection for each current row:

```bash
pnpm outbox:reconcile
pnpm outbox:once
```

`outbox:reconcile` also revives matching dead reconciliation events. The
browser-facing RAG proxy denies `/v1/internal/*`; only HMAC-authenticated
service callers can invoke projection endpoints directly.

See [ADR-0004](../../docs/adr/0004-nextjs-control-plane.md).
