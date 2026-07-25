import { NextResponse } from "next/server";

import { resolveRequestSession } from "@/lib/server/auth/session";
import {
	createWorkspaceServiceKey,
	listWorkspaceServiceKeys,
} from "@/lib/server/service-keys";
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
	const keys = await listWorkspaceServiceKeys(identity.workspaceId);
	return NextResponse.json({ keys });
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
	let body: {
		name?: string;
		scopes?: string[];
		library_ids?: string[] | null;
	};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return NextResponse.json({ detail: "invalid JSON body" }, { status: 400 });
	}
	const result = await createWorkspaceServiceKey({
		identity,
		name: body.name ?? "",
		scopes: body.scopes,
		libraryIds: body.library_ids,
	});
	if (!result.ok) {
		return NextResponse.json({ detail: result.detail }, { status: result.status });
	}
	return NextResponse.json(result.key, { status: 201 });
}
