# Retrieve / Ask Public API v1 — Frozen Contract

> Status: **frozen** (2026-07-27)
> Machine-readable source: [`contracts/public-api-v1.openapi.json`](../../contracts/public-api-v1.openapi.json)
> Served at: `GET /api/v1/openapi.json`
> Integration guide: [`../INTEGRATION.md`](../INTEGRATION.md)

This document is the **canonical human contract** for Knowledge Service Retrieve/Ask v1.
OpenAPI is the machine source of truth for request/response schemas and error codes.
Customer integrations must use this HTTP surface and must not invent a second schema.

## Version markers

| Marker | Value | Where |
|--------|-------|-------|
| Path prefix | `/api/v1/...` | Public gateway (Next.js) |
| Response header | `X-UnoRAG-Api-Version: 1` | Every success and error |
| Response body | `api_version: "v1"` | Every **success** body |
| OpenAPI `info.version` | `1.0.0` | Contract artifact |

Breaking changes require a new major (`/api/v2` + new OpenAPI). Additive optional fields may ship within v1 only if documented here and in OpenAPI.

## Auth models

| Mode | Entry | Identity | Scopes |
|------|-------|----------|--------|
| **Service Key (public v1)** | `POST /api/v1/retrieve` · `POST /api/v1/ask` | `Authorization: Bearer mk_svc_…` (alt: `X-UnoRAG-Service-Key`) | `retrieve`, `ask` |
| **Session (Workspace)** | `/api/rag/v1/*` via browser BFF | Cookie session + workspace membership | Not part of public v1 |
| **Session (internal UI)** | `/api/rag/v1/*` | Cookie session + workspace membership | Not part of public v1 |

Service Key rules (v1):

- Scopes: `retrieve` and/or `ask` only.
- Optional `library_ids` allow-list; omit/empty = all libraries in the key’s workspace (still subject to ACL + active generation).
- Principal: `service:<key_id>`; workspace-scoped; no cross-workspace.
- Restricted per-user ACL documents are **not** auto-visible to service principals.
- Customers must hold keys **server-side only**.

## Paths (public v1 surface)

| Method | Path | Scope | Implementation |
|--------|------|-------|----------|
| `POST` | `/api/v1/retrieve` | `retrieve` | Native TypeScript retrieval runtime |
| `POST` | `/api/v1/ask` | `ask` | Native TypeScript Ask runtime |
| `GET` | `/api/v1/openapi.json` | none | static contract |

No other `/api/v1/*` resources are in this freeze.

## Request schemas (canonical)

Unknown fields → `400 invalid_request`. Clients **must not** send `ask_overrides` or algorithm knobs; the gateway injects workspace policy fail-closed.

### Retrieve

```json
{
  "query": "string (1–4000)",
  "library_id": "string (1–128)",
  "top_k": 6,
  "filters": {
    "record_type": "chunk",
    "doc_id": "optional",
    "table_id": "optional",
    "document_version_id": "optional"
  }
}
```

- `question` is a **deprecated** alias for `query`; both together → `400`.
- `top_k` optional integer 1–50.
- `filters` optional object; only the four keys above.

### Ask

```json
{
  "question": "string (1–4000)",
  "library_id": "string (1–128)",
  "session_id": "customer-opaque-id"
}
```

- `session_id` optional (≤256); customer-controlled opaque id; does **not** create a Workspace archive thread.

### Limits

| Limit | Value |
|-------|-------|
| JSON body | ≤ 65,536 bytes |
| Gateway upstream wait | 60 seconds → `504 upstream_timeout` |
| Content-Type | `application/json` only |

## Response schemas (canonical)

All success bodies include `api_version: "v1"` and `trace_id` (equals `X-Request-Id`).

### Retrieve success

```json
{
  "api_version": "v1",
  "trace_id": "uuid",
  "query": "…",
  "library_id": "…",
  "citations": [],
  "refused": true,
  "refuse_reason": "no_matching_evidence",
  "retrieval_mode": "dense"
}
```

Stable top-level keys only. **Not** in public response: `retrieval_debug`, tenant/generation internals, full chunk `text`/`body`.

### Ask success

```json
{
  "api_version": "v1",
  "trace_id": "uuid",
  "session_id": "…",
  "question": "…",
  "answer": "…",
  "citations": [],
  "refused": false,
  "refuse_reason": null,
  "retrieval_mode": "hybrid"
}
```

