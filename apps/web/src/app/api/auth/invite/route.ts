import { NextResponse } from "next/server";

import {
	createSessionToken,
	SESSION_COOKIE,
} from "@/lib/server/auth/session";
import { acceptInvite, previewInvite } from "@/lib/server/invites";

const COOKIE_OPTIONS = {
	httpOnly: true,
	sameSite: "lax" as const,
	secure: process.env.NODE_ENV === "production",
	path: "/",
	maxAge: 8 * 60 * 60,
};

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
		return NextResponse.json({ detail: result.detail }, { status: result.status });
	}
	const response = NextResponse.json(result.identity);
	response.cookies.set(
		SESSION_COOKIE,
		createSessionToken(result.identity),
		COOKIE_OPTIONS,
	);
	return response;
}
