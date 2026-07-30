import { z } from "zod";

export const durableJobKinds = [
	"document.ingest",
	"document.delete",
	"generation.cleanup",
] as const;

export type DurableJobKind = (typeof durableJobKinds)[number];

const uuid = z.string().uuid();
const nonEmpty = z.string().trim().min(1);

const jobEnvelope = {
	jobId: uuid,
	organizationId: uuid,
	workspaceId: uuid,
	documentVersionId: uuid.nullable().optional(),
	idempotencyKey: z.string().trim().min(1).max(256),
};

export const documentIngestPayloadSchema = z
	.object({
		document_id: uuid,
		document_version_id: uuid,
		generation_id: uuid,
		library_id: nonEmpty,
		storage_key: nonEmpty,
		content_hash: nonEmpty,
		filename: nonEmpty,
		content_type: nonEmpty,
		document_profile: z.string().trim().min(1).default("auto"),
		scan_handling: z.string().trim().min(1).default("auto"),
		parse_preference: z.string().trim().min(1).default("auto"),
		ingest_policy_version: z.number().int().positive().default(1),
		queue_class: z.enum(["local", "auto", "mineru"]),
	})
	.strict();

export const documentDeletePayloadSchema = z
	.object({
		document_id: uuid,
		rag_document_id: nonEmpty,
		library_id: uuid,
		rag_library_id: nonEmpty,
		storage_keys: z.array(nonEmpty).default([]),
		generation_ids: z.array(uuid).default([]),
		library_delete: z.boolean().default(false),
	})
	.strict();

export const generationCleanupPayloadSchema = z
	.object({
		generation_id: uuid,
		document_id: uuid,
		library_id: nonEmpty,
		storage_keys: z.array(nonEmpty).default([]),
		reason: z
			.enum(["superseded", "delete", "failed_staging", "operator"])
			.default("superseded"),
		delete_after: z.string().datetime({ offset: true }).optional(),
	})
	.strict();

export const documentIngestJobSchema = z
	.object({
		...jobEnvelope,
		type: z.literal("document.ingest"),
		payload: documentIngestPayloadSchema,
	})
	.strict();

export const documentDeleteJobSchema = z
	.object({
		...jobEnvelope,
		type: z.literal("document.delete"),
		payload: documentDeletePayloadSchema,
	})
	.strict();

export const generationCleanupJobSchema = z
	.object({
		...jobEnvelope,
		type: z.literal("generation.cleanup"),
		payload: generationCleanupPayloadSchema,
	})
	.strict();

export const durableJobSchema = z.discriminatedUnion("type", [
	documentIngestJobSchema,
	documentDeleteJobSchema,
	generationCleanupJobSchema,
]);

export const documentIngestWorkflowInputSchema = z.tuple([
	documentIngestJobSchema,
]);
export const documentDeleteWorkflowInputSchema = z.tuple([
	documentDeleteJobSchema,
]);
export const generationCleanupWorkflowInputSchema = z.tuple([
	generationCleanupJobSchema,
]);

export type DocumentIngestJob = z.infer<typeof documentIngestJobSchema>;
export type DocumentDeleteJob = z.infer<typeof documentDeleteJobSchema>;
export type GenerationCleanupJob = z.infer<typeof generationCleanupJobSchema>;
export type DurableJobInput = z.infer<typeof durableJobSchema>;

export type JobForKind<K extends DurableJobKind> = Extract<
	DurableJobInput,
	{ type: K }
>;
