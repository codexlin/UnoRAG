import { z } from "zod";
import { withActiveSpan } from "@/lib/observability/tracing";
import { fetchRetrievalProvider } from "../provider-request";

const RerankResponseSchema = z
	.object({
		results: z.array(
			z
				.object({
					index: z.number().int().nonnegative(),
					relevance_score: z.number(),
				})
				.passthrough(),
		),
	})
	.passthrough();

export type RerankResult = {
	index: number;
	score: number;
};

export interface RerankProvider {
	rerank(input: {
		query: string;
		documents: string[];
		topN: number;
		signal?: AbortSignal;
	}): Promise<RerankResult[]>;
}

export type OpenAICompatibleRerankConfig = {
	apiKey: string;
	baseUrl: string;
	model: string;
	fetch?: typeof globalThis.fetch;
	retryBackoffMs?: readonly number[];
};

export class OpenAICompatibleRerankProvider implements RerankProvider {
	private readonly fetch: typeof globalThis.fetch;

	constructor(private readonly config: OpenAICompatibleRerankConfig) {
		if (!config.apiKey.trim()) throw new Error("rerank API key is required");
		this.fetch = config.fetch ?? globalThis.fetch;
	}

	async rerank(input: {
		query: string;
		documents: string[];
		topN: number;
		signal?: AbortSignal;
	}): Promise<RerankResult[]> {
		if (!input.documents.length) return [];
		return withActiveSpan(
			"unorag.rerank",
			{
				"gen_ai.operation.name": "rerank",
				"langfuse.observation.type": "span",
				"langfuse.observation.metadata.capture_content": false,
				"gen_ai.request.model": this.config.model,
				"unorag.rerank.document_count": input.documents.length,
				"unorag.rerank.top_n": Math.min(input.topN, input.documents.length),
			},
			() => this.rerankInSpan(input),
		);
	}

	private async rerankInSpan(input: {
		query: string;
		documents: string[];
		topN: number;
		signal?: AbortSignal;
	}): Promise<RerankResult[]> {
		const response = await fetchRetrievalProvider({
			provider: "rerank",
			signal: input.signal,
			retryBackoffMs: this.config.retryBackoffMs,
			request: () =>
				this.fetch(`${this.config.baseUrl.replace(/\/$/, "")}/reranks`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${this.config.apiKey}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						model: this.config.model,
						query: input.query,
						documents: input.documents,
						top_n: Math.min(input.topN, input.documents.length),
					}),
					signal: input.signal,
				}),
		});
		const payload = RerankResponseSchema.parse(await response.json());
		return payload.results
			.filter((item) => item.index < input.documents.length)
			.map((item) => ({
				index: item.index,
				score: Math.max(0, Math.min(1, item.relevance_score)),
			}));
	}
}
