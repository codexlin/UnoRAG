import "server-only";

import { and, count, eq, ne, sql } from "drizzle-orm";

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
			),
		)
		.limit(1);
	return document ?? null;
}

export async function syncRagDocument(
	identity: AuthIdentity,
	payload: {
		library_id: string;
		doc_id: string;
		title: string;
		filename: string;
		status: string;
		content_type?: string;
	},
) {
	const library = await findAuthorizedLibrary(identity, payload.library_id);
	if (!library) throw new Error("library not found during document sync");
	const db = getDatabase();
	const now = new Date();
	await db
		.delete(documents)
		.where(
			and(
				eq(documents.libraryId, library.id),
				eq(documents.filename, payload.filename),
				ne(documents.ragDocumentId, payload.doc_id),
			),
		);
	await db
		.insert(documents)
		.values({
			organizationId: identity.tenantId,
			workspaceId: identity.workspaceId,
			libraryId: library.id,
			ragDocumentId: payload.doc_id,
			name: payload.title,
			filename: payload.filename,
			contentType: payload.content_type || "application/octet-stream",
			status: payload.status,
			createdBy: identity.principalId,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [documents.libraryId, documents.ragDocumentId],
			set: {
				name: payload.title,
				filename: payload.filename,
				status: payload.status,
				...(payload.content_type ? { contentType: payload.content_type } : {}),
				updatedAt: now,
			},
		});
	await refreshLibraryCounts(library.id);
}

export async function refreshLibraryCounts(libraryId: string) {
	const db = getDatabase();
	const now = new Date();
	const [counts] = await db
		.select({
			total: count(),
			ready: sql<number>`count(*) filter (where ${documents.status} in ('ready', 'degraded'))`,
			processing: sql<number>`count(*) filter (where ${documents.status} = 'processing')`,
			failed: sql<number>`count(*) filter (where ${documents.status} = 'failed')`,
		})
		.from(documents)
		.where(eq(documents.libraryId, libraryId));
	await db
		.update(libraries)
		.set({
			docCount: Number(counts.total),
			readyCount: Number(counts.ready),
			status:
				Number(counts.total) === 0
					? "empty"
					: Number(counts.processing) > 0
						? "indexing"
						: Number(counts.ready) === Number(counts.total)
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

export async function removeRagDocument(
	identity: AuthIdentity,
	ragDocumentId: string,
) {
	const document = await findAuthorizedDocument(identity, ragDocumentId);
	if (!document) return false;
	const db = getDatabase();
	await db.delete(documents).where(eq(documents.id, document.id));
	const library = await findAuthorizedLibrary(identity, document.ragLibraryId);
	if (library) await refreshLibraryCounts(library.id);
	return true;
}
