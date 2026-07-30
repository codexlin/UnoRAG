import { z } from "zod";

import type { AuthorizedScope } from "../contracts";

export const ActiveGenerationSnapshotSchema = z
	.object({
		libraryId: z.string().trim().min(1),
		generationIds: z.array(z.string().uuid()),
		resolvedAt: z.date(),
	})
	.strict();

export type ActiveGenerationSnapshot = z.infer<
	typeof ActiveGenerationSnapshotSchema
>;

export interface ActiveGenerationResolver {
	resolve(input: {
		organizationId: string;
		workspaceId: string;
		libraryId: string;
	}): Promise<ActiveGenerationSnapshot | null>;
}

export function scopeWithActiveGenerations(
	scope: Omit<AuthorizedScope, "activeGenerationIds">,
	snapshot: ActiveGenerationSnapshot,
): AuthorizedScope {
	if (!scope.libraryIds.includes(snapshot.libraryId)) {
		throw new Error("active generation snapshot does not belong to scope");
	}
	return {
		...scope,
		activeGenerationIds: [...snapshot.generationIds],
	};
}