### Citation object (v1)

Required keys (nullable location fields stay present as `null`):

```text
id · index · title · snippet · score
document_id · filename
page · page_start · page_end · section_path
table_id · figure_id · row_start · row_end · record_type
```

`score` is a display float in `[0, 1]`. Internal score decomposition is not public.

## Error envelope

```json
{
  "error": {
    "code": "invalid_request",
    "message": "human-readable",
    "request_id": "uuid",
    "retryable": false,
    "details": {}
  }
}
```

Headers: `X-Request-Id`, `X-UnoRAG-Api-Version: 1`; `401` also sets `WWW-Authenticate: Bearer`; `429` may set `Retry-After`.

### Stable error codes

| HTTP | `error.code` | Retryable |
|------|--------------|-----------|
| 400 | `invalid_request` | no |
| 401 | `authentication_required` · `authentication_failed` | no |
| 403 | `insufficient_scope` · `library_access_denied` | no |
| 413 | `payload_too_large` | no |
| 415 | `unsupported_media_type` | no |
| 429 | `rate_limit_exceeded` | yes |
| 502 | `upstream_unavailable` · `invalid_upstream_response` | yes |
| 503 | `service_unavailable` · `policy_unavailable` · `authentication_backend_unavailable` · `gateway_misconfigured` | yes |
| 504 | `upstream_timeout` | yes |

Upstream internal names (e.g. `llm_upstream_unavailable`) are **never** passed through as public `error.code`.

## Rate limit, audit, usage (v1 ops surface)

| Concern | v1 behavior |
|---------|-------------|
| Rate limit | Error shape frozen (`429` + `rate_limit_exceeded` + optional `Retry-After`). Optional process-local limiter via `UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE` (per service key). Multi-instance / cluster limits: Redis or Ingress — out of band. |
| Audit | Each public retrieve/ask attempt writes `audit_logs` action `knowledge.retrieve` / `knowledge.ask` (service key id in `details`; `actor_id` null). Key create/revoke remain control-plane audits. |
| Usage | Structured stdout JSON line `event=knowledge.api.usage` with key_id, target, library_id, status, refused, citation_count, duration_ms, request_id. Token ledger / cost panels are **deferred**. |
| `last_used_at` | Updated on successful key authentication. |

## Internal streaming shape (not a public v1 path)

**Public v1 does not expose** `POST /api/v1/ask/stream` or `/answer/stream`.

Internal Workspace SSE (`POST /v1/ask/stream` via the Session boundary) uses these event names:

| Event | Data |
|-------|------|
| `meta` | `{ session_id, refused, refuse_reason, trace_id, retrieval_mode, … }` |
| `citations` | `Citation[]` (same public citation shape) |
| `token` | string chunk |
| `done` | final `{ session_id, question, answer, citations, refused, refuse_reason, trace_id, retrieval_mode }` — public projection strips debug |
| `error` | `{ message }` |

This shape is documented to prevent the Workspace implementation from being mistaken for a Service Key API.
External integrators use synchronous Ask in v1. Any future public stream requires a separately versioned contract.

## Idempotency & pagination (v1 decisions)

| Topic | v1 decision |
|-------|-------------|
| Idempotency-Key | **Not supported** on Retrieve/Ask. Reserved for future Documents/Jobs writes. |
| Pagination | **Not supported**. Retrieve uses `top_k` only (1–50). No cursor/`page_token`. |
| Answer alias paths | `/api/v1/answer` and `/answer/stream` are not part of this contract or the current product target. |

## Non-goals (explicitly out of v1)

- OpenAI-compatible adapter (not a current product target)
- External Documents / Versions / Jobs HTTP API
- Public streaming Ask path
- Client-supplied algorithm knobs (`ask_overrides`, hybrid/rerank/top_k policy internals)
- OAuth-for-apps / cross-workspace keys
- Exposing DBOS workers, PostgreSQL, Qdrant, or Provider credentials publicly
- Returning `retrieval_debug` or full chunk bodies on the public surface

## Compatibility checklist for adapters

1. Call only `/api/v1/retrieve` and `/api/v1/ask` with Service Key.
2. Treat success key sets and `ErrorCode` enum as closed for the major.
3. Read `api_version` / `X-UnoRAG-Api-Version`; reject unexpected majors.
4. Handle `refused` + empty `citations` as a normal business outcome, not a transport error.
5. Do not depend on undocumented internal runtime fields.
