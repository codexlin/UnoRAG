import { NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/lib/observability";
import {
	consumeLoginRateLimit,
	resetLoginAccountRateLimit,
} from "@/lib/server/auth/login-rate-limit";
import {
	issueSessionToken,
	localIdentityProvider,
	resolveRequestSession,
	revokeSessionCookieHeader,
	SESSION_COOKIE,
	sessionCookieOptions,
} from "@/lib/server/auth/session";

const LoginRequestSchema = z
	.object({
		email: z
			.string()
			.trim()
			.min(1)
			.max(320)
			.transform((value) => value.toLowerCase()),
		password: z.string().min(1).max(256),
		workspace_id: z.string().uuid().optional(),
	})
	.strict();

export async function GET(request: Request) {
	const identity = await resolveRequestSession(request, {
		allowPasswordChangeRequired: true,
	});
	if (!identity) {
		return NextResponse.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}
	return NextResponse.json(identity);
}

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ detail: "invalid JSON body" }, { status: 400 });
	}
	const parsed = LoginRequestSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json(
			{ detail: "invalid login request" },
			{ status: 400 },
		);
	}
	const { email, password, workspace_id: workspaceId } = parsed.data;
	let rate: Awaited<ReturnType<typeof consumeLoginRateLimit>>;
	try {
		rate = await consumeLoginRateLimit(request, email);
	} catch (error) {
		logger.error({
			event: "auth.login.rate_limit_unavailable",
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
			{ detail: "too many authentication attempts" },
			{
				status: 429,
				headers: { "Retry-After": String(rate.retryAfterSeconds) },
			},
		);
	}
	const identity = await localIdentityProvider.authenticate({
		email,
		password,
		workspaceId,
	});
	if (!identity) {
		return NextResponse.json(
			{ detail: "invalid credentials" },
			{ status: 401 },
		);
	}
	let token: string;
	try {
		token = await issueSessionToken(identity);
		await resetLoginAccountRateLimit(email);
	} catch (error) {
		logger.error({
			event: "auth.session.issue_failed",
			component: "redis",
			error,
		});
		return NextResponse.json(
			{ detail: "authentication service unavailable" },
			{ status: 503, headers: { "Retry-After": "5" } },
		);
	}
	const response = NextResponse.json(identity);
	response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
	return response;
}

export async function DELETE(request: Request) {
	try {
		await revokeSessionCookieHeader(request.headers.get("cookie"));
	} catch (error) {
		logger.error({
			event: "auth.session.revoke_failed",
			component: "redis",
			error,
		});
		return NextResponse.json(
			{ detail: "session revocation is unavailable" },
			{ status: 503, headers: { "Retry-After": "5" } },
		);
	}
	const response = NextResponse.json({ ok: true });
	response.cookies.set(SESSION_COOKIE, "", {
		...sessionCookieOptions(),
		maxAge: 0,
	});
	return response;
}
