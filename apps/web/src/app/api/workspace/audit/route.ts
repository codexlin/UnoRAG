import { NextResponse } from "next/server";

import { resolveRequestSession } from "@/lib/server/auth/session";
import {
	authorizeAuditAccess,
	parseAuditListParams,
} from "@/lib/server/workspace-audit.mjs";
import {
	exportWorkspaceAuditCsv,
	listWorkspaceAuditLogs,
} from "@/lib/server/workspace-audit-db";

export async function GET(request: Request) {
	const identity = await resolveRequestSession(request);
	const auth = authorizeAuditAccess(identity);
	if (!auth.ok || !identity) {
		return NextResponse.json(
			{ detail: auth.ok ? "authentication required" : auth.detail },
			{ status: auth.ok ? 401 : auth.status },
		);
	}

	const url = new URL(request.url);
	const params = parseAuditListParams(url.searchParams);

	if (params.format === "csv") {
		const exported = await exportWorkspaceAuditCsv({
			organizationId: identity.tenantId,
			workspaceId: identity.workspaceId,
		});
		return new NextResponse(exported.body, {
			status: 200,
			headers: {
				"content-type": "text/csv; charset=utf-8",
				"content-disposition": `attachment; filename="${exported.filename}"`,
			},
		});
	}

	const result = await listWorkspaceAuditLogs({
		organizationId: identity.tenantId,
		workspaceId: identity.workspaceId,
		limit: params.limit,
		cursor: params.cursor,
	});
	if (!result.ok) {
		return NextResponse.json(
			{ detail: result.detail },
			{ status: result.status },
		);
	}
	return NextResponse.json({
		items: result.items,
		next_cursor: result.next_cursor,
	});
}
