import "server-only";

import {
	createHmac,
	randomUUID,
	scrypt as scryptCallback,
	timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

import { and, eq, isNull, lte, or } from "drizzle-orm";

import { getDatabase } from "@/db";
import {
	groupMembers,
	groups,
	localCredentials,
	users,
	workspaceMembers,
	workspaces,
} from "@/db/schema";
import type {
	AuthIdentity,
	IdentityProvider,
	LocalCredentialsInput,
} from "./provider";
import { resolveSessionSecret } from "./secrets.mjs";

export const SESSION_COOKIE = "meriknow_session";
const SESSION_ISSUER = "meriknow-control-plane";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const scrypt = promisify(scryptCallback);

type SessionClaims = {
	v: 1;
	iss: typeof SESSION_ISSUER;
	sid: string;
	principal_id: string;
	workspace_id: string;
	iat: number;
	exp: number;
};

function sessionSecret(): string {
	return resolveSessionSecret();
}

function sign(value: string): string {
	return createHmac("sha256", sessionSecret())
		.update(value, "utf8")
		.digest("base64url");
}

function parseCookies(header: string | null): Map<string, string> {
	const values = new Map<string, string>();
	for (const part of (header ?? "").split(";")) {
		const separator = part.indexOf("=");
		if (separator < 1) continue;
		values.set(
			part.slice(0, separator).trim(),
			decodeURIComponent(part.slice(separator + 1).trim()),
		);
	}
	return values;
}

function parseSessionToken(token: string): SessionClaims | null {
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
		const now = Math.floor(Date.now() / 1000);
		if (
			claims.v !== 1 ||
			claims.iss !== SESSION_ISSUER ||
			!claims.sid ||
			!claims.principal_id ||
			!claims.workspace_id ||
			claims.iat > now + 30 ||
			claims.exp <= now ||
			claims.exp - claims.iat > SESSION_TTL_SECONDS
		) {
			return null;
		}
		return claims;
	} catch {
		return null;
	}
}

export async function hydrateIdentity(
	principalId: string,
	workspaceId: string,
	provider: "local" | "oidc" = "local",
): Promise<AuthIdentity | null> {
	const db = getDatabase();
	const [membership] = await db
		.select({
			tenantId: users.organizationId,
			workspaceId: workspaces.id,
			principalId: users.id,
			role: workspaceMembers.role,
			email: users.email,
			displayName: users.displayName,
		})
		.from(users)
		.innerJoin(
			workspaceMembers,
			and(
				eq(workspaceMembers.userId, users.id),
				eq(workspaceMembers.workspaceId, workspaceId),
			),
		)
		.innerJoin(
			workspaces,
			and(
				eq(workspaces.id, workspaceMembers.workspaceId),
				eq(workspaces.organizationId, users.organizationId),
			),
		)
		.where(
			and(
				eq(users.id, principalId),
				eq(users.status, "active"),
				eq(workspaces.status, "active"),
			),
		)
		.limit(1);
	if (!membership) return null;

	const memberships = await db
		.select({ id: groups.id })
		.from(groupMembers)
		.innerJoin(
			groups,
			and(
				eq(groups.id, groupMembers.groupId),
				eq(groups.organizationId, membership.tenantId),
			),
		)
		.where(eq(groupMembers.userId, membership.principalId));

	return {
		...membership,
		groupIds: memberships.map((item) => item.id),
		provider,
	};
}

export async function resolveRequestSession(
	request: Request,
): Promise<AuthIdentity | null> {
	return resolveSessionCookieHeader(request.headers.get("cookie"));
}

export async function resolveSessionCookieHeader(
	cookieHeader: string | null,
): Promise<AuthIdentity | null> {
	const token = parseCookies(cookieHeader).get(SESSION_COOKIE);
	if (!token) return null;
	const claims = parseSessionToken(token);
	if (!claims) return null;
	return hydrateIdentity(claims.principal_id, claims.workspace_id, "local");
}

export function createSessionToken(identity: AuthIdentity): string {
	const now = Math.floor(Date.now() / 1000);
	const claims: SessionClaims = {
		v: 1,
		iss: SESSION_ISSUER,
		sid: randomUUID(),
		principal_id: identity.principalId,
		workspace_id: identity.workspaceId,
		iat: now,
		exp: now + SESSION_TTL_SECONDS,
	};
	const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
	return `${encoded}.${sign(encoded)}`;
}

async function verifyPassword(
	password: string,
	encoded: string,
): Promise<boolean> {
	const [algorithm, saltHex, hashHex] = encoded.split("$");
	if (algorithm !== "scrypt" || !saltHex || !hashHex) return false;
	const expected = Buffer.from(hashHex, "hex");
	const actual = (await scrypt(
		password,
		Buffer.from(saltHex, "hex"),
		expected.length,
	)) as Buffer;
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const localIdentityProvider: IdentityProvider<LocalCredentialsInput> = {
	id: "local",
	async authenticate(input) {
		const db = getDatabase();
		const now = new Date();
		const rows = await db
			.select({
				principalId: users.id,
				workspaceId: workspaceMembers.workspaceId,
				passwordHash: localCredentials.passwordHash,
				failedAttempts: localCredentials.failedAttempts,
			})
			.from(users)
			.innerJoin(localCredentials, eq(localCredentials.userId, users.id))
			.innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
			.where(
				and(
					eq(users.email, input.email.trim().toLowerCase()),
					eq(users.status, "active"),
					input.workspaceId
						? eq(workspaceMembers.workspaceId, input.workspaceId)
						: undefined,
					or(
						isNull(localCredentials.lockedUntil),
						lte(localCredentials.lockedUntil, now),
					),
				),
			);
		for (const row of rows) {
			if (await verifyPassword(input.password, row.passwordHash)) {
				await db
					.update(localCredentials)
					.set({
						failedAttempts: 0,
						lockedUntil: null,
						updatedAt: now,
					})
					.where(eq(localCredentials.userId, row.principalId));
				await db
					.update(users)
					.set({ lastLoginAt: now, updatedAt: now })
					.where(eq(users.id, row.principalId));
				return hydrateIdentity(row.principalId, row.workspaceId, "local");
			}
			const failedAttempts = row.failedAttempts + 1;
			await db
				.update(localCredentials)
				.set({
					failedAttempts,
					lockedUntil:
						failedAttempts >= 5
							? new Date(now.getTime() + 15 * 60 * 1000)
							: null,
					updatedAt: now,
				})
				.where(eq(localCredentials.userId, row.principalId));
		}
		return null;
	},
};
