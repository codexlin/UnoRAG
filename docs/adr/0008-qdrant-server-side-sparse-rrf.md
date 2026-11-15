# ADR-0008: Qdrant server-side Sparse + RRF

- Status: Proposed (implementation and isolation gates supplied for review; opt-in)
- Date: 2026-11-15
- Scope: lexical projection, collection compatibility and authorized hybrid retrieval
- Preserves: ADR-0005 runtime ownership, PostgreSQL authority and staging/active lifecycle

## Context

The application BM25 path scrolls an authorized corpus with a configured bound (10,000 records by default).
It is a small/medium corpus fallback, not a scalable lexical index. Sparse retrieval
must keep the same authorization and citation contracts without another external model.

## Decision

1. `QDRANT_SERVER_HYBRID_ENABLED=true` creates **new** collections with named
   `dense` (configured dimensions/distance) and sparse `lexical_v1` vectors.
   Existing collections are inspected and never automatically recreated or changed.
   `TS_RETRIEVAL_HYBRID_ENABLED`/request policy still controls whether retrieval is hybrid.
2. `lexical_v1` reuses the existing lowercase English/number/underscore and Chinese
   character/bigram tokenizer. FNV-1a over UTF-8 maps terms to uint32 dimensions;
   collisions merge counts deterministically. Sorted unique indices have positive
   `1 + ln(tf)` weights on both documents and queries. No model or corpus IDF is
   used, so weights are stable and do not incorporate unauthorized corpus statistics.
   Hash collisions can hurt relevance; this is lexical TF retrieval, not exact BM25
   equivalence or a collision-free dictionary. Encoder changes require a new vector name.
3. Ingest writes dense and sparse vectors together in each staging point, using
   `embed_text` (including eligible contextual prefix; document identity stays bounded).
   Existing manifest, scope, ACL projection, activation and cleanup rules remain intact.
   Sparse writes continue when the query switch is off on a capable collection, so
   rollback does not leave new generations without lexical vectors.
4. Query API `prefetch` runs dense and sparse queries and fuses on the server with
   RRF (`query.rrf.k` preserves the configured RRF_K, default 60; Qdrant 1.19 is the
   deployment/test baseline). Each prefetch limit covers the final candidate cap.
   An authorized dense query is retained to supply original semantic scores:
   RRF rank scores are never semantic evidence confidence, and sparse-only candidates
   have `dense_score=null` unless subsequently reranked. This adds a dense request.
   Public `usedHybrid`, `retrievalMode`, citation and SSE contracts remain unchanged.

## Compatibility, migration and rollback

The collection manager detects unnamed dense and named `dense` schemas and validates
size, distance and payload indexes. Only the versioned `lexical_v1` sparse field with
no IDF modifier is supported. Missing sparse configuration means safe bounded BM25
fallback; an unknown dense schema or incompatible contract fails closed. Query or
transport failures retain the existing dense fallback and diagnostic contract; they
are not misreported as a legacy sparse capability decision. Tokenless queries also
use the fallback. A process captures schema at startup; restart after migration.

No automatic in-place sparse index enablement, rename, dual collection reads or
backfill occurs. Merely adding a sparse field would leave old points incomplete.
For migration, drain jobs, snapshot the old collection, create a new opted-in
collection, copy all required point IDs/payloads and dense vectors, and generate
`lexical_v1` from the same indexed text for **every** point. Validate point sets,
counts, authorization payload and active-generation coverage before switching
`QDRANT_COLLECTION` for Web and Worker together and restarting. Ordinary reindexing
must preserve the PostgreSQL staging/validation/activation flow. Migration execution
and its customer-scale acceptance are separate operator work, not this implementation.

Set the server switch false on both processes to return to authorized bounded BM25
without changing the named dense schema; retain the previous collection/snapshot for
an operator-coordinated rollback. Do not switch back to a stale collection after new
lifecycle writes without reconciling its projections. Legacy unnamed dense collections
can also carry the supported sparse field after a complete operator backfill; writes
use the empty dense-vector name in Qdrant's vector map for that schema.

## Security and isolation gates

**Every dense and sparse prefetch must carry the complete mandatory filter**, as
must the outer fused query: `tenant_id`, `workspace_id`, `library_id`, allowed
`documentIds`, `activeGenerationIds`, lifecycle visibility and principal/group ACL.
User filters only narrow that scope. Empty allow-lists match nothing. PostgreSQL
remains the source of live documents and active generations; deleted documents are
removed from its authoritative scope even before stale Qdrant points are cleaned.

**Every returned hit is checked again by `assertAuthorizedHits`** before ranking,
reranking, caching or citation mapping. Tenant/workspace/library, document, generation,
ACL and lifecycle violations abort the entire retrieval, including the legacy BM25
branch; a security violation must never be caught as a recoverable hybrid failure.
No scope is widened for sparse, fusion, retry or fallback.

Real Qdrant integration tests cover lexical recall, both prefetch results and fused
results against adversarial tenant/workspace/library/document, missing/restricted ACL,
group ACL, staging/inactive generation and deletion-residue points, empty allow-lists,
physical deletion, and legacy collections without sparse configuration. Unit tests
also inject malicious store results to verify the second authorization boundary.
These gates prove fixture isolation, not customer-scale relevance/capacity or a release.

## Consequences and references

Server hybrid avoids the corpus scroll on capable collections. The explicit default-off
switch preserves existing installations; legacy fallback retains its capacity limit.
Production enablement still needs ADR review and customer corpus quality/capacity gates.
No changes to ADR-0003 chunking or ADR-0005 ownership are required.

- [Qdrant hybrid queries](https://qdrant.tech/documentation/search/hybrid-queries/)
- [Qdrant vectors](https://qdrant.tech/documentation/concepts/vectors/)
