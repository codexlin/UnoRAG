import { z } from "zod";
import { looksRetrievalSensitive } from "@/lib/server/ask-policy.mjs";

export const NativeAskPolicySchema = z
	.object({
		retrieve_top_k: z.number().int().min(1).max(50).default(6),
		answer_min_score: z.number().min(0).max(1).default(0.4),
		hybrid_enabled: z.boolean().default(true),
		rerank_enabled: z.boolean().default(false),
		rerank_retry_enabled: z.literal(false).optional(),
		citation_adjudicate_enabled: z.boolean().default(true),
		citation_adjudicate_absolute_floor: z.number().min(0).max(1).default(0.35),
		session_memory_enabled: z.boolean().default(true),
		session_memory_max_turns: z.number().int().min(1).max(50).default(10),
		_ask_policy: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

export type NativeAskPolicy = z.infer<typeof NativeAskPolicySchema>;

export type AskRetrievalQueryContext = {
	query?: string;
	queryType?: string;
	isMultiAspectFact?: boolean;
	isDerivedCalculation?: boolean;
	tableOnly?: boolean;
};

export function askRetrievalOptions(
	policy: NativeAskPolicy,
	retry: boolean,
	context?: AskRetrievalQueryContext,
) {
	const canAutoRerank = policy.rerank_retry_enabled !== false;
	const publicPolicy = policy._ask_policy?.public;
	const rerankingMode =
		publicPolicy &&
		typeof publicPolicy === "object" &&
		typeof (publicPolicy as { reranking?: unknown }).reranking === "string"
			? (publicPolicy as { reranking: string }).reranking
			: undefined;
	const explicitRerankOn =
		rerankingMode === "on" ||
		(rerankingMode === undefined && policy.rerank_enabled);
	const autoFirstTurnRerank =
		rerankingMode === "auto" && policy.rerank_enabled && !context?.tableOnly;
	const runtimeAutoRerank =
		canAutoRerank &&
		!context?.tableOnly &&
		Boolean(
			context?.queryType === "compare" ||
				context?.isMultiAspectFact ||
				context?.isDerivedCalculation ||
				(context?.query && looksRetrievalSensitive(context.query)),
		);
	const rerankEnabled =
		explicitRerankOn ||
		autoFirstTurnRerank ||
		(retry && canAutoRerank && !context?.tableOnly) ||
		runtimeAutoRerank;
	const rerankSparseOnly =
		!rerankEnabled && canAutoRerank && !context?.tableOnly;
	return {
		hybridEnabled: policy.hybrid_enabled,
		rerankEnabled,
		...(rerankSparseOnly ? { rerankSparseOnly: true } : {}),
	};
}
