import { NextResponse } from "next/server";

import { resolveRequestSession } from "@/lib/server/auth/session";
import { revokeWorkspaceInvite } from "@/lib/server/invites";
import { canManageMembers } from "@/lib/server/workspace-permissions.mjs";

type Params = { params: Promise<{ inviteId: string }> };

export async function DELETE(request: Request, { params }: Params) {
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
	const { inviteId } = await params;
	const result = await revokeWorkspaceInvite({ identity, inviteId });
	if (!result.ok) {
		return NextResponse.json(
			{ detail: result.detail },
			{ status: result.status },
		);
	}
	return NextResponse.json({ ok: true });
}
