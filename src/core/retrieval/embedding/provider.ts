import { z } from "zod";
import { withActiveSpan } from "@/lib/observability/tracing";

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

export interface EmbeddingProvider {
	embedQuery(query: string, signal?: AbortSignal): Promise<number[]>;
	embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export type OpenAICompatibleEmbeddingConfig = {
	apiKey: string;
	baseUrl: string;
	model: string;
	dimensions: number;
	batchSize?: number;
	fetch?: typeof globalThis.fetch;
};

function endpoint(baseUrl: string): string {
	return `${baseUrl.replace(/\/$/, "")}/embeddings`;
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
	private readonly fetch: typeof globalThis.fetch;
	private readonly batchSize: number;

	constructor(private readonly config: OpenAICompatibleEmbeddingConfig) {
		if (!config.apiKey.trim()) throw new Error("embedding API key is required");
		if (config.dimensions <= 0) {
			throw new Error("embedding dimensions must be positive");
		}
		this.fetch = config.fetch ?? globalThis.fetch;
		this.batchSize = Math.max(1, config.batchSize ?? 10);
	}

	async embedQuery(query: string, signal?: AbortSignal): Promise<number[]> {
		const [vector] = await this.embedTexts([query], signal);
		if (!vector) throw new Error("embedding provider returned no vector");
		return vector;
	}

	async embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
		if (!texts.length) return [];
		return withActiveSpan(
			"unorag.embedding",
			{
				"gen_ai.operation.name": "embeddings",
				"gen_ai.request.model": this.config.model,
				"unorag.embedding.input_count": texts.length,
				"unorag.embedding.dimensions": this.config.dimensions,
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
			const response = await this.fetch(endpoint(this.config.baseUrl), {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.config.apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: this.config.model,
					input: batch,
					dimensions: this.config.dimensions,
				}),
				signal,
			});
			if (!response.ok) {
				throw new Error(
					`embedding provider failed with HTTP ${response.status}`,
				);
			}
			const payload = EmbeddingResponseSchema.parse(await response.json());
			const ordered = [...payload.data].sort((a, b) => a.index - b.index);
			if (ordered.length !== batch.length) {
				throw new Error(
					"embedding provider returned an unexpected vector count",
				);
			}
			for (const item of ordered) {
				if (item.embedding.length !== this.config.dimensions) {
					throw new Error(
						"embedding provider returned an unexpected dimension",
					);
				}
				vectors.push(item.embedding);
			}
		}
		return vectors;
	}
}
