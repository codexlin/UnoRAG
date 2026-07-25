import { NextResponse } from "next/server";

import { resolveRequestSession } from "@/lib/server/auth/session";
import { authorizeAuditAccess } from "@/lib/server/workspace-audit.mjs";
import { exportWorkspaceAuditCsv } from "@/lib/server/workspace-audit-db";

export async function GET(request: Request) {
	const identity = await resolveRequestSession(request);
	const auth = authorizeAuditAccess(identity);
	if (!auth.ok || !identity) {
		return NextResponse.json(
			{ detail: auth.ok ? "authentication required" : auth.detail },
			{ status: auth.ok ? 401 : auth.status },
		);
	}

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
