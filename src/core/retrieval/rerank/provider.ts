import { z } from "zod";
import { withActiveSpan } from "@/lib/observability/tracing";
import { createSafeModelFetch } from "@/lib/server/model-settings-url";
import { fetchRetrievalProvider } from "../provider-request";

const RerankResultItemSchema = z
	.object({
		index: z.number().int().nonnegative(),
		relevance_score: z.number().finite(),
	})
	.passthrough();

const RerankResponseSchema = z
	.object({
		results: z.array(RerankResultItemSchema).optional(),
		data: z.array(RerankResultItemSchema).optional(),
	})
	.passthrough()
	.refine(
		(payload) =>
			(payload.results !== undefined) !== (payload.data !== undefined),
		"rerank response must contain either results or data",
	);

export function resolveRerankEndpoint(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	return /\/reranks?$/i.test(trimmed) ? trimmed : `${trimmed}/reranks`;
}

export function isVoyageRerankEndpoint(
	baseUrl: string,
	model: string,
): boolean {
	try {
		const host = new URL(baseUrl).hostname.toLowerCase();
		if (host === "api.voyageai.com" || host.endsWith(".voyageai.com")) {
			return true;
		}
	} catch {
		// Fall back to model heuristic if URL is not yet normalized.
	}
	return /^rerank-(?:2(?:\.\d+)?|lite)(?:-|$)/i.test(model.trim());
}

export function buildRerankRequestBody(input: {
	baseUrl: string;
	model: string;
	query: string;
	documents: string[];
	topN: number;
}): Record<string, unknown> {
	const limit = Math.min(input.topN, input.documents.length);
	const body: Record<string, unknown> = {
		model: input.model,
		query: input.query,
		documents: input.documents,
	};
	if (isVoyageRerankEndpoint(input.baseUrl, input.model)) {
		body.top_k = limit;
	} else {
		body.top_n = limit;
	}
	return body;
}

export type RerankResult = {
	index: number;
	score: number;
};

const RerankResultsSchema = z
	.array(
		z.object({
			index: z.number().int().nonnegative(),
			score: z.number().finite(),
		}),
	)
	.min(1);

export function normalizeRerankResults(
	results: unknown,
	documentCount: number,
): RerankResult[] {
	const ranked = RerankResultsSchema.parse(results);
	const seen = new Set<number>();
	for (const item of ranked) {
		if (item.index >= documentCount || seen.has(item.index)) {
			throw new Error("rerank response contains invalid or duplicate indices");
		}
		seen.add(item.index);
	}
	return [...ranked]
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((item) => ({
			index: item.index,
			score: Math.max(0, Math.min(1, item.score)),
		}));
}

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
	timeoutMs?: number;
	fetch?: typeof globalThis.fetch;
	retryBackoffMs?: readonly number[];
};

export class OpenAICompatibleRerankProvider implements RerankProvider {
	private readonly fetch: typeof globalThis.fetch;
	private readonly timeoutMs: number;

	constructor(private readonly config: OpenAICompatibleRerankConfig) {
		if (!config.apiKey.trim()) throw new Error("rerank API key is required");
		this.fetch = config.fetch ?? createSafeModelFetch();
		this.timeoutMs = config.timeoutMs ?? 10_000;
		if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
			throw new Error("rerank timeout must be a positive integer");
		}
	}

	async rerank(input: {
		query: string;
		documents: string[];
		topN: number;
		signal?: AbortSignal;
	}): Promise<RerankResult[]> {
		input.signal?.throwIfAborted();
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
		return fetchRetrievalProvider({
			provider: "rerank",
			signal: input.signal,
			timeoutMs: this.timeoutMs,
			retryBackoffMs: this.config.retryBackoffMs,
			parse: async (response) => {
				const payload = RerankResponseSchema.parse(await response.json());
				const rows = payload.results ?? payload.data ?? [];
				return normalizeRerankResults(
					rows.map((item) => ({
						index: item.index,
						score: item.relevance_score,
					})),
					input.documents.length,
				);
			},
			request: (requestSignal) =>
				this.fetch(resolveRerankEndpoint(this.config.baseUrl), {
					method: "POST",
					redirect: "error",
					headers: {
						authorization: `Bearer ${this.config.apiKey}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(
						buildRerankRequestBody({
							baseUrl: this.config.baseUrl,
							model: this.config.model,
							query: input.query,
							documents: input.documents,
							topN: input.topN,
						}),
					),
					signal: requestSignal,
				}),
		});
	}
}
