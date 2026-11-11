import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveRequestSession } from "@/lib/server/auth/session";
import {
	createWorkspaceInvite,
	inviteEmailSchema,
	limitInviteRequest,
	listWorkspaceInvites,
	readInviteJson,
} from "@/lib/server/invites";
import { canManageMembers } from "@/lib/server/workspace-permissions.mjs";

const createSchema = z.strictObject({
	email: inviteEmailSchema,
	role: z.enum(["viewer", "editor", "admin"]).default("viewer"),
	send_email: z.boolean().optional(),
});

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
	const body = await readInviteJson(request);
	if (body instanceof Response) return body;
	const parsed = createSchema.safeParse(body);
	if (!parsed.success)
		return NextResponse.json(
			{ detail: "invalid invite parameters" },
			{ status: 400 },
		);
	const limited = await limitInviteRequest(
		request,
		"create",
		identity.principalId,
	);
	if (limited) return limited;
	const origin = new URL(request.url).origin;
	const result = await createWorkspaceInvite({
		identity,
		email: parsed.data.email,
		role: parsed.data.role,
		origin,
		sendEmail: parsed.data.send_email !== false,
	});
	if (!result.ok) {
		return NextResponse.json(
			{ detail: result.detail },
			{ status: result.status },
		);
	}
	return NextResponse.json(result.invite, {
		status: 201,
		headers: { "Cache-Control": "private, no-store" },
	});
}
