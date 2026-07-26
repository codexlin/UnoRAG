import { NextResponse } from "next/server";

import { resolveRequestSession } from "@/lib/server/auth/session";
import { canManageMembers } from "@/lib/server/workspace-permissions.mjs";
import {
	getWorkspaceAskSettings,
	patchWorkspaceAskSettings,
} from "@/lib/server/workspace-settings";

export async function GET(request: Request) {
	const identity = await resolveRequestSession(request);
	if (!identity) {
		return NextResponse.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}
	const payload = await getWorkspaceAskSettings(identity.workspaceId);
	return NextResponse.json({
		ask: payload.ask,
		defaults: payload.defaults,
		policy_version: payload.policy_version,
		updated_at: payload.updated_at,
		updated_by: payload.updated_by,
		can_manage: canManageMembers(identity),
	});
}

export async function PATCH(request: Request) {
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
	let body: { ask?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return NextResponse.json({ detail: "invalid JSON body" }, { status: 400 });
	}
	const result = await patchWorkspaceAskSettings(
		identity.workspaceId,
		body.ask,
		identity.principalId,
	);
	if (!result.ok) {
		return NextResponse.json(
			{ detail: result.detail },
			{ status: result.status },
		);
	}
	return NextResponse.json({
		ask: result.ask,
		defaults: result.defaults,
		policy_version: result.policy_version,
		updated_at: result.updated_at,
		updated_by: result.updated_by,
		can_manage: true,
	});
}
