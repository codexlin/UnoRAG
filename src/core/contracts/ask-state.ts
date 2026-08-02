import { z } from "zod";

const MetadataSchema = z.record(z.string(), z.unknown());

export const ASK_GRAPH_NODE_NAMES = [
	"query_router",
	"build_retrieval_plan",
	"clarify",
	"build_table_plan",
	"table_retrieve",
	"table_execute",
	"rewrite",
	"retrieve",
	"judge",
	"retry",
	"generate",
	"refuse",
] as const;

export const ASK_STATE_FIELD_NAMES = [
	"session_id",
	"question",
	"library_id",
	"history",
	"rewritten_question",
	"citations",
	"answer",
	"refused",
	"refuse_reason",
	"retrieval_attempts",
	"judgement",
	"retrieval_debug",
	"trace_id",
	"query_type",
	"route_reason",
	"retrieval_plan",
	"table_query_plan",
	"table_execution",
	"upgrade",
	"upgrade_reason",
	"downgrade_reason",
] as const;

export const AskStateSchema = z
	.object({
		session_id: z.string().optional(),
		question: z.string().optional(),
		library_id: z.string().nullable().optional(),
		history: z.array(MetadataSchema).optional(),
		rewritten_question: z.string().optional(),
		citations: z.array(MetadataSchema).optional(),
		answer: z.string().optional(),
		refused: z.boolean().optional(),
		refuse_reason: z.string().nullable().optional(),
		retrieval_attempts: z.number().int().nonnegative().optional(),
		judgement: MetadataSchema.optional(),
		retrieval_debug: MetadataSchema.optional(),
		trace_id: z.string().optional(),
		query_type: z.string().optional(),
		route_reason: z.string().optional(),
		retrieval_plan: MetadataSchema.optional(),
		table_query_plan: MetadataSchema.optional(),
		table_execution: MetadataSchema.optional(),
		upgrade: z.string().nullable().optional(),
		upgrade_reason: z.string().nullable().optional(),
		downgrade_reason: z.string().nullable().optional(),
	})
	.strict();

export type AskState = z.infer<typeof AskStateSchema>;
