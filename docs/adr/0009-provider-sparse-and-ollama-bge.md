# ADR-0009: Provider-native neural sparse (`sparse_v1`) + Ollama `bge-m3` dense-only mode

- Status: Accepted (supersedes [ADR-0008](./0008-qdrant-server-side-sparse-rrf.md))
- Date: 2026-11-28
- Scope: embedding protocol, neural sparse indexing (`sparse_v1`), Qdrant collection contract, Qwen3.7 defaults, and private Ollama `bge-m3` deployment
- Preserves: ADR-0005 runtime ownership, PostgreSQL authority, mandatory double-layer authorization filters, and staging/active generation lifecycle

## Context

ADR-0008 replaced application-layer BM25 scrolling with Qdrant server-side sparse + RRF using a hand-written UTF-8 FNV-1a tokenizer/hash encoder (`lexical_v1` with Qdrant `modifier: "idf"`). While scalable, hand-written hash sparse encoding suffers from:

1. Vocabulary collisions across 32-bit FNV-1a buckets and no semantic/morphological weighting (all terms rely solely on character/bigram TF + collection-level IDF).
2. Extra maintenance surface (`sparse-vector.ts`, `scripts/qdrant-backfill-sparse.ts`) duplicating lexical weighting logic that modern embedding models now emit natively.
3. Cloud providers such as Alibaba Cloud DashScope (`qwen3.7-text-embedding`) now return **both** MRL dense embeddings (1024d) and learned SPLADE-style neural sparse embeddings in a **single** native HTTP call at zero additional sparse API cost, with explicit asymmetric `text_type: "document" | "query"` support.
4. At the same time, private air-gapped deployments commonly run **Ollama + `bge-m3`** (1024d), whose `/v1/embeddings` endpoint returns dense vectors only and rejects or mishandles the MRL `dimensions` request parameter.

## Decision

1. **Remove hand-written `lexical_v1` sparse encoding completely**:
   - Delete `src/core/retrieval/hybrid/sparse-vector.ts`, `scripts/qdrant-backfill-sparse.ts`, and their tests.
   - UnoRAG no longer synthesizes hash-based sparse vectors in application code.
2. **Cloud default: Alibaba Cloud DashScope Qwen3.7 stack**:
   - `EMBEDDING_MODEL=qwen3.7-text-embedding` (`EMBEDDING_DIM=1024`): auto-selects `DashScopeNativeEmbeddingProvider` (`EMBEDDING_PROTOCOL=auto` -> `dashscope_native`), calling `${origin}/api/v1/services/embeddings/text-embedding/text-embedding` with `parameters: { dimension: 1024, output_type: "dense&sparse", text_type: "document" | "query" }`. Both dense and neural sparse vectors are produced in one request (`text_type: "document"` during ingest, `text_type: "query"` during retrieval).
   - `CHAT_MODEL=qwen3.7-flash` and `JUDGE_MODEL` (inheriting `CHAT_MODEL`): disables DashScope hybrid thinking by default (`enable_thinking: false` injected only for DashScope hosts, configurable via `AI_ENABLE_THINKING` / `JUDGE_ENABLE_THINKING`; never sent to non-DashScope endpoints) so latency, token usage, and `json_schema` structured outputs remain deterministic.
   - `RERANK_MODEL=qwen3.7-text-rerank` via existing DashScope `/compatible-api/v1/reranks`.
3. **Qdrant neural sparse contract (`sparse_v1`, `modifier: "none"`)**:
   - Because provider neural sparse weights already encode learned term salience (SPLADE-style), Qdrant must **not** apply collection-level IDF a second time.
   - When the configured embedding provider emits sparse vectors (`supportsSparse === true`), new Qdrant collections configure named `dense` + `sparse_v1: { modifier: "none" }`.
   - Startup and readiness probes fail closed if `sparse_v1` is missing, if a collection only has legacy `lexical_v1`, or if `sparse_v1` is configured with `modifier: "idf"`.
   - Using a distinct vector name (`sparse_v1` instead of `lexical_v1`) makes it impossible to silently mix legacy FNV-1a hash indices with neural vocabulary indices.
4. **Private recommended mode: Ollama + `bge-m3` (pure Dense)**:
   - When the embedding provider does not emit sparse vectors (`supportsSparse === false`, e.g., Ollama `bge-m3`, vLLM dense-only, OpenAI `text-embedding-3-*`, Zhipu `embedding-3`), `QdrantCollectionManager` and health probes expect and create a **dense-only** collection (`vectors.dense` without `sparse_vectors`).
   - `OpenAICompatibleEmbeddingProvider` automatically omits the `dimensions` request parameter (`EMBEDDING_SEND_DIMENSIONS=auto`) for Ollama endpoints (`:11434` / `ollama`) and fixed-dimension local models (`bge-*`, `nomic-embed*`, `mxbai-embed*`, etc.), while still strictly validating returned vector length against `EMBEDDING_DIM`.
   - Retrieval cleanly executes authorized dense search (`usedHybrid: false`, `hybridFailed: false`, `retrievalMode: "dense"`) without error or fallback warning.

## Compatibility and migration

- Existing ADR-0008 collections using `lexical_v1 (modifier: "idf")` cannot be mutated in place to `sparse_v1` and will fail closed on startup/readiness when targeting `qwen3.7-text-embedding`.
- To migrate an existing deployment to Qwen3.7 `dense&sparse` (or to Ollama `bge-m3`), set `QDRANT_COLLECTION` to a fresh collection name (or wipe test/staging collections and recreate) and reindex active documents so dense and sparse vector spaces stay 100% consistent.
- Operators who want DashScope `qwen3.7-text-embedding` in dense-only OpenAI-compatible mode can explicitly set `EMBEDDING_PROTOCOL=openai_compatible`.

## Security and isolation gates (unchanged)

- Every dense prefetch, `sparse_v1` prefetch, and outer fused RRF query carries the complete mandatory authorization filter (`tenant_id`, `workspace_id`, `library_id`, `doc_id`, `activeGenerationIds`, `lifecycle_visibility`, and principal/group ACL).
- Every returned hit is re-verified by `assertAuthorizedHits` before ranking, reranking, caching, or citation mapping.
- Non-DashScope endpoints never receive DashScope-specific `enable_thinking` or native embedding paths; private air-gapped Ollama deployments keep 100% of inference and local LiteParse/Tesseract OCR traffic inside the customer boundary.
