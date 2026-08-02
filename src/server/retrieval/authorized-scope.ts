import "server-only";

import type { AuthIdentity } from "@/lib/server/auth/provider";

import {
	type AuthorizedScope,
	AuthorizedScopeSchema,
} from "../../core/contracts";
import {
	type ActiveGenerationResolver,
	scopeWithActiveGenerations,
} from "../../core/retrieval/active-generation";

export async function resolveAuthorizedRetrievalScope(input: {
	identity: AuthIdentity;
	libraryId: string;
	resolver: ActiveGenerationResolver;
	documentIds?: string[];
}): Promise<AuthorizedScope | null> {
	const snapshot = await input.resolver.resolve({
		organizationId: input.identity.tenantId,
		workspaceId: input.identity.workspaceId,
		libraryId: input.libraryId,
	});
	if (!snapshot) return null;
	const base = AuthorizedScopeSchema.omit({
		activeGenerationIds: true,
	}).parse({
		organizationId: input.identity.tenantId,
		workspaceId: input.identity.workspaceId,
		principalIds: [input.identity.principalId],
		groupIds: input.identity.groupIds,
		libraryIds: [input.libraryId],
		documentIds: input.documentIds,
	});
	return AuthorizedScopeSchema.parse(
		scopeWithActiveGenerations(base, snapshot),
	);
}
