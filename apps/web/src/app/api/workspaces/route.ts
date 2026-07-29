import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { resolveRequestSession } from "@/lib/server/auth/session";
import { canCreateWorkspaces } from "@/lib/server/organization-permissions.mjs";
import { validateWorkspaceIdempotencyKey } from "@/lib/server/workspace-core.mjs";
import {
	createWorkspaceForIdentity,
	listWorkspacesForIdentity,
} from "@/lib/server/workspaces";

export async function GET(request: Request) {
	const identity = await resolveRequestSession(request);
	if (!identity) {
		return NextResponse.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}

	return NextResponse.json({
		items: await listWorkspacesForIdentity(identity),
		can_create: canCreateWorkspaces(identity),
	});
}

export async function POST(request: Request) {
	const identity = await resolveRequestSession(request);
	if (!identity) {
		return NextResponse.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ detail: "invalid JSON body" }, { status: 400 });
	}
	const idempotency = validateWorkspaceIdempotencyKey(
		request.headers.get("idempotency-key") ?? randomUUID(),
	);
	if (!idempotency.ok) {
		return NextResponse.json(
			{ detail: idempotency.detail },
			{ status: idempotency.status },
		);
	}

	const result = await createWorkspaceForIdentity(
		identity,
		body,
		idempotency.value,
	);
	if (!result.ok) {
		return NextResponse.json(
			{ detail: result.detail },
			{ status: result.status },
		);
	}
	return NextResponse.json(result.workspace, { status: 201 });
}
