import { NextResponse } from "next/server";

import {
	createSessionToken,
	localIdentityProvider,
	resolveRequestSession,
	SESSION_COOKIE,
} from "@/lib/server/auth/session";

const COOKIE_OPTIONS = {
	httpOnly: true,
	sameSite: "lax" as const,
	secure: process.env.NODE_ENV === "production",
	path: "/",
	maxAge: 8 * 60 * 60,
};

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
		COOKIE_OPTIONS,
	);
	return response;
}

export async function DELETE() {
	const response = NextResponse.json({ ok: true });
	response.cookies.set(SESSION_COOKIE, "", { ...COOKIE_OPTIONS, maxAge: 0 });
	return response;
}
