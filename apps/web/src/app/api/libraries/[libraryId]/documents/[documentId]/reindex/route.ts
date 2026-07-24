import { randomUUID } from "node:crypto";

import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { getDatabase } from "@/db";
import {
	auditLogs,
	documentActiveVersions,
	documents,
	documentVersions,
	jobs,
	libraries,
} from "@/db/schema";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { documentLifecycleV2Enabled } from "@/lib/server/document-lifecycle";
import {
	buildDocumentIngestPayload,
	documentIngestIdempotencyKey,
	nextDocumentVersionNumber,
} from "@/lib/server/document-version-core.mjs";
import {
	canWriteLibraries,
	findAuthorizedLibrary,
	refreshLibraryCounts,
} from "@/lib/server/library-access";

export const runtime = "nodejs";

type RouteContext = {
	params: Promise<{ libraryId: string; documentId: string }>;
};

/**
 * Reindex by creating a new document version that reuses the source object's
 * storage_key/content_hash (roadmap §7.3). Does not call FastAPI/ARQ.
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
	if (document.status === "processing") {
		return Response.json(
			{ detail: "document is already processing" },
			{ status: 409 },
		);
	}

	const [active] = await db
		.select({ versionId: documentActiveVersions.versionId })
		.from(documentActiveVersions)
		.where(eq(documentActiveVersions.documentId, document.id))
		.limit(1);
	const sourceVersionId = document.desiredVersionId ?? active?.versionId;
	if (!sourceVersionId) {
		return Response.json(
			{ detail: "document has no version to reindex" },
			{ status: 409 },
		);
	}
	const [sourceVersion] = await db
		.select()
		.from(documentVersions)
		.where(
			and(
				eq(documentVersions.id, sourceVersionId),
				eq(documentVersions.documentId, document.id),
			),
		)
		.limit(1);
	if (!sourceVersion?.storageKey || !sourceVersion.contentHash) {
		return Response.json(
			{ detail: "原文未保留，请重新上传" },
			{ status: 409 },
		);
	}

	const versionId = randomUUID();
	const generationId = randomUUID();
	const jobId = randomUUID();
	const now = new Date();
	let versionNumber = 1;

	try {
		await db.transaction(async (tx) => {
			const [locked] = await tx
				.select()
				.from(documents)
				.where(eq(documents.id, document.id))
				.for("update");
			if (
				!locked ||
				locked.status === "deleted" ||
				locked.status === "deleting" ||
				locked.status === "processing"
			) {
				throw new Error("document unavailable");
			}

			const [maxRow] = await tx
				.select({
					maxVersion: sql<number>`coalesce(max(${documentVersions.version}), 0)`,
				})
				.from(documentVersions)
				.where(eq(documentVersions.documentId, document.id));
			versionNumber = nextDocumentVersionNumber(maxRow?.maxVersion);

			const queuedVersions = await tx
				.select({ id: documentVersions.id })
				.from(documentVersions)
				.innerJoin(jobs, eq(jobs.documentVersionId, documentVersions.id))
				.where(
					and(
						eq(documentVersions.documentId, document.id),
						inArray(jobs.status, ["queued", "retry"]),
					),
				);
			const queuedVersionIds = queuedVersions.map(
				(row: { id: string }) => row.id,
			);
			if (queuedVersionIds.length > 0) {
				await tx
					.update(jobs)
					.set({
						status: "cancelled",
						stage: "done",
						cancelRequestedAt: now,
						finishedAt: now,
						updatedAt: now,
					})
					.where(
						and(
							inArray(jobs.documentVersionId, queuedVersionIds),
							inArray(jobs.status, ["queued", "retry"]),
						),
					);
				await tx
					.update(documentVersions)
					.set({ status: "superseded", supersededAt: now, updatedAt: now })
					.where(
						and(
							inArray(documentVersions.id, queuedVersionIds),
							inArray(documentVersions.status, [
								"pending",
								"processing",
								"indexed",
								"activating",
							]),
						),
					);
			}

			const runningJobs = await tx
				.select({ id: jobs.id })
				.from(jobs)
				.innerJoin(
					documentVersions,
					eq(documentVersions.id, jobs.documentVersionId),
				)
				.where(
					and(
						eq(documentVersions.documentId, document.id),
						eq(jobs.status, "running"),
					),
				);
			if (runningJobs.length > 0) {
				await tx
					.update(jobs)
					.set({
						status: "cancelling",
						cancelRequestedAt: now,
						updatedAt: now,
					})
					.where(
						and(
							inArray(
								jobs.id,
								runningJobs.map((row: { id: string }) => row.id),
							),
							eq(jobs.status, "running"),
						),
					);
			}

			await tx.insert(documentVersions).values({
				id: versionId,
				documentId: document.id,
				version: versionNumber,
				generationId,
				contentHash: sourceVersion.contentHash,
				storageKey: sourceVersion.storageKey,
				sizeBytes: sourceVersion.sizeBytes,
				status: "pending",
				pipelineVersion: "document-lifecycle-v2",
				createdAt: now,
				updatedAt: now,
			});
			await tx.insert(jobs).values({
				id: jobId,
				organizationId: identity.tenantId,
				workspaceId: identity.workspaceId,
				documentVersionId: versionId,
				type: "document.ingest",
				status: "queued",
				stage: "accepted",
				idempotencyKey: documentIngestIdempotencyKey(versionId, generationId),
				payload: buildDocumentIngestPayload({
					documentId: document.id,
					versionId,
					generationId,
					ragLibraryId: library.ragLibraryId,
					storageKey: sourceVersion.storageKey,
					contentHash: sourceVersion.contentHash,
					filename: document.filename,
					contentType: document.contentType,
				}),
				createdAt: now,
				updatedAt: now,
			});
			await tx
				.update(documents)
				.set({
					status: "processing",
					desiredVersionId: versionId,
					latestJobId: jobId,
					updatedAt: now,
				})
				.where(eq(documents.id, document.id));
			await tx
				.update(libraries)
				.set({
					status: "indexing",
					updatedAt: now,
				})
				.where(eq(libraries.id, library.id));
			await tx.insert(auditLogs).values({
				organizationId: identity.tenantId,
				workspaceId: identity.workspaceId,
				actorId: identity.principalId,
				action: "document.reindex_requested",
				resourceType: "document",
				resourceId: document.id,
				requestId: request.headers.get("x-request-id") ?? randomUUID(),
				details: {
					library_id: library.ragLibraryId,
					document_version_id: versionId,
					generation_id: generationId,
					job_id: jobId,
					version: versionNumber,
					source_version_id: sourceVersion.id,
					content_hash: sourceVersion.contentHash,
					reused_storage_key: true,
				},
			});
		});
	} catch {
		return Response.json(
			{ detail: "document reindex transaction failed" },
			{ status: 500 },
		);
	}

	await refreshLibraryCounts(library.id).catch(() => undefined);

	return Response.json(
		{
			library_id: library.ragLibraryId,
			doc_id: document.ragDocumentId,
			document_id: document.ragDocumentId,
			document_version_id: versionId,
			generation_id: generationId,
			job_id: jobId,
			version: versionNumber,
			title: document.name,
			filename: document.filename,
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
