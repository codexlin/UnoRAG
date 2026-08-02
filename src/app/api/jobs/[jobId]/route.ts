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
	const row = await findAuthorizedJob(identity, jobId);
	if (!row) {
		return Response.json({ detail: "job not found" }, { status: 404 });
	}
	return Response.json(toApiJob(row));
}
