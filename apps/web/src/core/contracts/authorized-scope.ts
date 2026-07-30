import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1).max(128);

export const AuthorizedScopeSchema = z
	.object({
		organizationId: IdentifierSchema,
		workspaceId: IdentifierSchema,
		principalIds: z.array(IdentifierSchema).min(1),
		groupIds: z.array(IdentifierSchema),
		libraryIds: z.array(IdentifierSchema).min(1),
		documentIds: z.array(IdentifierSchema).optional(),
		activeGenerationIds: z.array(IdentifierSchema),
	})
	.strict();

export type AuthorizedScope = z.infer<typeof AuthorizedScopeSchema>;
