import { z } from "zod";

export const RetrievalFiltersSchema = z
	.object({
		record_type: z
			.enum([
				"chunk",
				"section",
				"document",
				"table",
				"table_summary",
				"figure",
				"chunk+table_summary",
				"text",
			])
			.nullable()
			.optional(),
		doc_id: z.string().trim().min(1).nullable().optional(),
		table_id: z.string().trim().min(1).nullable().optional(),
		document_version_id: z.string().trim().min(1).nullable().optional(),
	})
	.strict();

export type RetrievalFilters = z.infer<typeof RetrievalFiltersSchema>;

export const RetrievalPlanSchema = z
	.object({
		semantic_query: z.string().trim().min(1),
		filters: RetrievalFiltersSchema.default({}),
	})
	.strict();

export type RetrievalPlan = z.infer<typeof RetrievalPlanSchema>;
