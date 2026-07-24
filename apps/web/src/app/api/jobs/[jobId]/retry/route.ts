import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

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
import { findAuthorizedJob, toApiJob } from "@/lib/server/job-access";
import { canWriteLibraries } from "@/lib/server/library-access";
import { localObjectStorage } from "@/lib/server/object-storage/local";

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
	if (!RETRYABLE_JOB_STATUSES.has(current.job.status)) {
		return Response.json(
			{ detail: `job cannot be retried from ${current.job.status}` },
			{ status: 409 },
		);
	}
	if (!(await localObjectStorage().exists(current.version.storageKey))) {
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
		const [locked] = await tx
			.select({ status: jobs.status, result: jobs.result })
			.from(jobs)
			.where(eq(jobs.id, current.job.id))
			.for("update");
		if (!locked || !RETRYABLE_JOB_STATUSES.has(locked.status)) return null;
		const previousResult =
			locked.result && typeof locked.result === "object"
				? (locked.result as Record<string, unknown>)
				: {};
		if (typeof previousResult.retry_job_id === "string") return null;

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
			.where(eq(documentVersions.id, current.version.id));
		const [newJob] = await tx
			.insert(jobs)
			.values({
				id: newJobId,
				organizationId: identity.tenantId,
				workspaceId: identity.workspaceId,
				documentVersionId: current.version.id,
				type: current.job.type,
				status: "queued",
				stage: "accepted",
				idempotencyKey: `document.ingest:${current.version.id}:${generationId}:${current.version.pipelineVersion}`,
				payload: {
					...(current.job.payload as Record<string, unknown>),
					generation_id: generationId,
					retry_of_job_id: current.job.id,
				},
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
			.where(eq(jobs.id, current.job.id));
		await tx
			.update(documents)
			.set({
				status: "processing",
				desiredVersionId: current.version.id,
				latestJobId: newJob.id,
				updatedAt: now,
			})
			.where(eq(documents.id, current.document.id));
		await tx
			.update(libraries)
			.set({ status: "indexing", updatedAt: now })
			.where(eq(libraries.id, current.library.id));
		await tx.insert(auditLogs).values({
			organizationId: identity.tenantId,
			workspaceId: identity.workspaceId,
			actorId: identity.principalId,
			action: "job.retried",
			resourceType: "job",
			resourceId: newJob.id,
			details: {
				retry_of_job_id: current.job.id,
				document_id: current.document.id,
				document_version_id: current.version.id,
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
