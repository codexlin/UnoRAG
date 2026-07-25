import { NextResponse } from "next/server";

import { resolveRequestSession } from "@/lib/server/auth/session";
import {
	createWorkspaceInvite,
	listWorkspaceInvites,
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
	if (!canManageMembers(identity)) {
		return NextResponse.json({ detail: "forbidden" }, { status: 403 });
	}
	const invites = await listWorkspaceInvites(identity.workspaceId);
	return NextResponse.json({ invites });
}

export async function POST(request: Request) {
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
	let body: { email?: string; role?: string; send_email?: boolean };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return NextResponse.json({ detail: "invalid JSON body" }, { status: 400 });
	}
	const origin = new URL(request.url).origin;
	const result = await createWorkspaceInvite({
		identity,
		email: body.email ?? "",
		role: body.role ?? "viewer",
		origin,
		sendEmail: body.send_email !== false,
	});
	if (!result.ok) {
		return NextResponse.json({ detail: result.detail }, { status: result.status });
	}
	return NextResponse.json(result.invite, { status: 201 });
}
