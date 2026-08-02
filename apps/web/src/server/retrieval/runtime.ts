import "server-only";

import { QdrantClient } from "@qdrant/js-client-rest";

import {
	DefaultRetrievalService,
	OpenAICompatibleEmbeddingProvider,
	OpenAICompatibleRerankProvider,
	QdrantRetrievalStore,
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

function enabled(name: string, fallback = false): boolean {
	const value = process.env[name]?.trim().toLowerCase();
	if (value === undefined || value === "") return fallback;
	return value === "1" || value === "true" || value === "yes";
}

function llmApiKey(): string {
	return (
		process.env.OPENAI_API_KEY?.trim() ||
		process.env.DASHSCOPE_API_KEY?.trim() ||
		""
	);
}

function llmBaseUrl(): string {
	return (
		process.env.OPENAI_BASE_URL?.trim() ||
		process.env.DASHSCOPE_BASE_URL?.trim() ||
		"https://dashscope.aliyuncs.com/compatible-mode/v1"
	);
}

let runtime: DefaultRetrievalService | undefined;

export function getTypeScriptRetrievalService(): DefaultRetrievalService {
	if (runtime) return runtime;
	const apiKey = llmApiKey();
	if (!apiKey) {
		throw new Error(
			"OPENAI_API_KEY or DASHSCOPE_API_KEY is required for TypeScript retrieval",
		);
	}
	const qdrant = new QdrantClient({
		url: required("QDRANT_URL", "http://localhost:6333"),
		apiKey: process.env.QDRANT_API_KEY?.trim() || undefined,
		timeout: positiveInteger("QDRANT_TIMEOUT_MS", 5_000),
		checkCompatibility: true,
	});
	const collection = required("QDRANT_COLLECTION", "unorag_chunks");
	const dimensions = positiveInteger("EMBEDDING_DIM", 1_024);
	const collectionReady = new QdrantCollectionManager(qdrant, {
		collection,
		vectorSize: dimensions,
		distance: parseQdrantDistance(process.env.QDRANT_DISTANCE),
	}).ensure();
	// The store awaits the original promise. This observer prevents an
	// unhandled rejection if Qdrant fails before the first request arrives.
	void collectionReady.catch(() => undefined);
	const embeddings = new OpenAICompatibleEmbeddingProvider({
		apiKey,
		baseUrl: llmBaseUrl(),
		model: required("EMBEDDING_MODEL", "text-embedding-v3"),
		dimensions,
		batchSize: positiveInteger("EMBEDDING_BATCH_SIZE", 10),
	});
	const rerankEnabled = enabled("TS_RETRIEVAL_RERANK_ENABLED");
	const reranker = new OpenAICompatibleRerankProvider({
		apiKey,
		baseUrl: required(
			"RERANK_BASE_URL",
			"https://dashscope.aliyuncs.com/compatible-api/v1",
		),
		model: required("RERANK_MODEL", "qwen3-rerank"),
	});
	runtime = new DefaultRetrievalService(
		embeddings,
		new QdrantRetrievalStore(qdrant, collection, collectionReady),
		reranker,
		{
			hybridEnabled: enabled("TS_RETRIEVAL_HYBRID_ENABLED"),
			rerankEnabled,
			rerankTopK: positiveInteger("RERANK_TOP_K", 6),
			bm25TopK: positiveInteger("BM25_TOP_K", 20),
			rrfK: positiveInteger("RRF_K", 60),
			corpusLimit: positiveInteger("TS_RETRIEVAL_CORPUS_LIMIT", 10_000),
		},
	);
	return runtime;
}

export function resetTypeScriptRetrievalServiceForTests(): void {
	runtime = undefined;
}
