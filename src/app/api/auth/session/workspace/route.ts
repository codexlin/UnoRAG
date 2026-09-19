import { NextResponse } from "next/server";

import { logger } from "@/lib/observability";
import {
	resolveRequestSession,
	rotateSessionToken,
	SESSION_COOKIE,
	sessionCookieOptions,
} from "@/lib/server/auth/session";
import { readSessionClaims } from "@/lib/server/auth/session-token";
import { validateWorkspaceId } from "@/lib/server/workspace-core.mjs";
import { resolveWorkspaceSwitchIdentity } from "@/lib/server/workspaces";

export async function POST(request: Request) {
	const currentIdentity = await resolveRequestSession(request);
	if (!currentIdentity) {
		return NextResponse.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}
	const currentClaims = readSessionClaims(request.headers.get("cookie"));
	if (!currentClaims) {
		return NextResponse.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}

	let body: { workspace_id?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return NextResponse.json({ detail: "invalid JSON body" }, { status: 400 });
	}
	const validated = validateWorkspaceId(body.workspace_id);
	if (!validated.ok) {
		return NextResponse.json(
			{ detail: validated.detail },
			{ status: validated.status },
		);
	}

	const nextIdentity = await resolveWorkspaceSwitchIdentity(
		currentIdentity,
		validated.value,
	);
	if (!nextIdentity) {
		return NextResponse.json(
			{ detail: "workspace not found" },
			{ status: 404 },
		);
	}

	let token: string;
	try {
		token = await rotateSessionToken(nextIdentity, currentClaims);
	} catch (error) {
		logger.error({
			event: "auth.session.workspace_rotation_failed",
			component: "redis",
			error,
		});
		return NextResponse.json(
			{ detail: "session rotation is unavailable" },
			{ status: 503, headers: { "Retry-After": "5" } },
		);
	}
	const response = NextResponse.json(nextIdentity);
	response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
	return response;
}
