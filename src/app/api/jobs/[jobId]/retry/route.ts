import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDatabase } from "@/db";
import {
	auditLogs,
	documents,
	documentVersions,
	jobs,
	libraries,
} from "@/db/schema";
import { RETRYABLE_JOB_STATUSES } from "@/lib/document-lifecycle-contract";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { documentIngestExecutionIdentity } from "@/lib/server/document-lifecycle-flag.mjs";
import { findAuthorizedJob, toApiJob } from "@/lib/server/job-access";
import { canWriteLibraries } from "@/lib/server/library-access";
import { documentObjectStorage } from "@/lib/server/object-storage";
import { documentIngestPayloadSchema } from "@/worker/contracts";

type RouteContext = {
	params: Promise<{ jobId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
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
	const { jobId } = await context.params;
	const current = await findAuthorizedJob(identity, jobId);
	if (!current) {
		return Response.json({ detail: "job not found" }, { status: 404 });
	}
	if (current.job.type !== "document.ingest") {
		return Response.json(
			{ detail: "only document ingest jobs can be retried" },
			{ status: 409 },
		);
	}
	const persistedPayload = documentIngestPayloadSchema.safeParse(
		current.job.payload,
	);
	if (
		!persistedPayload.success ||
		persistedPayload.data.document_id !== current.document.id ||
		persistedPayload.data.document_version_id !== current.version.id
	) {
		return Response.json(
			{ detail: "document ingest job payload is invalid" },
			{ status: 409 },
		);
	}
	if (!RETRYABLE_JOB_STATUSES.has(current.job.status)) {
		return Response.json(
			{ detail: `job cannot be retried from ${current.job.status}` },
			{ status: 409 },
		);
	}
	if (!(await documentObjectStorage().exists(current.version.storageKey))) {
		return Response.json(
			{ detail: "source object is no longer available" },
			{ status: 409 },
		);
	}

	const newJobId = randomUUID();
	const generationId = randomUUID();
	const now = new Date();
	const db = getDatabase();
	const retried = await db.transaction(async (tx) => {
		const [lockedLibrary] = await tx
			.select({ id: libraries.id, status: libraries.status })
			.from(libraries)
			.where(
				and(
					eq(libraries.id, current.library.id),
					eq(libraries.organizationId, identity.tenantId),
					eq(libraries.workspaceId, identity.workspaceId),
				),
			)
			.for("update");
		if (
			!lockedLibrary ||
			lockedLibrary.status === "deleting" ||
			lockedLibrary.status === "deleted"
		) {
			return null;
		}

		const [lockedDocument] = await tx
			.select({
				id: documents.id,
				status: documents.status,
				desiredVersionId: documents.desiredVersionId,
				latestJobId: documents.latestJobId,
			})
			.from(documents)
			.where(
				and(
					eq(documents.id, current.document.id),
					eq(documents.libraryId, lockedLibrary.id),
					eq(documents.organizationId, identity.tenantId),
					eq(documents.workspaceId, identity.workspaceId),
				),
			)
			.for("update");
		if (
			!lockedDocument ||
			lockedDocument.status === "deleting" ||
			lockedDocument.status === "deleted" ||
			lockedDocument.desiredVersionId !== current.version.id ||
			lockedDocument.latestJobId !== current.job.id
		) {
			return null;
		}

		const [lockedVersion] = await tx
			.select({ id: documentVersions.id })
			.from(documentVersions)
			.where(
				and(
					eq(documentVersions.id, current.version.id),
					eq(documentVersions.documentId, lockedDocument.id),
				),
			)
			.for("update");
		if (!lockedVersion) return null;

		const [locked] = await tx
			.select({ status: jobs.status, result: jobs.result })
			.from(jobs)
			.where(
				and(
					eq(jobs.id, current.job.id),
					eq(jobs.organizationId, identity.tenantId),
					eq(jobs.workspaceId, identity.workspaceId),
					eq(jobs.documentVersionId, lockedVersion.id),
					eq(jobs.type, "document.ingest"),
				),
			)
			.for("update");
		if (!locked || !RETRYABLE_JOB_STATUSES.has(locked.status)) return null;
		const previousResult =
			locked.result && typeof locked.result === "object"
				? (locked.result as Record<string, unknown>)
				: {};
		if (typeof previousResult.retry_job_id === "string") return null;
		const retryPayload = {
			...persistedPayload.data,
			generation_id: generationId,
			retry_of_job_id: current.job.id,
		};

		await tx
			.update(documentVersions)
			.set({
				generationId,
				status: "pending",
				parserBackend: null,
				parserReport: null,
				pointCount: null,
				chunkCount: null,
				sectionCount: null,
				tableCount: null,
				failureCode: null,
				error: null,
				indexedAt: null,
				activatedAt: null,
				supersededAt: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(documentVersions.id, lockedVersion.id),
					eq(documentVersions.documentId, lockedDocument.id),
				),
			);
		const [newJob] = await tx
			.insert(jobs)
			.values({
				id: newJobId,
				organizationId: identity.tenantId,
				workspaceId: identity.workspaceId,
				documentVersionId: lockedVersion.id,
				type: current.job.type,
				...documentIngestExecutionIdentity(newJobId, retryPayload),
				status: "queued",
				stage: "accepted",
				idempotencyKey: `document.ingest:${current.version.id}:${generationId}:${current.version.pipelineVersion}`,
				payload: retryPayload,
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		await tx
			.update(jobs)
			.set({
				result: { ...previousResult, retry_job_id: newJob.id },
				updatedAt: now,
			})
			.where(
				and(
					eq(jobs.id, current.job.id),
					eq(jobs.documentVersionId, lockedVersion.id),
				),
			);
		const updatedDocument = await tx
			.update(documents)
			.set({
				status: "processing",
				desiredVersionId: lockedVersion.id,
				latestJobId: newJob.id,
				updatedAt: now,
			})
			.where(
				and(
					eq(documents.id, lockedDocument.id),
					eq(documents.libraryId, lockedLibrary.id),
					eq(documents.desiredVersionId, lockedVersion.id),
					eq(documents.latestJobId, current.job.id),
				),
			)
			.returning({ id: documents.id });
		if (updatedDocument.length !== 1) {
			throw new Error("document retry CAS failed after lifecycle locks");
		}
		const updatedLibrary = await tx
			.update(libraries)
			.set({ status: "indexing", updatedAt: now })
			.where(
				and(
					eq(libraries.id, lockedLibrary.id),
					eq(libraries.organizationId, identity.tenantId),
					eq(libraries.workspaceId, identity.workspaceId),
				),
			)
			.returning({ id: libraries.id });
		if (updatedLibrary.length !== 1) {
			throw new Error("library retry CAS failed after lifecycle locks");
		}
		await tx.insert(auditLogs).values({
			organizationId: identity.tenantId,
			workspaceId: identity.workspaceId,
			actorId: identity.principalId,
			action: "job.retried",
			resourceType: "job",
			resourceId: newJob.id,
			details: {
				retry_of_job_id: current.job.id,
				document_id: lockedDocument.id,
				document_version_id: lockedVersion.id,
				generation_id: generationId,
			},
		});
		return newJob;
	});
	if (!retried) {
		return Response.json(
			{ detail: "job state changed before retry" },
			{ status: 409 },
		);
	}
	const row = await findAuthorizedJob(identity, retried.id);
	if (!row) {
		return Response.json({ detail: "retried job not found" }, { status: 500 });
	}
	return Response.json(toApiJob(row), { status: 202 });
}
