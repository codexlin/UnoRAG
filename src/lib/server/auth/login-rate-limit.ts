import "server-only";

import { isIP } from "node:net";

import { z } from "zod";

import {
	consumeFixedWindow,
	type RateLimitResult,
	resetFixedWindow,
} from "@/lib/server/security/fixed-window-rate-limit";

type Environment = Record<string, string | undefined>;

const policySchema = z
	.object({
		AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce
			.number()
			.int()
			.min(60)
			.max(86_400)
			.default(900),
		AUTH_LOGIN_RATE_LIMIT_PER_ACCOUNT: z.coerce
			.number()
			.int()
			.min(1)
			.max(1_000)
			.default(10),
		AUTH_LOGIN_RATE_LIMIT_PER_IP: z.coerce
			.number()
			.int()
			.min(1)
			.max(10_000)
			.default(60),
	})
	.passthrough();

export type LoginRateLimitPolicy = {
	windowSeconds: number;
	perAccount: number;
	perIp: number;
};

export function resolveLoginRateLimitPolicy(
	environment: Environment = process.env,
): LoginRateLimitPolicy {
	const parsed = policySchema.parse(environment);
	return {
		windowSeconds: parsed.AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS,
		perAccount: parsed.AUTH_LOGIN_RATE_LIMIT_PER_ACCOUNT,
		perIp: parsed.AUTH_LOGIN_RATE_LIMIT_PER_IP,
	};
}

export function resolveClientAddress(request: Request): string {
	const forwarded = request.headers.get("x-forwarded-for");
	if (forwarded) {
		const candidates = forwarded
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
		for (let index = candidates.length - 1; index >= 0; index -= 1) {
			const candidate = candidates[index];
			if (candidate && isIP(candidate)) return candidate;
		}
	}
	const realIp = request.headers.get("x-real-ip")?.trim();
	return realIp && isIP(realIp) ? realIp : "unknown";
}

function accountSubject(email: string): string {
	return email.trim().toLowerCase();
}

export async function consumeLoginRateLimit(
	request: Request,
	email: string,
	policy = resolveLoginRateLimitPolicy(),
): Promise<RateLimitResult> {
	return consumeAccountAndIpRateLimit(
		request,
		accountSubject(email),
		"login",
		policy,
	);
}

export function consumePasswordChangeRateLimit(
	request: Request,
	principalId: string,
): Promise<RateLimitResult> {
	return consumeAccountAndIpRateLimit(request, principalId, "password-change", {
		windowSeconds: 900,
		perAccount: 5,
		perIp: 30,
	});
}

async function consumeAccountAndIpRateLimit(
	request: Request,
	account: string,
	namespace: string,
	policy: LoginRateLimitPolicy,
): Promise<RateLimitResult> {
	const address = resolveClientAddress(request);
	const [accountResult, ipResult] = await Promise.all([
		consumeFixedWindow({
			namespace: `${namespace}-account`,
			subject: account,
			limit: policy.perAccount,
			windowSeconds: policy.windowSeconds,
		}),
		consumeFixedWindow({
			namespace: `${namespace}-ip`,
			subject: address,
			limit: policy.perIp,
			windowSeconds: policy.windowSeconds,
		}),
	]);
	if (!accountResult.ok && !ipResult.ok) {
		return {
			ok: false,
			retryAfterSeconds: Math.max(
				accountResult.retryAfterSeconds,
				ipResult.retryAfterSeconds,
			),
		};
	}
	if (!accountResult.ok) return accountResult;
	if (!ipResult.ok) return ipResult;
	return {
		ok: true,
		remaining: Math.min(accountResult.remaining, ipResult.remaining),
	};
}

export async function resetLoginAccountRateLimit(email: string): Promise<void> {
	await resetFixedWindow("login-account", accountSubject(email));
}
