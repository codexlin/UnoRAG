import "server-only";

import { and, eq, isNull, notInArray, sql } from "drizzle-orm";

import { getDatabase } from "@/db";
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
	const now = new Date();
	const [library] = await db
		.select({ status: libraries.status })
		.from(libraries)
		.where(eq(libraries.id, libraryId))
		.limit(1);
	if (!library || library.status === "deleted") return;
	const [counts] = await db
		.select({
			total: sql<number>`count(*) filter (where ${documents.status} not in ('deleted'))`,
			live: sql<number>`count(*) filter (where ${documents.status} not in ('deleting', 'deleted'))`,
			ready: sql<number>`count(*) filter (where ${documents.status} in ('ready', 'degraded'))`,
			processing: sql<number>`count(*) filter (where ${documents.status} in ('processing', 'deleting'))`,
			failed: sql<number>`count(*) filter (where ${documents.status} = 'failed')`,
		})
		.from(documents)
		.where(eq(documents.libraryId, libraryId));
	const live = Number(counts.live);
	const total = Number(counts.total);
	await db
		.update(libraries)
		.set({
			docCount: total,
			readyCount: Number(counts.ready),
			status:
				library.status === "deleting"
					? "deleting"
					: live === 0
						? "empty"
						: Number(counts.processing) > 0
							? "indexing"
							: Number(counts.ready) === live
								? "ready"
								: Number(counts.ready) > 0
									? "degraded"
									: Number(counts.failed) > 0
										? "failed"
										: "empty",
			updatedAt: now,
		})
		.where(eq(libraries.id, libraryId));
}
