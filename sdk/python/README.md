"""UnoRAG Python SDK (v0.1.0)

Thin HTTP adapter for the frozen Knowledge Retrieve/Ask **public API v1**.
This package does **not** embed RAG, embeddings, MinerU, or Qdrant — it only
calls the gateway:

- `POST /api/v1/retrieve`
- `POST /api/v1/ask`

Contract authority:

- [`docs/contracts/retrieve-ask-v1.md`](../../docs/contracts/retrieve-ask-v1.md)
- [`contracts/public-api-v1.openapi.json`](../../contracts/public-api-v1.openapi.json)
- curl examples: [`examples/public-api-v1/`](../../examples/public-api-v1/)

## Install

From this monorepo (editable):

```bash
cd sdk/python
pip install -e ".[dev]"
# or: uv pip install -e ".[dev]"
```

## Environment

```bash
export UNORAG_BASE_URL="http://localhost:3000"   # edge / Next.js origin
export UNORAG_SERVICE_KEY="mk_svc_…"             # server-side only; never commit
```

You may also pass `base_url=` / `service_key=` to the constructor.

## Quick start (matches curl examples)

```python
from unorag import UnoRAG, UnoRAGAPIError

with UnoRAG() as client:
    evidence = client.retrieve(
        query="病假证明几天内补交？",
        library_id="lib_xxx",
        top_k=6,
    )
    print(evidence.refused, evidence.citations)

    answer = client.ask(
        question="病假证明几天内补交？",
        library_id="lib_xxx",
        session_id="demo-1",
    )
    print(answer.answer, answer.trace_id)
```

Every request sends:

- `Authorization: Bearer mk_svc_…`
- `X-UnoRAG-Api-Version: 1`
- `Content-Type: application/json`

`refused=True` with empty citations is a **normal business outcome**, not a
transport error. Stable API errors raise `UnoRAGAPIError` with
`code` / `request_id` / `retryable` / `details`.

```python
try:
    client.ask(question="…", library_id="…")
except UnoRAGAPIError as exc:
    print(exc.code, exc.retryable, exc.request_id)
```

## API surface

| Symbol | Role |
|--------|------|
| `UnoRAG` / `UnoRAGClient` | Sync client |
| `retrieve(...)` | Evidence only |
| `ask(...)` | Grounded answer |
| `RetrieveResponse` / `AskResponse` / `Citation` | Frozen success fields |
| `ErrorCode` / `UnoRAGAPIError` | Stable error codes |

Out of scope for 0.1.0: async client, SSE streaming, OpenAI-compatible layer.
MCP (stdio tools over this SDK): [`../mcp/`](../mcp/).

## Tests

```bash
cd sdk/python
pytest
```

Tests use `httpx.MockTransport` — no live server required.
