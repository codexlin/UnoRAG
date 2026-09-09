import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "@/db";
import { jobStageRuns } from "@/db/schema";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { findAuthorizedJob, toApiJob } from "@/lib/server/job-access";

type RouteContext = {
	params: Promise<{ jobId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
	const identity = await resolveRequestSession(request);
	if (!identity) {
		return Response.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}
	const { jobId } = await context.params;
	if (!z.uuid().safeParse(jobId).success) {
		return Response.json({ detail: "job not found" }, { status: 404 });
	}
	const row = await findAuthorizedJob(identity, jobId);
	if (!row) {
		return Response.json({ detail: "job not found" }, { status: 404 });
	}
	const stages = await getDatabase()
		.select()
		.from(jobStageRuns)
		.where(eq(jobStageRuns.jobId, row.job.id))
		.orderBy(jobStageRuns.sequence);
	return Response.json(toApiJob(row, stages));
}
