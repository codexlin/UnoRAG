import { z } from "zod";
import {
	type EmbeddingProtocol,
	resolveEmbeddingProtocol,
	resolveEmbeddingSendDimensions,
} from "@/core/ai/model-environment";
import { withActiveSpan } from "@/lib/observability/tracing";
import { fetchRetrievalProvider } from "../provider-request";

export type SparseVector = { indices: number[]; values: number[] };

export type EmbeddingVector = {
	dense: number[];
	sparse?: SparseVector;
};

const EmbeddingResponseSchema = z
	.object({
		data: z.array(
			z
				.object({
					index: z.number().int().nonnegative(),
					embedding: z.array(z.number()),
				})
				.passthrough(),
		),
	})
	.passthrough();

const DashScopeSparseEntrySchema = z
	.object({
		index: z.number().int().nonnegative(),
		value: z.number().finite(),
	})
	.passthrough();

const DashScopeEmbeddingResponseSchema = z
	.object({
		output: z
			.object({
				embeddings: z.array(
					z
						.object({
							text_index: z.number().int().nonnegative(),
							embedding: z.array(z.number()),
							sparse_embedding: z.array(DashScopeSparseEntrySchema).optional(),
						})
						.passthrough(),
				),
			})
			.passthrough(),
	})
	.passthrough();

export interface EmbeddingProvider {
	readonly supportsSparse?: boolean;
	embedQuery(query: string, signal?: AbortSignal): Promise<number[]>;
	embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]>;
	embedQueryWithSparse?(
		query: string,
		signal?: AbortSignal,
	): Promise<EmbeddingVector>;
	embedTextsWithSparse?(
		texts: string[],
		signal?: AbortSignal,
	): Promise<EmbeddingVector[]>;
	/**
	 * Optional document-grouped chunk embedding port for contextualized chunk
	 * embedding providers (e.g. Voyage `voyage-context-3` `/contextualizedembeddings`)
	 * that encode all chunks of one document together.
	 */
	embedDocumentChunks?(
		chunks: string[],
		signal?: AbortSignal,
	): Promise<number[][]>;
}

export type OpenAICompatibleEmbeddingConfig = {
	apiKey: string;
	baseUrl: string;
	model: string;
	dimensions: number;
	batchSize?: number;
	timeoutMs?: number;
	/**
	 * Whether to include `dimensions` in the `/embeddings` request body.
	 * Defaults to `"auto"`, which omits `dimensions` for Ollama and fixed-dim
	 * local models (such as `bge-m3`) while still strictly validating returned length.
	 */
	sendDimensions?: boolean | "auto";
	fetch?: typeof globalThis.fetch;
	retryBackoffMs?: readonly number[];
};

export type DashScopeNativeEmbeddingConfig = {
	apiKey: string;
	baseUrl: string;
	model: string;
	dimensions: number;
	batchSize?: number;
	timeoutMs?: number;
	outputType?: "dense&sparse" | "dense";
	fetch?: typeof globalThis.fetch;
	retryBackoffMs?: readonly number[];
};

export type EmbeddingFactoryConfig = {
	apiKey: string;
	baseUrl: string;
	model: string;
	dimensions: number;
	protocol?: string | EmbeddingProtocol;
	sendDimensions?: string | boolean;
	batchSize?: number;
	timeoutMs?: number;
	fetch?: typeof globalThis.fetch;
	retryBackoffMs?: readonly number[];
};

function openaiEndpoint(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	return /\/embeddings$/i.test(trimmed) ? trimmed : `${trimmed}/embeddings`;
}

export function resolveDashScopeNativeEmbeddingEndpoint(
	baseUrl: string,
): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	if (
		/\/services\/embeddings\/text-embedding\/text-embedding$/i.test(trimmed)
	) {
		return trimmed;
	}
	const parsed = new URL(trimmed);
	return `${parsed.origin}/api/v1/services/embeddings/text-embedding/text-embedding`;
}

