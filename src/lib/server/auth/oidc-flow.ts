import { createHmac, timingSafeEqual } from "node:crypto";

import { resolveSessionSecret } from "./secrets.mjs";

export const OIDC_FLOW_COOKIE = "unorag_oidc_flow";
export const OIDC_FLOW_MAX_AGE_SECONDS = 10 * 60;

export type OidcFlowClaims = Readonly<{
	v: 1;
	state: string;
	nonce: string;
	codeVerifier: string;
	redirectUri: string;
	returnTo: string;
	iat: number;
	exp: number;
}>;

function sign(value: string): string {
	return createHmac("sha256", resolveSessionSecret())
		.update(`oidc-flow:${value}`, "utf8")
		.digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return (
		leftBytes.length === rightBytes.length &&
		timingSafeEqual(leftBytes, rightBytes)
	);
}

export function safeReturnTo(value: string | null | undefined): string {
	if (!value?.startsWith("/") || value.startsWith("//")) return "/app";
	try {
		const parsed = new URL(value, "https://unorag.invalid");
		if (parsed.origin !== "https://unorag.invalid") return "/app";
		return `${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return "/app";
	}
}

export function createOidcFlowToken(
	input: Omit<OidcFlowClaims, "v" | "iat" | "exp">,
	nowSeconds = Math.floor(Date.now() / 1000),
): string {
	const claims: OidcFlowClaims = {
		v: 1,
		...input,
		iat: nowSeconds,
		exp: nowSeconds + OIDC_FLOW_MAX_AGE_SECONDS,
	};
	const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
	return `${encoded}.${sign(encoded)}`;
}

export function readOidcFlowToken(
	token: string | undefined,
	nowSeconds = Math.floor(Date.now() / 1000),
): OidcFlowClaims | null {
	if (!token) return null;
	const separator = token.lastIndexOf(".");
	if (separator < 1) return null;
	const encoded = token.slice(0, separator);
	if (!safeEqual(token.slice(separator + 1), sign(encoded))) return null;
	try {
		const claims = JSON.parse(
			Buffer.from(encoded, "base64url").toString("utf8"),
		) as OidcFlowClaims;
		if (
			claims.v !== 1 ||
			typeof claims.state !== "string" ||
			!claims.state ||
			typeof claims.nonce !== "string" ||
			!claims.nonce ||
			typeof claims.codeVerifier !== "string" ||
			!claims.codeVerifier ||
			typeof claims.redirectUri !== "string" ||
			!claims.redirectUri ||
			typeof claims.returnTo !== "string" ||
			typeof claims.iat !== "number" ||
			typeof claims.exp !== "number" ||
			claims.iat > nowSeconds + 30 ||
			claims.exp <= nowSeconds ||
			claims.exp - claims.iat > OIDC_FLOW_MAX_AGE_SECONDS
		) {
			return null;
		}
		return { ...claims, returnTo: safeReturnTo(claims.returnTo) };
	} catch {
		return null;
	}
}

export function oidcFlowCookieOptions() {
	return {
		httpOnly: true,
		sameSite: "lax" as const,
		secure: process.env.NODE_ENV === "production",
		path: "/api/auth/oidc",
		maxAge: OIDC_FLOW_MAX_AGE_SECONDS,
	};
}
