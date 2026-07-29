import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, ne, sql } from "drizzle-orm";

import type { getDatabase } from "@/db";
import {
	auditLogs,
	documents,
	documentVersions,
	jobs,
	libraries,
} from "@/db/schema";
import {
	buildDocumentDeletePayload,
	documentDeleteIdempotencyKey,
} from "@/lib/server/document-delete-core.mjs";

export type DeleteEnqueueResult = {
	alreadyQueued: boolean;
	documentId: string;
	ragDocumentId: string;
	jobId: string;
};

type Database = ReturnType<typeof getDatabase>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Cancel open ingest jobs and mark versions deleting (idempotent re-assert). */
async function reassertDocumentDeletingSideEffects(
	tx: Tx,
	documentId: string,
	now: Date,
): Promise<void> {
	const versions = await tx
		.select({
			id: documentVersions.id,
		})
		.from(documentVersions)
		.where(eq(documentVersions.documentId, documentId));
	const versionIds = versions.map((version: { id: string }) => version.id);
	if (versionIds.length === 0) return;

	await tx
		.update(jobs)
		.set({
			status: "cancelled",
			stage: "done",
			finishedAt: now,
			cancelRequestedAt: now,
			updatedAt: now,
			errorCode: "document_deleting",
			error: "cancelled because document is being deleted",
		})
		.where(
			and(
				inArray(jobs.documentVersionId, versionIds),
				inArray(jobs.status, ["queued", "retry"]),
				eq(jobs.type, "document.ingest"),
			),
		);
	await tx
		.update(jobs)
		.set({
			status: "cancelling",
			cancelRequestedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				inArray(jobs.documentVersionId, versionIds),
				inArray(jobs.status, ["running", "cancelling"]),
				eq(jobs.type, "document.ingest"),
			),
		);
	await tx
		.update(documentVersions)
		.set({ status: "deleting", updatedAt: now })
		.where(
			and(
				eq(documentVersions.documentId, documentId),
				ne(documentVersions.status, "deleted"),
			),
		);
}

/** Mark document deleting and enqueue a document.delete job (idempotent). */
export async function enqueueDocumentDelete(input: {
	tx: Tx;
	identity: {
		tenantId: string;
		workspaceId: string;
		principalId: string;
	};
	library: {
		id: string;
		ragLibraryId: string;
	};
	document: typeof documents.$inferSelect;
	libraryDelete?: boolean;
	requestId: string;
	now: Date;
}): Promise<DeleteEnqueueResult> {
	const {
		tx,
		identity,
		library,
		document,
		libraryDelete = false,
		requestId,
		now,
	} = input;
	const idempotencyKey = documentDeleteIdempotencyKey(document.id);
	const [existingJob] = await tx
		.select()
		.from(jobs)
		.where(
			and(
				eq(jobs.organizationId, identity.tenantId),
				eq(jobs.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);
	if (existingJob) {
		// Re-assert tombstone side effects: a prior enqueue may have raced with
		// a late ingest claim, or document status may have been cleared.
		await reassertDocumentDeletingSideEffects(tx, document.id, now);
		if (document.status !== "deleting") {
			await tx
				.update(documents)
				.set({
					status: "deleting",
					deletedAt: document.deletedAt ?? now,
					latestJobId: existingJob.id,
					updatedAt: now,
				})
				.where(eq(documents.id, document.id));
		} else if (document.latestJobId !== existingJob.id) {
			await tx
				.update(documents)
				.set({
					latestJobId: existingJob.id,
					updatedAt: now,
				})
				.where(eq(documents.id, document.id));
		}
		return {
			alreadyQueued: true,
			documentId: document.id,
			ragDocumentId: document.ragDocumentId,
			jobId: existingJob.id,
		};
	}

	const versions = await tx
		.select({
			id: documentVersions.id,
			generationId: documentVersions.generationId,
			storageKey: documentVersions.storageKey,
		})
		.from(documentVersions)
		.where(eq(documentVersions.documentId, document.id));

	await reassertDocumentDeletingSideEffects(tx, document.id, now);

	const jobId = randomUUID();
	const storageKeys: string[] = [
		...new Set(
			versions
				.map((version) => version.storageKey)
				.filter((key): key is string => Boolean(key)),
		),
	];
	const generationIds: string[] = [
		...new Set(versions.map((version) => version.generationId)),
	];

	await tx.insert(jobs).values({
		id: jobId,
		organizationId: identity.tenantId,
		workspaceId: identity.workspaceId,
		documentVersionId: document.desiredVersionId,
		type: "document.delete",
		status: "queued",
		stage: "accepted",
		idempotencyKey,
		payload: buildDocumentDeletePayload({
			documentId: document.id,
			ragDocumentId: document.ragDocumentId,
			libraryId: library.id,
			ragLibraryId: library.ragLibraryId,
			storageKeys,
			generationIds,
			libraryDelete,
		}),
		createdAt: now,
		updatedAt: now,
	});

	await tx
		.update(documents)
		.set({
			status: "deleting",
			deletedAt: now,
			latestJobId: jobId,
			updatedAt: now,
		})
		.where(eq(documents.id, document.id));

	if (!libraryDelete) {
		const wasReady = document.status === "ready";
		await tx
			.update(libraries)
			.set({
				docCount: sql`greatest(${libraries.docCount} - 1, 0)`,
				readyCount: wasReady
					? sql`greatest(${libraries.readyCount} - 1, 0)`
					: libraries.readyCount,
				status: sql`case
					when greatest(${libraries.docCount} - 1, 0) = 0 then 'empty'
					when greatest(${libraries.readyCount} - ${wasReady ? 1 : 0}, 0)
						= greatest(${libraries.docCount} - 1, 0) then 'ready'
					else 'indexing'
				end`,
				updatedAt: now,
			})
			.where(eq(libraries.id, library.id));
	}

	await tx.insert(auditLogs).values({
		organizationId: identity.tenantId,
		workspaceId: identity.workspaceId,
		actorId: identity.principalId,
		action: "document.delete_requested",
		resourceType: "document",
		resourceId: document.id,
		requestId,
		details: {
			library_id: library.ragLibraryId,
			rag_document_id: document.ragDocumentId,
			job_id: jobId,
			storage_key_count: storageKeys.length,
			generation_count: generationIds.length,
			library_delete: libraryDelete,
		},
	});

	return {
		alreadyQueued: false,
		documentId: document.id,
		ragDocumentId: document.ragDocumentId,
		jobId,
	};
}
