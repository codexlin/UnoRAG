import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { resolveSessionSecret } from "./secrets.mjs";

export const SESSION_COOKIE = "unorag_session";
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

const SESSION_ISSUER = "unorag-control-plane";
const SESSION_TTL_SECONDS = SESSION_MAX_AGE_SECONDS;

export type SessionClaims = {
	v: 1 | 2;
	iss: typeof SESSION_ISSUER;
	sid: string;
	principal_id: string;
	workspace_id: string;
	provider?: "local" | "oidc";
	iat: number;
	exp: number;
};

type SessionSubject = {
	principalId: string;
	workspaceId: string;
	provider?: "local" | "oidc";
};

function sign(value: string): string {
	return createHmac("sha256", resolveSessionSecret())
		.update(value, "utf8")
		.digest("base64url");
}

function parseCookies(header: string | null): Map<string, string> {
	const values = new Map<string, string>();
	for (const part of (header ?? "").split(";")) {
		const separator = part.indexOf("=");
		if (separator < 1) continue;
		try {
			values.set(
				part.slice(0, separator).trim(),
				decodeURIComponent(part.slice(separator + 1).trim()),
			);
		} catch {
			// A malformed cookie must not make authentication fail open or throw.
		}
	}
	return values;
}

export function verifySessionToken(
	token: string,
	nowSeconds = Math.floor(Date.now() / 1000),
): SessionClaims | null {
	const separator = token.lastIndexOf(".");
	if (separator < 1) return null;
	const encoded = token.slice(0, separator);
	const provided = token.slice(separator + 1);
	const expected = sign(encoded);
	const providedBytes = Buffer.from(provided);
	const expectedBytes = Buffer.from(expected);
	if (
		providedBytes.length !== expectedBytes.length ||
		!timingSafeEqual(providedBytes, expectedBytes)
	) {
		return null;
	}

	try {
		const claims = JSON.parse(
			Buffer.from(encoded, "base64url").toString("utf8"),
		) as SessionClaims;
		if (
			(claims.v !== 1 && claims.v !== 2) ||
			claims.iss !== SESSION_ISSUER ||
			!claims.sid ||
			!claims.principal_id ||
			!claims.workspace_id ||
			claims.iat > nowSeconds + 30 ||
			claims.exp <= nowSeconds ||
			claims.exp - claims.iat > SESSION_TTL_SECONDS ||
			(claims.v === 2 &&
				claims.provider !== "local" &&
				claims.provider !== "oidc")
		) {
			return null;
		}
		return claims;
	} catch {
		return null;
	}
}

export function readSessionClaims(
	cookieHeader: string | null,
): SessionClaims | null {
	const token = parseCookies(cookieHeader).get(SESSION_COOKIE);
	return token ? verifySessionToken(token) : null;
}

export function createSignedSessionToken(
	subject: SessionSubject,
	nowSeconds = Math.floor(Date.now() / 1000),
): string {
	const claims: SessionClaims = {
		v: 2,
		iss: SESSION_ISSUER,
		sid: randomUUID(),
		principal_id: subject.principalId,
		workspace_id: subject.workspaceId,
		provider: subject.provider ?? "local",
		iat: nowSeconds,
		exp: nowSeconds + SESSION_TTL_SECONDS,
	};
	const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
	return `${encoded}.${sign(encoded)}`;
}

export function sessionCookieOptions() {
	return {
		httpOnly: true,
		sameSite: "lax" as const,
		secure: process.env.NODE_ENV === "production",
		path: "/",
		maxAge: SESSION_MAX_AGE_SECONDS,
	};
}
