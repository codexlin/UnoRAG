import { NextResponse } from "next/server";
import { isLocalLoginEnabled } from "@/lib/server/auth/config";
import {
	createSessionToken,
	localIdentityProvider,
	resolveRequestSession,
	SESSION_COOKIE,
	sessionCookieOptions,
} from "@/lib/server/auth/session";

export async function GET(request: Request) {
	const identity = await resolveRequestSession(request);
	if (!identity) {
		return NextResponse.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}
	return NextResponse.json(identity);
}

export async function POST(request: Request) {
	if (!isLocalLoginEnabled()) {
		return NextResponse.json(
			{ detail: "local login is disabled" },
			{ status: 404 },
		);
	}
	let body: { email?: string; password?: string; workspace_id?: string };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return NextResponse.json({ detail: "invalid JSON body" }, { status: 400 });
	}
	const email = body.email?.trim().toLowerCase() ?? "";
	const password = body.password ?? "";
	if (!email || !password) {
		return NextResponse.json(
			{ detail: "email and password are required" },
			{ status: 400 },
		);
	}
	const identity = await localIdentityProvider.authenticate({
		email,
		password,
		workspaceId: body.workspace_id,
	});
	if (!identity) {
		return NextResponse.json(
			{ detail: "invalid credentials" },
			{ status: 401 },
		);
	}
	const response = NextResponse.json(identity);
	response.cookies.set(
		SESSION_COOKIE,
		createSessionToken(identity),
		sessionCookieOptions(),
	);
	return response;
}

export async function DELETE() {
	const response = NextResponse.json({ ok: true });
	response.cookies.set(SESSION_COOKIE, "", {
		...sessionCookieOptions(),
		maxAge: 0,
	});
	return response;
}
