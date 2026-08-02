import { z } from "zod";

import {
	TableColumnSchema,
	TableQualityReportSchema,
	TableRowSchema,
	TableSummaryRowSchema,
} from "../../document-ir";
import { RecordTypeSchema } from "../contracts";

const StoredRecordTypeSchema = RecordTypeSchema.exclude([
	"chunk+table_summary",
]);

const StoredQdrantPayloadSchema = z
	.object({
		library_id: z.string().trim().min(1),
		doc_id: z.string().trim().min(1),
		title: z.string(),
		chunk_index: z.number().int().nonnegative(),
		text: z.string(),
		body: z.string().nullable().optional(),
		document_version_id: z.string().trim().min(1),
		generation_id: z.string().trim().min(1).nullable().optional(),
		tenant_id: z.string().trim().min(1),
		workspace_id: z.string().trim().min(1),
		lifecycle_visibility: z
			.enum(["staging", "active", "inactive"])
			.nullable()
			.optional(),
		acl_scope: z.enum(["workspace", "restricted"]).nullable().optional(),
		acl_principal_ids: z.array(z.string()).optional(),
		acl_group_ids: z.array(z.string()).optional(),
		record_type: StoredRecordTypeSchema.default("chunk"),
		record_id: z.string().nullable().optional(),
		parent_record_id: z.string().nullable().optional(),
		preamble: z.string().nullable().optional(),
		section_path: z.string().nullable().optional(),
		heading_text: z.string().nullable().optional(),
		page: z.union([z.string(), z.number()]).nullable().optional(),
		page_start: z.number().int().nullable().optional(),
		page_end: z.number().int().nullable().optional(),
		table_id: z.string().nullable().optional(),
		figure_id: z.string().nullable().optional(),
		node_ids: z.array(z.string()).optional(),
		split_strategy: z.string().nullable().optional(),
		chunk_policy_version: z.string().nullable().optional(),
		chunk_profile: z.string().nullable().optional(),
		split_reason: z.string().nullable().optional(),
		target_chars: z.number().int().positive().nullable().optional(),
		max_chars: z.number().int().positive().nullable().optional(),
		table_rows_per_record: z.number().int().positive().nullable().optional(),
		table_tokens_per_record: z.number().int().positive().nullable().optional(),
		semantic_distance_threshold: z.number().nullable().optional(),
		semantic_unit_count: z.number().int().positive().nullable().optional(),
		semantic_fallback: z.union([z.boolean(), z.string()]).nullable().optional(),
		source_format: z.string().nullable().optional(),
		content_hash: z.string().nullable().optional(),
		headers: z.array(z.string()).optional(),
		rows: z.array(z.array(z.string())).optional(),
		row_start: z.number().int().nullable().optional(),
		row_end: z.number().int().nullable().optional(),
		table_row_count: z.number().int().nonnegative().nullable().optional(),
		table_caption: z.string().nullable().optional(),
		table_quality: TableQualityReportSchema.nullable().optional(),
		summary_rows: z.array(TableSummaryRowSchema).optional(),
		footnotes: z.array(z.string()).optional(),
		header_rows: z.array(z.array(z.string())).optional(),
		table_columns: z.array(TableColumnSchema).optional(),
		cell_rows: z.array(TableRowSchema).optional(),
		filename: z.string().nullable().optional(),
		source_chunk_ids: z.array(z.string()).optional(),
		source_node_ids: z.array(z.string()).optional(),
		deactivated_at: z.string().nullable().optional(),
	})
	.strict();

export type StoredQdrantPayload = z.infer<typeof StoredQdrantPayloadSchema>;

const QdrantSearchHitSchema = z
	.object({
		id: z.union([z.string(), z.number()]),
		score: z.number().finite(),
		dense_score: z.number().finite().nullable().optional(),
		bm25_score: z.number().finite().nullable().optional(),
		rrf_score: z.number().finite().nullable().optional(),
		used_rerank: z.boolean().optional(),
		used_hybrid: z.boolean().optional(),
		payload: StoredQdrantPayloadSchema,
	})
	.strict();

export type QdrantSearchHit = z.infer<typeof QdrantSearchHitSchema>;

const PAYLOAD_KEYS = StoredQdrantPayloadSchema.keyof().options;
const HIT_KEYS = QdrantSearchHitSchema.keyof().options;

function pickKnown(
	input: Record<string, unknown>,
	keys: readonly string[],
): Record<string, unknown> {
	return Object.fromEntries(
		keys.filter((key) => key in input).map((key) => [key, input[key]]),
	);
}

/**
 * Stored points may contain historical fields. Explicit projection prevents
 * those fields from entering the typed retrieval boundary.
 */
export function parseStoredQdrantPayload(
	input: unknown,
): StoredQdrantPayload | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) return null;
	const parsed = StoredQdrantPayloadSchema.safeParse(
		pickKnown(input as Record<string, unknown>, PAYLOAD_KEYS),
	);
	return parsed.success ? parsed.data : null;
}

export function parseQdrantSearchHit(input: unknown): QdrantSearchHit | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) return null;
	const source = input as Record<string, unknown>;
	const payload = parseStoredQdrantPayload(source.payload);
	if (!payload) return null;
	const candidate = {
		...pickKnown(source, HIT_KEYS),
		payload,
	};
	const parsed = QdrantSearchHitSchema.safeParse(candidate);
	return parsed.success ? parsed.data : null;
}
