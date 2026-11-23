import { z } from "zod";

export const NativeAskPolicySchema = z
	.object({
		retrieve_top_k: z.number().int().min(1).max(50).default(6),
		answer_min_score: z.number().min(0).max(1).default(0.4),
		hybrid_enabled: z.boolean().default(true),
		rerank_enabled: z.boolean().default(false),
		hybrid_retry_enabled: z.literal(false).optional(),
		rerank_retry_enabled: z.literal(false).optional(),
		citation_adjudicate_enabled: z.boolean().default(true),
		citation_adjudicate_absolute_floor: z.number().min(0).max(1).default(0.35),
		session_memory_enabled: z.boolean().default(true),
		session_memory_max_turns: z.number().int().min(1).max(50).default(10),
		_ask_policy: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

export type NativeAskPolicy = z.infer<typeof NativeAskPolicySchema>;

export function askRetrievalOptions(policy: NativeAskPolicy, retry: boolean) {
	return {
		hybridEnabled:
			policy.hybrid_enabled || (retry && policy.hybrid_retry_enabled !== false),
		rerankEnabled:
			policy.rerank_enabled || (retry && policy.rerank_retry_enabled !== false),
	};
}
