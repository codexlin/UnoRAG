import { z } from "zod";

export const MAX_MEMORY_SOURCE_REFERENCES = 256;

const ReferenceIdSchema = z.string().trim().min(1).max(256);
export const MemorySourceReferenceSchema = z
	.object({
		doc_id: ReferenceIdSchema,
		document_version_id: ReferenceIdSchema,
		generation_id: ReferenceIdSchema,
		library_id: ReferenceIdSchema.optional(),
		tenant_id: ReferenceIdSchema.optional(),
		workspace_id: ReferenceIdSchema.optional(),
	})
	.strict();

export const MemoryProvenanceSchema = z
	.object({
		version: z.literal(1),
		libraryId: z.string().trim().min(1).max(128),
		sourceReferences: z
			.array(MemorySourceReferenceSchema)
			.max(MAX_MEMORY_SOURCE_REFERENCES),
	})
	.strict();

export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>;
