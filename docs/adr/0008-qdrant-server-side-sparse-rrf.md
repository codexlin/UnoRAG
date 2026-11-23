# ADR-0008: Qdrant server-side Sparse + RRF

- Status: Accepted (sole hybrid retrieval path; application-layer BM25 fallback removed)
- Date: 2026-11-15 (accepted 2026-11-23 after IDF & FinanceComplexQA / live release-gate verification)
- Scope: lexical projection, collection contract and authorized hybrid retrieval
- Preserves: ADR-0005 runtime ownership, PostgreSQL authority and staging/active lifecycle

## Context

The earlier application-layer BM25 path scrolled an authorized corpus into Node.js memory
with a hard bound (10,000 records by default). It was a small/medium corpus fallback, not a
scalable lexical index. Sparse retrieval must keep the same authorization and citation contracts
without introducing another external model API, while matching or exceeding application BM25
relevance on real complex documents.

## Decision

1. Every new Qdrant collection is created with named `dense` (configured dimensions/distance)
   and sparse `lexical_v1` vectors configured with Qdrant's built-in `modifier: "idf"`.
   Existing collections are inspected at startup and never automatically recreated or mutated.
   `TS_RETRIEVAL_HYBRID_ENABLED` and request policy control whether a query runs hybrid or dense-only.
2. `lexical_v1` reuses the existing lowercase English/number/underscore and Chinese
   character/bigram tokenizer. FNV-1a over UTF-8 maps terms to uint32 dimensions;
   collisions merge counts deterministically. Sorted unique indices carry positive
   `1 + ln(tf)` weights, and Qdrant applies collection-level IDF (`modifier: "idf"`)
   at query time without any external sparse-embedding API cost. Because UnoRAG's
   deployment model is one isolated instance per customer enterprise (`docs/ARCHITECTURE.md`),
   collection-level IDF statistics within that enterprise instance are an explicit
   trade-off for lexical relevance parity with BM25 while document content and hits
   remain strictly isolated by mandatory ACL filters and `assertAuthorizedHits`.
   Hash collisions can still occur; encoder or modifier changes require recreating
   the collection or introducing a new sparse vector name.
3. Ingest writes dense and sparse vectors together in each staging point, using
   `embed_text` (including eligible contextual prefix; document identity stays bounded).
   Existing manifest, scope, ACL projection, activation and cleanup rules remain intact.
4. Query API `prefetch` runs dense and sparse queries and fuses on the server with
   RRF (`query.rrf.k` preserves the configured RRF_K, default 60; Qdrant 1.19 is the
   deployment/test baseline). Each prefetch limit covers the final candidate cap.
   An authorized dense query is retained to supply original semantic scores:
   RRF rank scores are never semantic evidence confidence, and sparse-only candidates
   have `dense_score=null` unless subsequently reranked.
   Public `usedHybrid`, `retrievalMode`, citation (nullable `bm25_score`) and SSE contracts
   remain unchanged.
5. The legacy 10,000-record application-layer `Bm25Index` scroll fallback and
   `QDRANT_SERVER_HYBRID_ENABLED` / `TS_RETRIEVAL_CORPUS_LIMIT` switches are removed.
   Tokenless queries or transient Qdrant hybrid query errors fall back safely to the
   authorized dense result set rather than scrolling the corpus.

## Compatibility and migration

The collection manager accepts named `dense` collections (and operator-backfilled unnamed
dense collections) when `sparse_vectors.lexical_v1` is configured with `modifier: "idf"`,
and validates size, distance and payload indexes. Collections missing `lexical_v1` or using
a non-IDF modifier fail closed with `QdrantCollectionContractError`.

No automatic in-place sparse index enablement, rename, dual collection reads or
backfill occurs. Operators migrating a pre-ADR-0008 dense-only collection drain jobs,
snapshot the old collection and run `pnpm exec tsx scripts/qdrant-backfill-sparse.ts --execute` from
a matching source checkout with its dependencies installed and access to Qdrant. The tool copies
all point IDs, payloads, dense vectors and freshly computed `lexical_v1` vectors into a
new IDF-enabled collection (`$0` external API cost). Validate point counts and scope coverage,
then switch `QDRANT_COLLECTION` for Web and Worker together before restarting.

## Security and isolation gates

**Every dense and sparse prefetch must carry the complete mandatory filter**, as
must the outer fused query: `tenant_id`, `workspace_id`, `library_id`, allowed
`documentIds`, `activeGenerationIds`, lifecycle visibility and principal/group ACL.
User filters only narrow that scope. Empty allow-lists match nothing. PostgreSQL
remains the source of live documents and active generations; deleted documents are
removed from its authoritative scope even before stale Qdrant points are cleaned.

**Every returned hit is checked again by `assertAuthorizedHits`** before ranking,
reranking, caching or citation mapping. Tenant/workspace/library, document, generation,
ACL and lifecycle violations abort the entire retrieval; a security violation must never
be caught as a recoverable hybrid failure. No scope is widened for sparse, fusion, retry
or fallback.

Real Qdrant integration tests cover lexical recall, IDF rare-term ranking, both prefetch
results and fused results against adversarial tenant/workspace/library/document,
missing/restricted ACL, group ACL, staging/inactive generation and deletion-residue points,
empty allow-lists, physical deletion, and fail-closed rejection of collections missing
`lexical_v1` or `modifier: "idf"`. Unit tests also inject malicious store results to verify
the second authorization boundary.

## Verification and consequences

Verified against real Qdrant `v1.19.0`:
- Standard live release gate (`pnpm eval:live`): **36/36** positive PASS, **1.000** fact
  coverage, **1.000 / 1.000** Recall@K / MRR, **100.0%** citation precision, **6/6** refusal PASS.
- FinanceComplexQA (118 positive + 17 refusal, semantic judge): compared to application BM25,
  Qdrant `lexical_v1 (modifier: "idf")` improved numeric hit rate (`58.2%` vs `57.7%`), term hit
  rate (`34.2%` vs `34.0%`), combined fact hit (`43.2%` vs `42.6%`), and answered semantic
  accuracy (`74.5%` vs `73.8%`), while keeping `17/17` (`100%`) refusal accuracy and eliminating
  the `-3.0pp` semantic drop observed without IDF as well as the 10,000-record corpus ceiling.

No changes to ADR-0003 chunking or ADR-0005 ownership are required.

## v0.4.0 默认开启策略

- v0.4.0 默认开启 Hybrid。新部署省略 `TS_RETRIEVAL_HYBRID_ENABLED` 时使用 `true`；
  可设为 `false` 在部署级关闭，工作区也可独立关闭混合检索。

- [Qdrant hybrid queries](https://qdrant.tech/documentation/search/hybrid-queries/)
- [Qdrant vectors](https://qdrant.tech/documentation/concepts/vectors/)
