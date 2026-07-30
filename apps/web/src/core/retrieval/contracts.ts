import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1).max(128);

export const RecordTypeSchema = z.enum([
	"chunk",
	"section",
	"document",
	"table",
	"table_summary",
	"chunk+table_summary",
]);

export type RecordType = z.infer<typeof RecordTypeSchema>;

/**
 * Caller-controlled filters. Security dimensions deliberately do not exist in
 * this schema and unknown keys fail validation.
 */
export const RetrievalUserFiltersSchema = z
	.object({
		record_type: RecordTypeSchema.optional(),
		doc_id: IdentifierSchema.optional(),
		table_id: IdentifierSchema.optional(),
		document_version_id: IdentifierSchema.optional(),
	})
	.strict();

export type RetrievalUserFilters = z.infer<typeof RetrievalUserFiltersSchema>;

/**
 * Server-derived authorization snapshot for one library retrieval operation.
 * An empty generation list is valid and means that no point may be returned.
 */
export const RetrievalScopeSchema = z
	.object({
		tenantId: IdentifierSchema,
		workspaceId: IdentifierSchema,
		libraryId: IdentifierSchema,
		principalIds: z.array(IdentifierSchema).min(1),
		groupIds: z.array(IdentifierSchema).default([]),
		activeGenerationIds: z.array(IdentifierSchema),
	})
	.strict();

export type RetrievalScope = z.infer<typeof RetrievalScopeSchema>;

export const QdrantMatchValueSchema = z
	.object({ value: z.union([z.string(), z.number(), z.boolean()]) })
	.strict();

export const QdrantMatchAnySchema = z
	.object({
		any: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
	})
	.strict();

export const QdrantFieldConditionSchema = z
	.object({
		key: z.string().trim().min(1),
		match: z.union([QdrantMatchValueSchema, QdrantMatchAnySchema]),
	})
	.strict();

export const QdrantIsEmptyConditionSchema = z
	.object({
		is_empty: z.object({ key: z.string().trim().min(1) }).strict(),
	})
	.strict();

export const QdrantIsNullConditionSchema = z
	.object({
		is_null: z.object({ key: z.string().trim().min(1) }).strict(),
	})
	.strict();

export type QdrantFieldCondition = z.infer<typeof QdrantFieldConditionSchema>;
export type QdrantIsEmptyCondition = z.infer<
	typeof QdrantIsEmptyConditionSchema
>;
export type QdrantIsNullCondition = z.infer<typeof QdrantIsNullConditionSchema>;

export type QdrantCondition =
	| QdrantFieldCondition
	| QdrantIsEmptyCondition
	| QdrantIsNullCondition
	| QdrantFilter;

export type QdrantFilter = {
	must?: QdrantCondition[];
	should?: QdrantCondition[];
	must_not?: QdrantCondition[];
};

export const QdrantFilterSchema: z.ZodType<QdrantFilter> = z.lazy(() =>
	z
		.object({
			must: z.array(QdrantConditionSchema).optional(),
			should: z.array(QdrantConditionSchema).optional(),
			must_not: z.array(QdrantConditionSchema).optional(),
		})
		.strict(),
);

export const QdrantConditionSchema: z.ZodType<QdrantCondition> = z.lazy(() =>
	z.union([
		QdrantFieldConditionSchema,
		QdrantIsEmptyConditionSchema,
		QdrantIsNullConditionSchema,
		QdrantFilterSchema,
	]),
);

export const InternalCitationSchema = z
	.object({
		id: z.string().min(1),
		index: z.number().int().positive(),
		title: z.string(),
		page: z.string().nullable(),
		page_start: z.number().int().nullable(),
		page_end: z.number().int().nullable(),
		section_path: z.string().nullable(),
		preamble: z.string().nullable(),
		table_id: z.string().nullable(),
		headers: z.array(z.string()),
		rows: z.array(z.array(z.string())),
		row_start: z.number().int().nullable(),
		row_end: z.number().int().nullable(),
		table_row_count: z.number().int().nullable(),
		snippet: z.string(),
		score: z.number().min(0).max(1),
		dense_score: z.number().nullable(),
		bm25_score: z.number().nullable(),
		rrf_score: z.number().nullable(),
		used_rerank: z.boolean(),
		used_hybrid: z.boolean(),
		text: z.string(),
		body: z.string(),
		library_id: z.string(),
		doc_id: z.string(),
		chunk_index: z.number().int(),
		filename: z.string().nullable(),
		document_version_id: z.string(),
		generation_id: z.string().nullable(),
		tenant_id: z.string(),
		workspace_id: z.string(),
		record_type: RecordTypeSchema.exclude(["chunk+table_summary"]),
		record_id: z.string().nullable(),
		source_chunk_ids: z.array(z.string()),
		source_node_ids: z.array(z.string()),
	})
	.strict();

export type InternalCitation = z.infer<typeof InternalCitationSchema>;
