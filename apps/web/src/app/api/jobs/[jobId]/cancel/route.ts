import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { getDatabase } from "@/db";
import {
	auditLogs,
	documentActiveVersions,
	documents,
	documentVersions,
	jobs,
} from "@/db/schema";
import { TERMINAL_JOB_STATUSES } from "@/lib/document-lifecycle-contract";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { findAuthorizedJob, toApiJob } from "@/lib/server/job-access";
import {
	canWriteLibraries,
	refreshLibraryCounts,
} from "@/lib/server/library-access";

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
	if (TERMINAL_JOB_STATUSES.has(current.job.status)) {
		return Response.json(toApiJob(current));
	}

	const now = new Date();
	const db = getDatabase();
	const changed = await db.transaction(async (tx) => {
		const [locked] = await tx
			.select({ status: jobs.status })
			.from(jobs)
			.where(eq(jobs.id, current.job.id))
			.for("update");
		if (!locked || TERMINAL_JOB_STATUSES.has(locked.status)) return false;
		if (locked.status === "cancelling") return false;

		if (locked.status === "queued" || locked.status === "retry") {
			const [active] = await tx
				.select({ versionId: documentActiveVersions.versionId })
				.from(documentActiveVersions)
				.where(eq(documentActiveVersions.documentId, current.document.id))
				.limit(1);
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
						eq(jobs.id, current.job.id),
						inArray(jobs.status, ["queued", "retry"]),
					),
				);
			await tx
				.update(documentVersions)
				.set({ status: "cancelled", updatedAt: now })
				.where(eq(documentVersions.id, current.version.id));
			await tx
				.update(documents)
				.set({
					status: active ? "degraded" : "failed",
					updatedAt: now,
				})
				.where(eq(documents.id, current.document.id));
		} else {
			await tx
				.update(jobs)
				.set({
					status: "cancelling",
					cancelRequestedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						eq(jobs.id, current.job.id),
						inArray(jobs.status, ["running", "cancelling"]),
					),
				);
		}
		await tx.insert(auditLogs).values({
			organizationId: identity.tenantId,
			workspaceId: identity.workspaceId,
			actorId: identity.principalId,
			action: "job.cancel_requested",
			resourceType: "job",
			resourceId: current.job.id,
			requestId: request.headers.get("x-request-id") ?? randomUUID(),
			details: {
				document_id: current.document.id,
				document_version_id: current.version.id,
				previous_status: locked.status,
			},
		});
		return true;
	});
	if (!changed) {
		const latest = await findAuthorizedJob(identity, jobId);
		return latest
			? Response.json(toApiJob(latest))
			: Response.json({ detail: "job not found" }, { status: 404 });
	}
	await refreshLibraryCounts(current.library.id);
	const row = await findAuthorizedJob(identity, jobId);
	return row
		? Response.json(toApiJob(row), {
				status: row.job.status === "cancelling" ? 202 : 200,
			})
		: Response.json({ detail: "job not found" }, { status: 404 });
}
