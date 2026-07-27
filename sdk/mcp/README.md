# MeriKnow MCP Server (v0.1.0)

Thin **stdio MCP** adapter for the frozen Knowledge Retrieve/Ask **public API v1**.
Tools map 1:1 onto the HTTP surface (via the [`meriknow`](../python/) Python SDK):

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

From this monorepo:

```bash
cd sdk/mcp
pip install -e ".[dev]"
# or: uv pip install -e ".[dev]"
```

This pulls in the local `meriknow` SDK (`sdk/python`) via a path dependency.

## Environment

Same as the Python SDK (server-side only — never commit keys):

```bash
export MERIKNOW_BASE_URL="http://localhost:3000"   # edge / Next.js origin
export MERIKNOW_SERVICE_KEY="mk_svc_…"             # scopes: retrieve, ask
```

Every request sends `Authorization: Bearer mk_svc_…`, `X-MeriKnow-Api-Version: 1`,
and `Content-Type: application/json`.

## Run (stdio)

```bash
cd sdk/mcp
meriknow-mcp
# or: python -m meriknow_mcp
```

Host applications (Cursor / Claude Desktop) spawn this process and speak MCP over stdin/stdout.

## Cursor `mcp.json` example

Project or user MCP config:

```json
{
  "mcpServers": {
    "meriknow": {
      "command": "meriknow-mcp",
      "env": {
        "MERIKNOW_BASE_URL": "http://localhost:3000",
        "MERIKNOW_SERVICE_KEY": "mk_svc_…"
      }
    }
  }
}
```

If the script is not on `PATH`, use an absolute interpreter + module:

```json
{
  "mcpServers": {
    "meriknow": {
      "command": "/path/to/venv/bin/python",
      "args": ["-m", "meriknow_mcp"],
      "cwd": "/path/to/MeriKnow/sdk/mcp",
      "env": {
        "MERIKNOW_BASE_URL": "http://localhost:3000",
        "MERIKNOW_SERVICE_KEY": "mk_svc_…"
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
| `filters` | no | only `record_type`, `doc_id`, `table_id`, `document_version_id` |

Success body matches public v1 (`api_version`, `trace_id`, `citations`, `refused`, …).
`refused=true` with empty citations is a **normal** outcome (not a tool error).

### `ask`

| Param | Required | Notes |
|-------|----------|--------|
| `question` | yes | 1–4000 chars |
| `library_id` | yes | 1–128 chars |
| `session_id` | no | customer-opaque ≤256; no Workspace archive thread |

## Errors

API / transport failures become MCP tool errors (`isError`) whose text is a JSON
envelope with a stable `error.code` when available, e.g.:

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

## Tests

```bash
cd sdk/mcp
pytest
```

Tests mock the `meriknow` client — no live MeriKnow server required.

## Out of scope (0.1.0)

- OpenAI-compatible HTTP API (next roadmap item)
- Documents / Versions / Jobs tools
- Public streaming Ask
- High-impact write / ACL / membership actions
