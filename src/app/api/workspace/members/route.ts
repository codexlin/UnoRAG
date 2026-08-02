import { NextResponse } from "next/server";

import { resolveRequestSession } from "@/lib/server/auth/session";
import {
	listWorkspaceMembers,
	removeWorkspaceMember,
	updateMemberRole,
} from "@/lib/server/invites";
import { canManageMembers } from "@/lib/server/workspace-permissions.mjs";

export async function GET(request: Request) {
	const identity = await resolveRequestSession(request);
	if (!identity) {
		return NextResponse.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}
	const members = await listWorkspaceMembers(identity.workspaceId);
	return NextResponse.json({
		members,
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
	let body: { user_id?: string; role?: string };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return NextResponse.json({ detail: "invalid JSON body" }, { status: 400 });
	}
	const result = await updateMemberRole({
		identity,
		userId: body.user_id ?? "",
		role: body.role ?? "",
	});
	if (!result.ok) {
		return NextResponse.json(
			{ detail: result.detail },
			{ status: result.status },
		);
	}
	return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
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
	let body: { user_id?: string };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return NextResponse.json({ detail: "invalid JSON body" }, { status: 400 });
	}
	const result = await removeWorkspaceMember({
		identity,
		userId: body.user_id ?? "",
	});
	if (!result.ok) {
		return NextResponse.json(
			{ detail: result.detail },
			{ status: result.status },
		);
	}
	return NextResponse.json({ ok: true });
}