function sanitizeModelName(model: string, apiKey: string): string {
	return /^[\w./:-]{1,200}$/.test(model) &&
		!model.includes("://") &&
		!model.includes(apiKey.trim())
		? model
		: "EMBEDDING_MODEL";
}

function assertDenseVector(
	embedding: number[],
	expectedDimensions: number,
	model: string,
	apiKey: string,
): number[] {
	if (embedding.length !== expectedDimensions) {
		throw new EmbeddingDimensionMismatchError(
			expectedDimensions,
			embedding.length,
			sanitizeModelName(model, apiKey),
		);
	}
	if (embedding.some((value) => !Number.isFinite(value))) {
		throw new Error("embedding provider returned non-finite vector values");
	}
	return embedding;
}

export function normalizeProviderSparseVector(
	entries: ReadonlyArray<{ index: number; value: number }> | undefined,
): SparseVector {
	if (!entries?.length) return { indices: [], values: [] };
	const merged = new Map<number, number>();
	for (const entry of entries) {
		if (
			!Number.isInteger(entry.index) ||
			entry.index < 0 ||
			!Number.isFinite(entry.value) ||
			entry.value <= 0
		) {
			continue;
		}
		merged.set(entry.index, (merged.get(entry.index) ?? 0) + entry.value);
	}
	const indices = [...merged.keys()].sort((a, b) => a - b);
	return {
		indices,
		values: indices.map((index) => merged.get(index) ?? 0),
	};
}

export class EmbeddingDimensionMismatchError extends Error {
	readonly code = "embedding_dimension_mismatch";
	constructor(expected: number, actual: number, model: string) {
		super(
			`Embedding vector size mismatch: expected EMBEDDING_DIM=${expected}, got ${actual} from model ${model}. Choose an EMBEDDING_MODEL that returns ${expected} dimensions, or set EMBEDDING_DIM=${actual} and use a matching Qdrant collection. For a dimension change, set QDRANT_COLLECTION to a new collection and reindex.`,
		);
		this.name = "EmbeddingDimensionMismatchError";
	}
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
	readonly supportsSparse = false;
	private readonly fetch: typeof globalThis.fetch;
	private readonly batchSize: number;
	private readonly timeoutMs: number;
	private readonly sendDimensions: boolean;

	constructor(private readonly config: OpenAICompatibleEmbeddingConfig) {
		if (!config.apiKey.trim()) throw new Error("embedding API key is required");
		if (config.dimensions <= 0) {
			throw new Error("embedding dimensions must be positive");
		}
		this.fetch = config.fetch ?? globalThis.fetch;
		this.batchSize = Math.max(1, config.batchSize ?? 10);
		this.timeoutMs = config.timeoutMs ?? 15_000;
		if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
			throw new Error("embedding timeout must be a positive integer");
		}
		this.sendDimensions = resolveEmbeddingSendDimensions({
			baseUrl: config.baseUrl,
			model: config.model,
			sendDimensions: config.sendDimensions,
		});
	}

	async embedQuery(query: string, signal?: AbortSignal): Promise<number[]> {
		const [vector] = await this.embedTexts([query], signal);
		if (!vector) throw new Error("embedding provider returned no vector");
		return vector;
	}

	async embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
		signal?.throwIfAborted();
		if (!texts.length) return [];
		return withActiveSpan(
			"unorag.embedding",
			{
				"gen_ai.operation.name": "embeddings",
				"langfuse.observation.type": "embedding",
				"langfuse.observation.metadata.capture_content": false,
				"gen_ai.request.model": this.config.model,
				"unorag.embedding.input_count": texts.length,
				"unorag.embedding.dimensions": this.config.dimensions,
				"unorag.embedding.protocol": "openai_compatible",
			},
			() => this.embedTextsInSpan(texts, signal),
		);
	}

	private async embedTextsInSpan(
		texts: string[],
		signal?: AbortSignal,
	): Promise<number[][]> {
		const vectors: number[][] = [];
		for (let offset = 0; offset < texts.length; offset += this.batchSize) {
			const batch = texts.slice(offset, offset + this.batchSize);
			const body: Record<string, unknown> = {
				model: this.config.model,
				input: batch,
				...(this.sendDimensions ? { dimensions: this.config.dimensions } : {}),
			};
			const payload = await fetchRetrievalProvider({
				provider: "embedding",
				signal,
				timeoutMs: this.timeoutMs,
				retryBackoffMs: this.config.retryBackoffMs,
				parse: async (response) =>
					EmbeddingResponseSchema.parse(await response.json()),
				request: (requestSignal) =>
					this.fetch(openaiEndpoint(this.config.baseUrl), {
						method: "POST",
						headers: {
							authorization: `Bearer ${this.config.apiKey}`,
							"content-type": "application/json",
						},
						body: JSON.stringify(body),
						signal: requestSignal,
					}),
			});
			const ordered = [...payload.data].sort((a, b) => a.index - b.index);
			if (ordered.length !== batch.length) {
				throw new Error(
					"embedding provider returned an unexpected vector count",
				);
			}
			for (let index = 0; index < ordered.length; index += 1) {
				const item = ordered[index];
				if (!item || item.index !== index) {
					throw new Error("embedding provider returned invalid vector indices");
				}
				vectors.push(
					assertDenseVector(
						item.embedding,
						this.config.dimensions,
						this.config.model,
						this.config.apiKey,
					),
				);
			}
		}
		return vectors;
	}
}

