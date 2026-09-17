import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type * as schema from "@/db/schema";
import {
	auditLogs,
	documents,
	documentVersions,
	jobs,
	libraries,
} from "@/db/schema";
import { buildDocumentDeletePayload } from "@/lib/server/document-delete-core.mjs";
import { documentDeleteExecutionIdentity } from "@/lib/server/document-lifecycle-flag.mjs";

type Database = NodePgDatabase<typeof schema>;

export class DocumentDeleteRetryError extends Error {
	constructor(
		readonly code: "not_retryable" | "stale_scope",
		message: string,
	) {
		super(message);
		this.name = "DocumentDeleteRetryError";
	}
}

export type DocumentDeleteRetryResult = {
	jobId: string;
	previousJobId: string;
	documentId: string;
	libraryId: string;
};

/**
 * Create a fresh durable workflow for a terminal document.delete job.
 * The document latest-job CAS makes retries idempotent across the UI and CLI.
 */
export async function retryFailedDocumentDelete(
	db: Database,
	input: {
		previousJobId: string;
		organizationId?: string;
		workspaceId?: string;
		actorId?: string | null;
		requestId?: string | null;
		now?: Date;
	},
): Promise<DocumentDeleteRetryResult> {
	const jobId = randomUUID();
	const now = input.now ?? new Date();
	return db.transaction(async (tx) => {
		const [candidate] = await tx
			.select({
				organizationId: jobs.organizationId,
				workspaceId: jobs.workspaceId,
				documentVersionId: documentVersions.id,
				documentId: documents.id,
				libraryId: documents.libraryId,
				ragDocumentId: documents.ragDocumentId,
				ragLibraryId: libraries.ragLibraryId,
				libraryStatus: libraries.status,
				libraryDelete: sql<boolean>`${jobs.payload} ->> 'library_delete' = 'true'`,
			})
			.from(jobs)
			.innerJoin(
				documentVersions,
				eq(documentVersions.id, jobs.documentVersionId),
			)
			.innerJoin(
				documents,
				and(
					eq(documents.id, documentVersions.documentId),
					eq(documents.organizationId, jobs.organizationId),
					eq(documents.workspaceId, jobs.workspaceId),
				),
			)
			.innerJoin(
				libraries,
				and(
					eq(libraries.id, documents.libraryId),
					eq(libraries.organizationId, jobs.organizationId),
					eq(libraries.workspaceId, jobs.workspaceId),
				),
			)
			.where(
				and(
					eq(jobs.id, input.previousJobId),
					eq(jobs.type, "document.delete"),
					eq(jobs.executionEngine, "dbos"),
					inArray(jobs.status, ["failed", "dead", "cancelled"]),
					input.organizationId
						? eq(jobs.organizationId, input.organizationId)
						: undefined,
					input.workspaceId
						? eq(jobs.workspaceId, input.workspaceId)
						: undefined,
				),
			)
			.limit(1);
		if (!candidate) {
			throw new DocumentDeleteRetryError(
				"not_retryable",
				"Document delete retry requires a terminal job with persisted scope",
			);
		}

		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${candidate.libraryId}::text, 0))`,
		);
		const [lockedLibrary] = await tx
			.select({ id: libraries.id })
			.from(libraries)
			.where(
				and(
					eq(libraries.id, candidate.libraryId),
					eq(libraries.organizationId, candidate.organizationId),
					eq(libraries.workspaceId, candidate.workspaceId),
				),
			)
			.for("update")
			.limit(1);
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${candidate.documentId}::text, 0))`,
		);
		const [lockedDocument] = await tx
			.select({ id: documents.id })
			.from(documents)
			.where(
				and(
					eq(documents.id, candidate.documentId),
					eq(documents.organizationId, candidate.organizationId),
					eq(documents.workspaceId, candidate.workspaceId),
					eq(documents.libraryId, candidate.libraryId),
					eq(documents.latestJobId, input.previousJobId),
					eq(documents.status, "deleting"),
				),
			)
			.for("update")
			.limit(1);
		if (!lockedLibrary || !lockedDocument) {
			throw new DocumentDeleteRetryError(
				"stale_scope",
				"Document delete retry requires its original deleting scope",
			);
		}

		const targets = await tx
			.select({
				generationId: documentVersions.generationId,
				storageKey: documentVersions.storageKey,
			})
			.from(documentVersions)
			.where(eq(documentVersions.documentId, candidate.documentId))
			.orderBy(documentVersions.version, documentVersions.id);
		const payload = {
			...buildDocumentDeletePayload({
				documentId: candidate.documentId,
				ragDocumentId: candidate.ragDocumentId,
				libraryId: candidate.libraryId,
				ragLibraryId: candidate.ragLibraryId,
				storageKeys: [
					...new Set(
						targets
							.map((target) => target.storageKey)
							.filter((key): key is string => Boolean(key)),
					),
				],
				generationIds: [
					...new Set(targets.map((target) => target.generationId)),
				],
				libraryDelete:
					candidate.libraryStatus === "deleting" || candidate.libraryDelete,
			}),
			retry_of_job_id: input.previousJobId,
		};
		const execution = documentDeleteExecutionIdentity(jobId);
		await tx.insert(jobs).values({
			id: jobId,
			organizationId: candidate.organizationId,
			workspaceId: candidate.workspaceId,
			documentVersionId: candidate.documentVersionId,
			type: "document.delete",
			executionEngine: execution.executionEngine,
			workflowId: execution.workflowId,
			status: "queued",
			stage: "cleanup",
			idempotencyKey: `document.delete:retry:${jobId}`,
			payload,
			createdAt: now,
			updatedAt: now,
		});
		const updated = await tx
			.update(documents)
			.set({ latestJobId: jobId, updatedAt: now })
			.where(
				and(
					eq(documents.id, candidate.documentId),
					eq(documents.latestJobId, input.previousJobId),
					eq(documents.status, "deleting"),
				),
			)
			.returning({ id: documents.id });
		if (updated.length !== 1) {
			throw new DocumentDeleteRetryError(
				"stale_scope",
				"Document delete retry lost its document ownership",
			);
		}
		await tx
			.update(jobs)
			.set({
				result: sql`coalesce(${jobs.result}, '{}'::jsonb) || jsonb_build_object('retry_job_id', ${jobId}::text)`,
				updatedAt: now,
			})
			.where(eq(jobs.id, input.previousJobId));
		await tx.insert(auditLogs).values({
			organizationId: candidate.organizationId,
			workspaceId: candidate.workspaceId,
			actorId: input.actorId ?? null,
			action: "job.retried",
			resourceType: "job",
			resourceId: jobId,
			requestId: input.requestId ?? null,
			details: {
				retry_of_job_id: input.previousJobId,
				job_type: "document.delete",
				document_id: candidate.documentId,
				library_id: candidate.libraryId,
			},
			createdAt: now,
		});
		return {
			jobId,
			previousJobId: input.previousJobId,
			documentId: candidate.documentId,
			libraryId: candidate.libraryId,
		};
	});
}
