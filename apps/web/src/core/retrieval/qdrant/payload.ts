import { z } from "zod";

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
		preamble: z.string().nullable().optional(),
		section_path: z.string().nullable().optional(),
		page: z.union([z.string(), z.number()]).nullable().optional(),
		page_start: z.number().int().nullable().optional(),
		page_end: z.number().int().nullable().optional(),
		table_id: z.string().nullable().optional(),
		headers: z.array(z.string()).optional(),
		rows: z.array(z.array(z.string())).optional(),
		row_start: z.number().int().nullable().optional(),
		row_end: z.number().int().nullable().optional(),
		table_row_count: z.number().int().nonnegative().nullable().optional(),
		filename: z.string().nullable().optional(),
		source_chunk_ids: z.array(z.string()).optional(),
		source_node_ids: z.array(z.string()).optional(),
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
