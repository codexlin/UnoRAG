import { randomUUID } from "node:crypto";

import { and, eq, ne } from "drizzle-orm";

import { getDatabase } from "@/db";
import { documents } from "@/db/schema";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { enqueueDocumentDelete } from "@/lib/server/document-delete-enqueue";
import { documentLifecycleV2Enabled } from "@/lib/server/document-lifecycle";
import {
	canManageLibraries,
	findAuthorizedLibrary,
	refreshLibraryCounts,
} from "@/lib/server/library-access";

export const runtime = "nodejs";

type RouteContext = {
	params: Promise<{ libraryId: string; documentId: string }>;
};

/**
 * Tombstone a document and enqueue async document.delete cleanup.
 * Returns 202 while Qdrant/object/metadata cleanup runs in the lifecycle worker.
 */
export async function DELETE(request: Request, context: RouteContext) {
	if (!documentLifecycleV2Enabled()) {
		return Response.json(
			{ detail: "document lifecycle v2 is disabled" },
			{ status: 404 },
		);
	}
	const identity = await resolveRequestSession(request);
	if (!identity) {
		return Response.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}
	if (!canManageLibraries(identity)) {
		return Response.json(
			{ detail: "library owner permission required" },
			{ status: 403 },
		);
	}
	const { libraryId, documentId } = await context.params;
	const library = await findAuthorizedLibrary(identity, libraryId);
	if (!library) {
		return Response.json({ detail: "library not found" }, { status: 404 });
	}
	if (library.status === "deleting" || library.status === "deleted") {
		return Response.json(
			{ detail: "library is being deleted" },
			{ status: 409 },
		);
	}

	const db = getDatabase();
	const now = new Date();
	const requestId = request.headers.get("x-request-id") ?? randomUUID();
	const result = await db.transaction(async (tx) => {
		const [document] = await tx
			.select()
			.from(documents)
			.where(
				and(
					eq(documents.organizationId, identity.tenantId),
					eq(documents.workspaceId, identity.workspaceId),
					eq(documents.libraryId, library.id),
					eq(documents.ragDocumentId, documentId),
					ne(documents.status, "deleted"),
				),
			)
			.for("update")
			.limit(1);
		if (!document) return null;
		return enqueueDocumentDelete({
			tx,
			identity,
			library,
			document,
			requestId,
			now,
		});
	});

	if (!result) {
		return Response.json({ detail: "document not found" }, { status: 404 });
	}

	await refreshLibraryCounts(library.id).catch(() => undefined);

	return Response.json(
		{
			ok: true,
			library_id: library.ragLibraryId,
			doc_id: result.ragDocumentId,
			document_id: result.documentId,
			job_id: result.jobId,
			status: "deleting",
			accepted: true,
			already_queued: result.alreadyQueued,
		},
		{ status: 202 },
	);
}
