# Public API v1 — curl examples

Prerequisites: running UnoRAG web + API, a workspace Service Key with scopes
`retrieve` and `ask`, and a `library_id` that the key may access.

```bash
export APP="http://localhost:3000"   # or your edge URL
export KEY="mk_svc_…"                # paste once; never commit
export LIB="<rag_library_id>"
```

## Retrieve

```bash
curl -sS -X POST "$APP/api/v1/retrieve" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d "{\"query\":\"病假证明几天内补交？\",\"library_id\":\"$LIB\",\"top_k\":6}"
```

Expected success shape (fields may vary; keys are stable):

```json
{
  "api_version": "v1",
  "trace_id": "11111111-1111-4111-8111-111111111111",
  "query": "病假证明几天内补交？",
  "library_id": "<rag_library_id>",
  "citations": [
    {
      "id": "…",
      "index": 1,
      "title": "…",
      "snippet": "…",
      "score": 0.91,
      "document_id": "…",
      "filename": "policy.md",
      "page": null,
      "page_start": null,
      "page_end": null,
      "section_path": null,
      "table_id": null,
      "row_start": null,
      "row_end": null,
      "record_type": "chunk"
    }
  ],
  "refused": false,
  "refuse_reason": null,
  "retrieval_mode": "dense"
}
```

Headers always include `X-Request-Id` (equals `trace_id`) and
`X-UnoRAG-Api-Version: 1`.

## Ask

```bash
curl -sS -X POST "$APP/api/v1/ask" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"question\":\"病假证明几天内补交？\",\"library_id\":\"$LIB\",\"session_id\":\"demo-1\"}"
```

Expected success shape:

```json
{
  "api_version": "v1",
  "trace_id": "22222222-2222-4222-8222-222222222222",
  "session_id": "demo-1",
  "question": "病假证明几天内补交？",
  "answer": "……",
  "citations": [],
  "refused": false,
  "refuse_reason": null,
  "retrieval_mode": "dense"
}
```

## Error example (missing scope / bad input)

```bash
curl -sS -X POST "$APP/api/v1/ask" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"question\":\"q\",\"library_id\":\"$LIB\",\"ask_overrides\":{\"retrieve_top_k\":50}}"
```

```json
{
  "error": {
    "code": "invalid_request",
    "message": "request contains unsupported fields",
    "request_id": "…",
    "retryable": false,
    "details": { "fields": ["ask_overrides"] }
  }
}
```

Canonical contract: [`docs/contracts/retrieve-ask-v1.md`](../../docs/contracts/retrieve-ask-v1.md)
OpenAPI: `GET $APP/api/v1/openapi.json`
Python SDK (same calls, typed): [`sdk/python/`](../../sdk/python/)
MCP Server (stdio tools `retrieve` / `ask`): [`sdk/mcp/`](../../sdk/mcp/)
