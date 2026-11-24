import { NextResponse } from "next/server";

import { logger } from "@/lib/observability";
import { consumePasswordChangeRateLimit } from "@/lib/server/auth/login-rate-limit";
import { isSameOriginSessionRequest } from "@/lib/server/auth/same-origin";
import {
	changeLocalPassword,
	replacePrincipalSessionToken,
	resolveRequestSession,
	SESSION_COOKIE,
	sessionCookieOptions,
} from "@/lib/server/auth/session";

export async function POST(request: Request) {
	if (!isSameOriginSessionRequest(request)) {
		return NextResponse.json({ detail: "forbidden" }, { status: 403 });
	}
	const identity = await resolveRequestSession(request, {
		allowPasswordChangeRequired: true,
	});
	if (!identity) {
		return NextResponse.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}

	let body: { current_password?: unknown; new_password?: unknown } | null;
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return NextResponse.json({ detail: "invalid JSON body" }, { status: 400 });
	}
	if (
		typeof body?.current_password !== "string" ||
		typeof body.new_password !== "string"
	) {
		return NextResponse.json(
			{ detail: "current_password and new_password are required" },
			{ status: 400 },
		);
	}

	if (
		body.current_password.length === 0 ||
		body.current_password.length > 256
	) {
		return NextResponse.json(
			{ detail: "current_password must be 1–256 characters" },
			{ status: 400 },
		);
	}

	let rate: Awaited<ReturnType<typeof consumePasswordChangeRateLimit>>;
	try {
		rate = await consumePasswordChangeRateLimit(request, identity.principalId);
	} catch (error) {
		logger.error({
			event: "auth.password.rate_limit_unavailable",
			component: "redis",
			error,
		});
		return NextResponse.json(
			{ detail: "authentication service unavailable" },
			{ status: 503, headers: { "Retry-After": "5" } },
		);
	}
	if (!rate.ok) {
		return NextResponse.json(
			{ detail: "too many password change attempts" },
			{
				status: 429,
				headers: { "Retry-After": String(rate.retryAfterSeconds) },
			},
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

	let token: string;
	try {
		token = await replacePrincipalSessionToken(
			result.identity,
			result.credentialVersion,
		);
	} catch (error) {
		logger.error({
			event: "auth.password.session_replace_failed",
			component: "redis",
			error,
		});
		return NextResponse.json(
			{ detail: "password changed; sign in again" },
			{ status: 503, headers: { "Retry-After": "5" } },
		);
	}
	const response = NextResponse.json(result.identity);
	response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
	return response;
}
