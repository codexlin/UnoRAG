import { randomUUID } from "node:crypto";

import { and, eq, ne } from "drizzle-orm";

import { getDatabase } from "@/db";
import { documents } from "@/db/schema";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { documentLifecycleV2Enabled } from "@/lib/server/document-lifecycle";
import {
	createDocumentVersion,
	DocumentVersionCommandError,
} from "@/lib/server/document-version-command";
import {
	canWriteLibraries,
	findAuthorizedLibrary,
	refreshLibraryCounts,
} from "@/lib/server/library-access";

export const runtime = "nodejs";

type RouteContext = {
	params: Promise<{ libraryId: string; documentId: string }>;
};

/** Create a new version that reuses the retained source object. */
export async function POST(request: Request, context: RouteContext) {
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
	if (!canWriteLibraries(identity)) {
		return Response.json(
			{ detail: "library write permission required" },
			{ status: 403 },
		);
	}

	const { libraryId, documentId } = await context.params;
	const library = await findAuthorizedLibrary(identity, libraryId);
	if (!library) {
		return Response.json({ detail: "library not found" }, { status: 404 });
	}
	const db = getDatabase();
	const [document] = await db
		.select({ id: documents.id })
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
		.limit(1);
	if (!document) {
		return Response.json({ detail: "document not found" }, { status: 404 });
	}

	let created: Awaited<ReturnType<typeof createDocumentVersion>>;
	try {
		created = await createDocumentVersion({
			identity,
			libraryId: library.id,
			documentId: document.id,
			requestId: request.headers.get("x-request-id") ?? randomUUID(),
			source: { kind: "reindex" },
		});
	} catch (error) {
		if (error instanceof DocumentVersionCommandError) {
			const detail =
				error.code === "source_missing"
					? "原文未保留，请重新上传"
					: error.message;
			return Response.json({ detail }, { status: 409 });
		}
		return Response.json(
			{ detail: "document reindex transaction failed" },
			{ status: 500 },
		);
	}

	await refreshLibraryCounts(created.libraryId).catch(() => undefined);

	return Response.json(
		{
			library_id: created.ragLibraryId,
			doc_id: created.ragDocumentId,
			document_id: created.ragDocumentId,
			document_version_id: created.versionId,
			generation_id: created.generationId,
			job_id: created.jobId,
			version: created.version,
			title: created.displayName,
			filename: created.filename,
			chunk_count: 0,
			status: "processing",
			mode: "live",
			simulated: false,
			accepted: true,
			pipeline: "document-lifecycle-v2",
		},
		{ status: 202 },
	);
}
