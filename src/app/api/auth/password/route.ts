import { NextResponse } from "next/server";

import {
	changeLocalPassword,
	createSessionToken,
	resolveRequestSession,
	SESSION_COOKIE,
	sessionCookieOptions,
} from "@/lib/server/auth/session";

export async function POST(request: Request) {
	const identity = await resolveRequestSession(request, {
		allowPasswordChangeRequired: true,
	});
	if (!identity) {
		return NextResponse.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}

	let body: { current_password?: unknown; new_password?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return NextResponse.json({ detail: "invalid JSON body" }, { status: 400 });
	}
	if (
		typeof body.current_password !== "string" ||
		typeof body.new_password !== "string"
	) {
		return NextResponse.json(
			{ detail: "current_password and new_password are required" },
			{ status: 400 },
		);
	}

	const result = await changeLocalPassword({
		identity,
		currentPassword: body.current_password,
		newPassword: body.new_password,
	});
	if (!result.ok) {
		return NextResponse.json(
			{ detail: result.detail },
			{ status: result.status },
		);
	}

	const response = NextResponse.json(result.identity);
	response.cookies.set(
		SESSION_COOKIE,
		createSessionToken(result.identity),
		sessionCookieOptions(),
	);
	return response;
}
