import { randomUUID } from "node:crypto";
import path from "node:path";

import { and, desc, eq, ne } from "drizzle-orm";

import { getDatabase } from "@/db";
import {
	documentActiveVersions,
	documents,
	documentVersions,
} from "@/db/schema";
import { resolveRequestSession } from "@/lib/server/auth/session";
import {
	documentLifecycleV2Enabled,
	documentStorageKey,
	validateDocumentUpload,
} from "@/lib/server/document-lifecycle";
import {
	createDocumentVersion,
	DocumentVersionCommandError,
} from "@/lib/server/document-version-command";
import { contentTypeForUpload } from "@/lib/server/document-version-core.mjs";
import { documentMetadataVisibilitySql } from "@/lib/server/document-visibility";
import {
	canWriteLibraries,
	findAuthorizedLibrary,
	refreshLibraryCounts,
} from "@/lib/server/library-access";
import {
	documentObjectStorage,
	documentUploadMaxBytes,
} from "@/lib/server/object-storage";

export const runtime = "nodejs";

type RouteContext = {
	params: Promise<{ libraryId: string; documentId: string }>;
};

/** List document versions with active pointer for history UI. */
export async function GET(request: Request, context: RouteContext) {
	const identity = await resolveRequestSession(request);
	if (!identity) {
		return Response.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}
	const { libraryId, documentId } = await context.params;
	const library = await findAuthorizedLibrary(identity, libraryId);
	if (!library) {
		return Response.json({ detail: "library not found" }, { status: 404 });
	}
	const db = getDatabase();
	const [document] = await db
		.select()
		.from(documents)
		.where(
			and(
				eq(documents.organizationId, identity.tenantId),
				eq(documents.workspaceId, identity.workspaceId),
				eq(documents.libraryId, library.id),
				eq(documents.ragDocumentId, documentId),
				ne(documents.status, "deleted"),
				documentMetadataVisibilitySql(identity, documents.id),
			),
		)
		.limit(1);
	if (!document) {
		return Response.json({ detail: "document not found" }, { status: 404 });
	}
	const [active] = await db
		.select()
		.from(documentActiveVersions)
		.where(eq(documentActiveVersions.documentId, document.id))
		.limit(1);
	const rows = await db
		.select()
		.from(documentVersions)
		.where(eq(documentVersions.documentId, document.id))
		.orderBy(desc(documentVersions.version));
	return Response.json({
		library_id: library.ragLibraryId,
		doc_id: document.ragDocumentId,
		document_id: document.id,
		active_version_id: active?.versionId ?? null,
		desired_version_id: document.desiredVersionId,
		versions: rows.map((version) => ({
			id: version.id,
			version: version.version,
			generation_id: version.generationId,
			status: version.status,
			is_active: active?.versionId === version.id,
			is_desired: document.desiredVersionId === version.id,
			content_hash: version.contentHash,
			size_bytes: version.sizeBytes,
			point_count: version.pointCount,
			chunk_count: version.chunkCount,
			pipeline_version: version.pipelineVersion,
			parser_backend: version.parserBackend,
			failure_code: version.failureCode,
			error: version.error,
			indexed_at: version.indexedAt?.toISOString() ?? null,
			activated_at: version.activatedAt?.toISOString() ?? null,
			superseded_at: version.supersededAt?.toISOString() ?? null,
			created_at: version.createdAt.toISOString(),
			updated_at: version.updatedAt.toISOString(),
		})),
	});
}

/**
 * Create a new document version (replace). Keeps the old active generation
 * until the new ingest job activates — failed replace never clobbers active.
 */
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

	const contentLength = Number(request.headers.get("content-length"));
	const maxBytes = documentUploadMaxBytes();
	if (
		Number.isFinite(contentLength) &&
		contentLength > maxBytes + 1024 * 1024
	) {
		return Response.json({ detail: "upload is too large" }, { status: 413 });
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return Response.json({ detail: "invalid multipart body" }, { status: 400 });
	}
	const upload = form.get("file");
	if (!(upload instanceof File)) {
		return Response.json({ detail: "file is required" }, { status: 400 });
	}
	const validationError = validateDocumentUpload(upload);
	if (validationError) {
		return Response.json({ detail: validationError }, { status: 415 });
	}
	if (upload.size > maxBytes) {
		return Response.json({ detail: "upload is too large" }, { status: 413 });
	}

	const db = getDatabase();
	const [document] = await db
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
		.limit(1);
	if (!document) {
		return Response.json({ detail: "document not found" }, { status: 404 });
	}
	if (document.status === "deleting") {
		return Response.json(
			{ detail: "document is being deleted" },
			{ status: 409 },
		);
	}

	const versionId = randomUUID();
	const generationId = randomUUID();
	const jobId = randomUUID();
	const originalFilename = path
		.basename(upload.name.normalize("NFKC"))
		.slice(0, 512);
	const displayNameValue = form.get("display_name");
	const displayName =
		(typeof displayNameValue === "string" && displayNameValue.trim()) ||
		originalFilename;
	const contentType = contentTypeForUpload(upload);
	const storageKey = documentStorageKey({
		identity,
		libraryId: library.id,
		documentId: document.id,
		versionId,
		filename: originalFilename,
	});
	const storage = documentObjectStorage();
	let stored: Awaited<ReturnType<typeof storage.putFile>>;
	try {
		stored = await storage.putFile(storageKey, upload, {
			maxBytes,
			signal: request.signal,
		});
	} catch (error) {
		const detail =
			error instanceof Error ? error.message : "file storage failed";
		return Response.json(
			{ detail },
			{ status: /exceeds/.test(detail) ? 413 : 400 },
		);
	}

	let created: Awaited<ReturnType<typeof createDocumentVersion>>;
	try {
		created = await createDocumentVersion({
			identity,
			libraryId: library.id,
			documentId: document.id,
			requestId: request.headers.get("x-request-id") ?? randomUUID(),
			ids: { versionId, generationId, jobId },
			source: {
				kind: "upload",
				storageKey: stored.key,
				contentHash: stored.contentHash,
				sizeBytes: stored.sizeBytes,
				filename: originalFilename,
				contentType,
				displayName,
			},
		});
	} catch (error) {
		await storage.delete(stored.key).catch(() => undefined);
		if (error instanceof DocumentVersionCommandError) {
			return Response.json({ detail: error.message }, { status: 409 });
		}
		return Response.json(
			{ detail: "document version transaction failed" },
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
