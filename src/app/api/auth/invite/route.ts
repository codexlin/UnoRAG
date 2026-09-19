import { NextResponse } from "next/server";

import { logger } from "@/lib/observability";
import {
	issueSessionToken,
	SESSION_COOKIE,
	sessionCookieOptions,
} from "@/lib/server/auth/session";
import { acceptInvite, previewInvite } from "@/lib/server/invites";

export async function GET(request: Request) {
	const token = new URL(request.url).searchParams.get("token")?.trim() ?? "";
	if (!token) {
		return NextResponse.json({ detail: "token is required" }, { status: 400 });
	}
	const preview = await previewInvite(token);
	if (!preview) {
		return NextResponse.json({ detail: "invite not found" }, { status: 404 });
	}
	return NextResponse.json(preview);
}

export async function POST(request: Request) {
	let body: { token?: string; password?: string; display_name?: string };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return NextResponse.json({ detail: "invalid JSON body" }, { status: 400 });
	}
	const result = await acceptInvite({
		rawToken: body.token?.trim() ?? "",
		password: body.password ?? "",
		displayName: body.display_name,
	});
	if (!result.ok) {
		return NextResponse.json(
			{ detail: result.detail },
			{ status: result.status },
		);
	}
	let token: string;
	try {
		token = await issueSessionToken(result.identity);
	} catch (error) {
		logger.error({
			event: "auth.invite.session_issue_failed",
			component: "redis",
			error,
		});
		return NextResponse.json(
			{ ...result.identity, session_created: false },
			{ status: 201 },
		);
	}
	const response = NextResponse.json({
		...result.identity,
		session_created: true,
	});
	response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
	return response;
}