export class DashScopeNativeEmbeddingProvider implements EmbeddingProvider {
	readonly supportsSparse: boolean;
	private readonly fetch: typeof globalThis.fetch;
	private readonly batchSize: number;
	private readonly timeoutMs: number;
	private readonly endpointUrl: string;
	private readonly outputType: "dense&sparse" | "dense";

	constructor(private readonly config: DashScopeNativeEmbeddingConfig) {
		if (!config.apiKey.trim()) throw new Error("embedding API key is required");
		if (config.dimensions <= 0) {
			throw new Error("embedding dimensions must be positive");
		}
		this.fetch = config.fetch ?? globalThis.fetch;
		const modelCap = /^qwen3\.7-text-embedding/i.test(config.model.trim())
			? 20
			: 10;
		this.batchSize = Math.min(modelCap, Math.max(1, config.batchSize ?? 10));
		this.timeoutMs = config.timeoutMs ?? 15_000;
		if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
			throw new Error("embedding timeout must be a positive integer");
		}
		this.endpointUrl = resolveDashScopeNativeEmbeddingEndpoint(config.baseUrl);
		this.outputType = config.outputType ?? "dense&sparse";
		this.supportsSparse = this.outputType === "dense&sparse";
	}

	async embedQuery(query: string, signal?: AbortSignal): Promise<number[]> {
		const embedded = await this.embedQueryWithSparse(query, signal);
		return embedded.dense;
	}

	async embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
		const embedded = await this.embedTextsWithSparse(texts, signal);
		return embedded.map((item) => item.dense);
	}

	async embedQueryWithSparse(
		query: string,
		signal?: AbortSignal,
	): Promise<EmbeddingVector> {
		const [vector] = await this.embedBatch([query], "query", signal);
		if (!vector) throw new Error("embedding provider returned no vector");
		return vector;
	}

	async embedTextsWithSparse(
		texts: string[],
		signal?: AbortSignal,
	): Promise<EmbeddingVector[]> {
		return this.embedBatch(texts, "document", signal);
	}

	private async embedBatch(
		texts: string[],
		textType: "document" | "query",
		signal?: AbortSignal,
	): Promise<EmbeddingVector[]> {
		signal?.throwIfAborted();
		if (!texts.length) return [];
		return withActiveSpan(
			"unorag.embedding",
			{
				"gen_ai.operation.name": "embeddings",
				"langfuse.observation.type": "embedding",
				"langfuse.observation.metadata.capture_content": false,
				"gen_ai.request.model": this.config.model,
				"unorag.embedding.input_count": texts.length,
				"unorag.embedding.dimensions": this.config.dimensions,
				"unorag.embedding.protocol": "dashscope_native",
				"unorag.embedding.output_type": this.outputType,
				"unorag.embedding.text_type": textType,
			},
			() => this.embedBatchInSpan(texts, textType, signal),
		);
	}

	private async embedBatchInSpan(
		texts: string[],
		textType: "document" | "query",
		signal?: AbortSignal,
	): Promise<EmbeddingVector[]> {
		const results: EmbeddingVector[] = [];
		for (let offset = 0; offset < texts.length; offset += this.batchSize) {
			const batch = texts.slice(offset, offset + this.batchSize);
			const payload = await fetchRetrievalProvider({
				provider: "embedding",
				signal,
				timeoutMs: this.timeoutMs,
				retryBackoffMs: this.config.retryBackoffMs,
				parse: async (response) =>
					DashScopeEmbeddingResponseSchema.parse(await response.json()),
				request: (requestSignal) =>
					this.fetch(this.endpointUrl, {
						method: "POST",
						headers: {
							authorization: `Bearer ${this.config.apiKey}`,
							"content-type": "application/json",
						},
						body: JSON.stringify({
							model: this.config.model,
							input: { texts: batch },
							parameters: {
								dimension: this.config.dimensions,
								output_type: this.outputType,
								text_type: textType,
							},
						}),
						signal: requestSignal,
					}),
			});
			const ordered = [...payload.output.embeddings].sort(
				(a, b) => a.text_index - b.text_index,
			);
			if (ordered.length !== batch.length) {
				throw new Error(
					"embedding provider returned an unexpected vector count",
				);
			}
			for (let index = 0; index < ordered.length; index += 1) {
				const item = ordered[index];
				if (!item || item.text_index !== index) {
					throw new Error("embedding provider returned invalid vector indices");
				}
				const dense = assertDenseVector(
					item.embedding,
					this.config.dimensions,
					this.config.model,
					this.config.apiKey,
				);
				if (this.supportsSparse && item.sparse_embedding === undefined) {
					throw new Error(
						"DashScope native embedding response omitted sparse_embedding for output_type=dense&sparse",
					);
				}
				results.push({
					dense,
					...(this.supportsSparse
						? {
								sparse: normalizeProviderSparseVector(item.sparse_embedding),
							}
						: {}),
				});
			}
		}
		return results;
	}
}

export function createEmbeddingProvider(
	config: EmbeddingFactoryConfig,
): EmbeddingProvider {
	const protocol = resolveEmbeddingProtocol({
		baseUrl: config.baseUrl,
		model: config.model,
		protocol: config.protocol,
	});
	if (protocol === "dashscope_native") {
		return new DashScopeNativeEmbeddingProvider({
			apiKey: config.apiKey,
			baseUrl: config.baseUrl,
			model: config.model,
			dimensions: config.dimensions,
			batchSize: config.batchSize,
			timeoutMs: config.timeoutMs,
			outputType: "dense&sparse",
			fetch: config.fetch,
			retryBackoffMs: config.retryBackoffMs,
		});
	}
	const sendDimensions = resolveEmbeddingSendDimensions({
		baseUrl: config.baseUrl,
		model: config.model,
		sendDimensions: config.sendDimensions,
	});
	return new OpenAICompatibleEmbeddingProvider({
		apiKey: config.apiKey,
		baseUrl: config.baseUrl,
		model: config.model,
		dimensions: config.dimensions,
		batchSize: config.batchSize,
		timeoutMs: config.timeoutMs,
		sendDimensions,
		fetch: config.fetch,
		retryBackoffMs: config.retryBackoffMs,
	});
}
