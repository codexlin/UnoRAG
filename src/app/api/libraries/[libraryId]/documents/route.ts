import { randomUUID } from "node:crypto";
import path from "node:path";

import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
	auditLogs,
	documents,
	documentVersions,
	jobs,
	libraries,
} from "@/db/schema";
import { resolveRequestSession } from "@/lib/server/auth/session";
import {
	documentLifecycleV2Enabled,
	documentStorageKey,
	validateDocumentUpload,
} from "@/lib/server/document-lifecycle";
import { documentIngestExecutionIdentity } from "@/lib/server/document-lifecycle-flag.mjs";
import {
	DOCUMENT_ACTIVE_JOB_STATUSES,
	DOCUMENT_FAILED_JOB_STATUSES,
	escapeSqlLikePattern,
	parseDocumentListQuery,
	serializeDocumentRow,
} from "@/lib/server/document-list-serializer";
import {
	buildDocumentIngestPayload,
	contentTypeForUpload,
	documentIngestIdempotencyKey,
} from "@/lib/server/document-version-core.mjs";
import { documentMetadataVisibilitySql } from "@/lib/server/document-visibility";
import {
	canWriteLibraries,
	findAuthorizedLibrary,
} from "@/lib/server/library-access";
import {
	documentObjectStorage,
	documentUploadMaxBytes,
} from "@/lib/server/object-storage";

export const runtime = "nodejs";

type RouteContext = {
	params: Promise<{ libraryId: string }>;
};

class LibraryWriteClosedError extends Error {}

