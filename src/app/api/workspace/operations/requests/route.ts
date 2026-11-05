import { getDatabase } from "@/db";
import {
	InvalidOperationsRequestsQuery,
	parseOperationsRequestsQuery,
} from "@/lib/operations-requests";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { canManageMembers } from "@/lib/server/workspace-permissions.mjs";
import { OperationsRequestsService } from "@/server/observability/operations-requests-service";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
	try {
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
		const params = new URL(request.url).searchParams;
		parseOperationsRequestsQuery(params);
		const result = await new OperationsRequestsService(getDatabase()).list(
			{ organizationId: identity.tenantId, workspaceId: identity.workspaceId },
			params,
		);
		return Response.json(result, { headers });
	} catch (error) {
		return error instanceof InvalidOperationsRequestsQuery
			? Response.json({ detail: error.message }, { status: 400, headers })
			: Response.json(
					{ detail: "request records unavailable" },
					{ status: 503, headers },
				);
	}
}
