import { z } from "zod";

import { getDatabase } from "@/db";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { canManageMembers } from "@/lib/server/workspace-permissions.mjs";
import { OperationsEventService } from "@/server/observability/operations-event-service";

type RouteContext = {
	params: Promise<{ source: string; id: string }>;
};

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request, context: RouteContext) {
	const identity = await resolveRequestSession(request);
	if (!identity) {
		return Response.json(
			{ detail: "authentication required" },
			{ status: 401, headers },
		);
	}
	if (!canManageMembers(identity)) {
		return Response.json({ detail: "forbidden" }, { status: 403, headers });
	}
	const { source, id } = await context.params;
	if (
		(source !== "ask" && source !== "job") ||
		!z.uuid().safeParse(id).success
	) {
		return Response.json(
			{ detail: "event not found" },
			{ status: 404, headers },
		);
	}
	const result = await new OperationsEventService(getDatabase()).read(
		{
			organizationId: identity.tenantId,
			workspaceId: identity.workspaceId,
		},
		source,
		id,
	);
	return result
		? Response.json(result, { headers })
		: Response.json({ detail: "event not found" }, { status: 404, headers });
}