export async function GET(request: Request, context: RouteContext) {
	const identity = await resolveRequestSession(request);
	if (!identity) {
		return Response.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}
	const { libraryId } = await context.params;
	const library = await findAuthorizedLibrary(identity, libraryId, {
		allowDeletingForDocumentList: true,
	});
	if (!library) {
		return Response.json({ detail: "library not found" }, { status: 404 });
	}
	const listQuery = parseDocumentListQuery(new URL(request.url));
	const db = getDatabase();
	const baseWhere = and(
		eq(documents.organizationId, identity.tenantId),
		eq(documents.workspaceId, identity.workspaceId),
		eq(documents.libraryId, library.id),
		ne(documents.status, "deleted"),
		documentMetadataVisibilitySql(identity, documents.id),
	);

	const normalizedSearch = listQuery.query
		? `%${escapeSqlLikePattern(listQuery.query.normalize("NFKC").toLowerCase())}%`
		: null;
	const searchFilter = normalizedSearch
		? or(
				sql`lower(normalize(${documents.name}, NFKC)) LIKE ${normalizedSearch} ESCAPE '\\'`,
				sql`lower(normalize(${documents.filename}, NFKC)) LIKE ${normalizedSearch} ESCAPE '\\'`,
			)
		: undefined;
	const taskFilter =
		listQuery.task === "processing"
			? inArray(jobs.status, [...DOCUMENT_ACTIVE_JOB_STATUSES])
			: listQuery.task === "failed"
				? inArray(jobs.status, [...DOCUMENT_FAILED_JOB_STATUSES])
				: undefined;
	const statusFilter = listQuery.status
		? eq(documents.status, listQuery.status)
		: undefined;
	const activeFilter = and(searchFilter, taskFilter, statusFilter);
	const pageWhere = activeFilter ? and(baseWhere, activeFilter) : baseWhere;

	const selectFields = {
		document: {
			id: documents.id,
			ragDocumentId: documents.ragDocumentId,
			name: documents.name,
			filename: documents.filename,
			contentType: documents.contentType,
			status: documents.status,
			createdAt: documents.createdAt,
			updatedAt: documents.updatedAt,
		},
		version: {
			id: documentVersions.id,
			chunkCount: documentVersions.chunkCount,
			sizeBytes: documentVersions.sizeBytes,
			error: documentVersions.error,
			storageKey: documentVersions.storageKey,
			parsePreference: documentVersions.parsePreference,
			generationId: documentVersions.generationId,
			...(listQuery.includeReport
				? { parserReport: documentVersions.parserReport }
				: {}),
		},
		job: {
			id: jobs.id,
			status: jobs.status,
			stage: jobs.stage,
			progress: jobs.progress,
			error: jobs.error,
			...(listQuery.includeReport ? { payload: jobs.payload } : {}),
		},
	};

	const baseRowsQuery = db
		.select(selectFields)
		.from(documents)
		.leftJoin(
			documentVersions,
			eq(documentVersions.id, documents.desiredVersionId),
		)
		.leftJoin(jobs, eq(jobs.id, documents.latestJobId))
		.where(pageWhere)
		.orderBy(desc(documents.updatedAt), desc(documents.id));

	const pagedRowsQuery =
		listQuery.limit !== null
			? baseRowsQuery.limit(listQuery.limit).offset(listQuery.offset)
			: listQuery.offset > 0
				? baseRowsQuery.offset(listQuery.offset)
				: baseRowsQuery;

	if (!listQuery.paginated) {
		const rows = await pagedRowsQuery;
		return Response.json(
			rows.map(({ document, version, job }) =>
				serializeDocumentRow({
					libraryRagId: library.ragLibraryId,
					document,
					version,
					job,
					includeReport: listQuery.includeReport,
				}),
			),
			{ headers: { "cache-control": "no-store" } },
		);
	}

	const [rows, [counts]] = await Promise.all([
		pagedRowsQuery,
		db
			.select({
				total: sql<number>`count(*)::int`,
				completed: sql<number>`count(*) filter (where ${jobs.status} = 'completed')::int`,
				processing: sql<number>`count(*) filter (where ${inArray(jobs.status, [...DOCUMENT_ACTIVE_JOB_STATUSES])})::int`,
				failed: sql<number>`count(*) filter (where ${inArray(jobs.status, [...DOCUMENT_FAILED_JOB_STATUSES])})::int`,
				filteredTotal: activeFilter
					? sql<number>`count(*) filter (where ${activeFilter})::int`
					: sql<number>`count(*)::int`,
			})
			.from(documents)
			.leftJoin(jobs, eq(jobs.id, documents.latestJobId))
			.where(baseWhere),
	]);

	const items = rows.map(({ document, version, job }) =>
		serializeDocumentRow({
			libraryRagId: library.ragLibraryId,
			document,
			version,
			job,
			includeReport: listQuery.includeReport,
		}),
	);
	const total = Number(counts?.total ?? 0);
	const filteredTotal = Number(counts?.filteredTotal ?? 0);
	const limit = listQuery.limit ?? 50;

	return Response.json(
		{
			items,
			total,
			filtered_total: filteredTotal,
			limit,
			offset: listQuery.offset,
			has_more: listQuery.offset + items.length < filteredTotal,
			summary: {
				total,
				completed: Number(counts?.completed ?? 0),
				processing: Number(counts?.processing ?? 0),
				failed: Number(counts?.failed ?? 0),
			},
		},
		{ headers: { "cache-control": "no-store" } },
	);
}

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
	const { libraryId } = await context.params;
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

	const documentId = randomUUID();
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
		documentId,
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

	const db = getDatabase();
	const now = new Date();
	try {
		await db.transaction(async (tx) => {
			const [lockedLibrary] = await tx
				.select()
				.from(libraries)
				.where(
					and(
						eq(libraries.id, library.id),
						eq(libraries.organizationId, identity.tenantId),
						eq(libraries.workspaceId, identity.workspaceId),
					),
				)
				.for("update")
				.limit(1);
			if (
				!lockedLibrary ||
				lockedLibrary.status === "deleting" ||
				lockedLibrary.status === "deleted"
			) {
				throw new LibraryWriteClosedError(
					"library is not accepting document uploads",
				);
			}

			await tx.insert(documents).values({
				id: documentId,
				organizationId: identity.tenantId,
				workspaceId: identity.workspaceId,
				libraryId: library.id,
				ragDocumentId: documentId,
				name: displayName.slice(0, 512),
				filename: originalFilename,
				contentType,
				status: "processing",
				createdBy: identity.principalId,
				createdAt: now,
				updatedAt: now,
			});
			await tx.insert(documentVersions).values({
				id: versionId,
				documentId,
				version: 1,
				generationId,
				contentHash: stored.contentHash,
				storageKey: stored.key,
				sourceFilename: originalFilename,
				sourceContentType: contentType,
				sizeBytes: stored.sizeBytes,
				status: "pending",
				pipelineVersion: "document-lifecycle-v2",
				documentProfile: lockedLibrary.documentProfile ?? "auto",
				scanHandling: lockedLibrary.scanHandling ?? "auto",
				parsePreference: lockedLibrary.parsePreference ?? "auto",
				ingestPolicyVersion: lockedLibrary.ingestPolicyVersion ?? 1,
				createdAt: now,
				updatedAt: now,
			});
			const ingestPayload = buildDocumentIngestPayload({
				documentId,
				versionId,
				generationId,
				ragLibraryId: lockedLibrary.ragLibraryId,
				storageKey: stored.key,
				contentHash: stored.contentHash,
				filename: originalFilename,
				contentType,
				documentProfile: lockedLibrary.documentProfile ?? "auto",
				scanHandling: lockedLibrary.scanHandling ?? "auto",
				parsePreference: lockedLibrary.parsePreference ?? "auto",
				ingestPolicyVersion: lockedLibrary.ingestPolicyVersion ?? 1,
			});
			await tx.insert(jobs).values({
				id: jobId,
				organizationId: identity.tenantId,
				workspaceId: identity.workspaceId,
				documentVersionId: versionId,
				type: "document.ingest",
				...documentIngestExecutionIdentity(jobId, ingestPayload),
				status: "queued",
				stage: "accepted",
				idempotencyKey: documentIngestIdempotencyKey(versionId, generationId),
				payload: ingestPayload,
				createdAt: now,
				updatedAt: now,
			});
			await tx
				.update(documents)
				.set({
					desiredVersionId: versionId,
					latestJobId: jobId,
					updatedAt: now,
				})
				.where(eq(documents.id, documentId));
			await tx.insert(auditLogs).values({
				organizationId: identity.tenantId,
				workspaceId: identity.workspaceId,
				actorId: identity.principalId,
				action: "document.uploaded",
				resourceType: "document",
				resourceId: documentId,
				requestId: request.headers.get("x-request-id") ?? randomUUID(),
				details: {
					library_id: library.ragLibraryId,
					document_version_id: versionId,
					generation_id: generationId,
					job_id: jobId,
					content_hash: stored.contentHash,
					size_bytes: stored.sizeBytes,
				},
			});
			await tx
				.update(libraries)
				.set({
					status: "indexing",
					docCount: sql`${libraries.docCount} + 1`,
					updatedAt: now,
				})
				.where(eq(libraries.id, lockedLibrary.id));
		});
	} catch (error) {
		await storage.delete(stored.key).catch(() => undefined);
		if (error instanceof LibraryWriteClosedError) {
			return Response.json({ detail: error.message }, { status: 409 });
		}
		return Response.json(
			{ detail: "document transaction failed" },
			{ status: 500 },
		);
	}

	return Response.json(
		{
			library_id: library.ragLibraryId,
			doc_id: documentId,
			document_id: documentId,
			document_version_id: versionId,
			generation_id: generationId,
			job_id: jobId,
			title: displayName.slice(0, 512),
			filename: originalFilename,
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
