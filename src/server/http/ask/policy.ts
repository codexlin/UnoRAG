import { z } from "zod";

export const NativeAskPolicySchema = z
	.object({
		retrieve_top_k: z.number().int().min(1).max(50).default(6),
		answer_min_score: z.number().min(0).max(1).default(0.4),
		hybrid_enabled: z.boolean().default(false),
		rerank_enabled: z.boolean().default(false),
		citation_adjudicate_enabled: z.boolean().default(true),
		citation_adjudicate_absolute_floor: z.number().min(0).max(1).default(0.35),
		session_memory_enabled: z.boolean().default(true),
		session_memory_max_turns: z.number().int().min(1).max(50).default(10),
		_ask_policy: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

export type NativeAskPolicy = z.infer<typeof NativeAskPolicySchema>;
