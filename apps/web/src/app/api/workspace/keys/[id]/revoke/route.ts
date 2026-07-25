import { NextResponse } from "next/server";

import { resolveRequestSession } from "@/lib/server/auth/session";
import { revokeWorkspaceServiceKey } from "@/lib/server/service-keys";
import { canManageMembers } from "@/lib/server/workspace-permissions.mjs";

type RouteContext = { params: Promise<{ id: string }> };

/** POST /api/workspace/keys/:id/revoke — alias of DELETE /api/workspace/keys/:id */
export async function POST(request: Request, context: RouteContext) {
	const identity = await resolveRequestSession(request);
	if (!identity) {
		return NextResponse.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}
	if (!canManageMembers(identity)) {
		return NextResponse.json({ detail: "forbidden" }, { status: 403 });
	}
	const { id } = await context.params;
	const result = await revokeWorkspaceServiceKey({ identity, keyId: id });
	if (!result.ok) {
		return NextResponse.json({ detail: result.detail }, { status: result.status });
	}
	return NextResponse.json({ ok: true, revoked: true });
}
