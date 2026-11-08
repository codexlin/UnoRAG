import "server-only";

import { and, eq, isNull, notInArray } from "drizzle-orm";

import { getDatabase } from "@/db";
import { libraryCountsUpdate } from "@/db/library-counts";
import { documents, libraries } from "@/db/schema";
import type { AuthIdentity } from "./auth/provider";

export {
	canManageLibraries,
	canWriteLibraries,
} from "./library-permissions.mjs";

export async function findAuthorizedLibrary(
	identity: AuthIdentity,
	ragLibraryId: string,
) {
	const db = getDatabase();
	const [library] = await db
		.select()
		.from(libraries)
		.where(
			and(
				eq(libraries.organizationId, identity.tenantId),
				eq(libraries.workspaceId, identity.workspaceId),
				eq(libraries.ragLibraryId, ragLibraryId),
				notInArray(libraries.status, ["deleting", "deleted"]),
			),
		)
		.limit(1);
	return library ?? null;
}

export async function findAuthorizedDocument(
	identity: AuthIdentity,
	ragDocumentId: string,
) {
	const db = getDatabase();
	const [document] = await db
		.select({
			id: documents.id,
			ragDocumentId: documents.ragDocumentId,
			ragLibraryId: libraries.ragLibraryId,
		})
		.from(documents)
		.innerJoin(
			libraries,
			and(
				eq(libraries.id, documents.libraryId),
				eq(libraries.organizationId, identity.tenantId),
				eq(libraries.workspaceId, identity.workspaceId),
			),
		)
		.where(
			and(
				eq(documents.organizationId, identity.tenantId),
				eq(documents.workspaceId, identity.workspaceId),
				eq(documents.ragDocumentId, ragDocumentId),
				notInArray(documents.status, ["deleting", "deleted"]),
				isNull(documents.deletedAt),
				notInArray(libraries.status, ["deleting", "deleted"]),
			),
		)
		.limit(1);
	return document ?? null;
}

export async function refreshLibraryCounts(libraryId: string) {
	const db = getDatabase();
	await db.transaction(async (tx) => {
		const [library] = await tx
			.select({
				status: libraries.status,
				organizationId: libraries.organizationId,
				workspaceId: libraries.workspaceId,
			})
			.from(libraries)
			.where(eq(libraries.id, libraryId))
			.for("update")
			.limit(1);
		if (!library || library.status === "deleted") return;
		await tx.execute(libraryCountsUpdate({ libraryId, ...library }));
	});
}
