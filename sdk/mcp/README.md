# UnoRAG MCP Server (v0.1.0)

Thin **stdio MCP** adapter for the frozen Knowledge Retrieve/Ask **public API v1**.
Tools map 1:1 onto the HTTP surface (via the [`unorag`](../python/) Python SDK):

| MCP tool | HTTP |
|----------|------|
| `retrieve` | `POST /api/v1/retrieve` |
| `ask` | `POST /api/v1/ask` |

This package does **not** embed RAG, embeddings, MinerU, or Qdrant.

Contract authority:

- [`docs/contracts/retrieve-ask-v1.md`](../../docs/contracts/retrieve-ask-v1.md)
- [`contracts/public-api-v1.openapi.json`](../../contracts/public-api-v1.openapi.json)
- curl examples: [`examples/public-api-v1/`](../../examples/public-api-v1/)

## Install

**Monorepo-only path dependency.** `pyproject.toml` pins
`unorag @ file:../python`, so this package is not a stand-alone PyPI install
from this directory alone. Install the Python SDK first (or use editable
install from the monorepo checkout):

```bash
# From UnoRAG repo root — install SDK, then MCP adapter
cd sdk/python && pip install -e ".[dev]"
cd ../mcp && pip install -e ".[dev]"
# or: uv pip install -e ".[dev]" in each directory
```

Editable installs from `sdk/mcp` resolve `file:../python` relative to this
package; cloning only `sdk/mcp` without `sdk/python` will fail.

## Environment

Same as the Python SDK (server-side only — never commit keys):

```bash
export UNORAG_BASE_URL="http://localhost:3000"   # edge / Next.js origin
export UNORAG_SERVICE_KEY="mk_svc_…"             # scopes: retrieve, ask
```

Every request sends `Authorization: Bearer mk_svc_…`, `X-UnoRAG-Api-Version: 1`,
and `Content-Type: application/json`.

Missing `UNORAG_BASE_URL` / `UNORAG_SERVICE_KEY` (or an invalid key prefix)
surfaces as a tool error with MCP-local code `client_error` (see Errors).

## Run (stdio)

```bash
cd sdk/mcp
unorag-mcp
# or: python -m unorag_mcp
```

Host applications (Cursor / Claude Desktop) spawn this process and speak MCP over stdin/stdout.

## Cursor `mcp.json` example

Project or user MCP config:

```json
{
  "mcpServers": {
    "unorag": {
      "command": "unorag-mcp",
      "env": {
        "UNORAG_BASE_URL": "http://localhost:3000",
        "UNORAG_SERVICE_KEY": "mk_svc_…"
      }
    }
  }
}
```

If the script is not on `PATH`, use an absolute interpreter + module:

```json
{
  "mcpServers": {
    "unorag": {
      "command": "/path/to/venv/bin/python",
      "args": ["-m", "unorag_mcp"],
      "cwd": "/path/to/UnoRAG/sdk/mcp",
      "env": {
        "UNORAG_BASE_URL": "http://localhost:3000",
        "UNORAG_SERVICE_KEY": "mk_svc_…"
      }
    }
  }
}
```

Claude Desktop uses the same shape under `mcpServers` in its config file.

## Tools

### `retrieve`

| Param | Required | Notes |
|-------|----------|--------|
| `query` | yes | 1–4000 chars |
| `library_id` | yes | 1–128 chars |
| `top_k` | no | 1–50 |
| `filters` | no | only `record_type`, `doc_id`, `table_id`, `document_version_id`; unknown keys → `invalid_request` |

Success body matches public v1 (`api_version`, `trace_id`, `citations`, `refused`, …).
`refused=true` with empty citations is a **normal** outcome (not a tool error).

### `ask`

| Param | Required | Notes |
|-------|----------|--------|
| `question` | yes | 1–4000 chars |
| `library_id` | yes | 1–128 chars |
| `session_id` | no | customer-opaque ≤256; no Workspace archive thread |

## Errors

API / transport / client failures become MCP tool errors (`isError`) whose text
is a JSON envelope:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "…",
    "request_id": "…",
    "retryable": false,
    "details": {}
  }
}
```

### HTTP v1 codes (pass-through)

When the SDK raises `UnoRAGAPIError`, `error.code` is the public v1 code from
the closed HTTP table (`invalid_request`, `authentication_required`,
`rate_limit_exceeded`, …). See
[`docs/contracts/retrieve-ask-v1.md`](../../docs/contracts/retrieve-ask-v1.md).

### MCP-local extension codes

These codes are **MCP adapter extensions** — they are **not** part of the closed
HTTP v1 `error.code` table:

| Code | When |
|------|------|
| `transport_error` | Network / transport failure before a UnoRAG error envelope (`UnoRAGTransportError`) |
| `unexpected_api_version` | Response advertised an unexpected API major version (`UnoRAGVersionError`) |
| `client_error` | Local SDK / config errors (e.g. missing `UNORAG_BASE_URL` / `UNORAG_SERVICE_KEY`) |
| `internal_error` | Non-`UnoRAGError` unexpected exceptions |

## Tests

```bash
cd sdk/mcp
pytest
```

Tests mock the `unorag` client — no live UnoRAG server required.

## Out of scope (0.1.0)

- OpenAI-compatible HTTP API (planned after the public lifecycle API)
- Documents / Versions / Jobs tools
- Public streaming Ask
- High-impact write / ACL / membership actions
