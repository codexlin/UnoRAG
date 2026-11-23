import "server-only";

import { QdrantClient } from "@qdrant/js-client-rest";

import {
	modelProviderOverrideFromEnv,
	rerankProviderFromEnv,
} from "@/core/ai/model-environment";

import {
	DefaultRetrievalService,
	OpenAICompatibleEmbeddingProvider,
	OpenAICompatibleRerankProvider,
	QdrantRetrievalStore,
	ScopedRetrievalCache,
} from "@/core/retrieval";
import {
	parseQdrantDistance,
	QdrantCollectionManager,
} from "@/core/retrieval/qdrant/collection-manager";

function required(name: string, fallback?: string): string {
	const value = process.env[name]?.trim() || fallback?.trim();
	if (!value) throw new Error(`${name} is required for TypeScript retrieval`);
	return value;
}

function positiveInteger(name: string, fallback: number): number {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

function nonNegativeInteger(name: string, fallback: number): number {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative integer`);
	}
	return value;
}

function enabled(name: string, fallback = false): boolean {
	const value = process.env[name]?.trim().toLowerCase();
	if (value === undefined || value === "") return fallback;
	return value === "1" || value === "true" || value === "yes";
}

let runtime: DefaultRetrievalService | undefined;

export function getTypeScriptRetrievalService(): DefaultRetrievalService {
	if (runtime) return runtime;
	const embeddingProvider = modelProviderOverrideFromEnv("EMBEDDING");
	const rerankProvider = rerankProviderFromEnv();
	const qdrantTimeoutMs = positiveInteger("QDRANT_TIMEOUT_MS", 5_000);
	const qdrant = new QdrantClient({
		url: required("QDRANT_URL", "http://localhost:6333"),
		apiKey: process.env.QDRANT_API_KEY?.trim() || undefined,
		timeout: qdrantTimeoutMs,
		checkCompatibility: true,
	});
	const collection = required("QDRANT_COLLECTION", "unorag_chunks");
	const dimensions = positiveInteger("EMBEDDING_DIM", 1_024);
	const collectionReady = new QdrantCollectionManager(qdrant, {
		collection,
		vectorSize: dimensions,
		distance: parseQdrantDistance(process.env.QDRANT_DISTANCE),
	}).ensure();
	const vectorSchema = collectionReady.then((result) => result.vectorSchema);
	// Observe the chained rejection until the store can await the contract.
	void vectorSchema.catch(() => undefined);
	const embeddings = new OpenAICompatibleEmbeddingProvider({
		...embeddingProvider,
		model: required("EMBEDDING_MODEL", "text-embedding-v3"),
		dimensions,
		batchSize: positiveInteger("EMBEDDING_BATCH_SIZE", 10),
		timeoutMs: positiveInteger("EMBEDDING_TIMEOUT_MS", 15_000),
	});
	const rerankEnabled = enabled("TS_RETRIEVAL_RERANK_ENABLED");
	const hybridEnabled = enabled("TS_RETRIEVAL_HYBRID_ENABLED", true);
	const reranker = rerankProvider
		? new OpenAICompatibleRerankProvider({
				...rerankProvider,
				model: required("RERANK_MODEL", "qwen3-rerank"),
				timeoutMs: positiveInteger("RERANK_TIMEOUT_MS", 10_000),
			})
		: null;
	runtime = new DefaultRetrievalService(
		embeddings,
		new QdrantRetrievalStore(qdrant, collection, collectionReady, {
			timeoutMs: qdrantTimeoutMs,
			vectorSchema,
		}),
		reranker,
		{
			hybridEnabled,
			hybridAllowed: hybridEnabled,
			rerankEnabled,
			rerankTopK: positiveInteger("RERANK_TOP_K", 6),
			bm25TopK: positiveInteger("BM25_TOP_K", 20),
			rrfK: positiveInteger("RRF_K", 60),
			cache: new ScopedRetrievalCache({
				ttlMs: nonNegativeInteger("RETRIEVAL_CACHE_TTL_MS", 30_000),
				maxEntries: positiveInteger("RETRIEVAL_CACHE_MAX_ENTRIES", 256),
			}),
		},
	);
	return runtime;
}

export function resetTypeScriptRetrievalServiceForTests(): void {
	runtime = undefined;
}
