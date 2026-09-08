import "server-only";

import {
	randomBytes,
	scrypt as scryptCallback,
	timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

import { and, eq, isNull, lte, or } from "drizzle-orm";

import { getDatabase } from "@/db";
import {
	auditLogs,
	groupMembers,
	groups,
	localCredentials,
	organizations,
	users,
	workspaceMembers,
	workspaces,
} from "@/db/schema";
import { validatePassword } from "./passwords.mjs";
import type {
	AuthIdentity,
	IdentityProvider,
	LocalCredentialsInput,
} from "./provider";
import { createSignedSessionToken, readSessionClaims } from "./session-token";

export {
	SESSION_COOKIE,
	SESSION_MAX_AGE_SECONDS,
	sessionCookieOptions,
} from "./session-token";

const scrypt = promisify(scryptCallback);

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
			workspaceName: workspaces.name,
			principalId: users.id,
			organizationRole: users.organizationRole,
			role: workspaceMembers.role,
			email: users.email,
			displayName: users.displayName,
			mustChangePassword: localCredentials.mustChangePassword,
		})
		.from(users)
		.innerJoin(
			organizations,
			and(
				eq(organizations.id, users.organizationId),
				eq(organizations.status, "active"),
			),
		)
		.leftJoin(localCredentials, eq(localCredentials.userId, users.id))
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
		mustChangePassword:
			provider === "local" && membership.mustChangePassword === true,
	};
}

export async function resolveRequestSession(
	request: Request,
	options: { allowPasswordChangeRequired?: boolean } = {},
): Promise<AuthIdentity | null> {
	const identity = await resolveSessionCookieHeader(
		request.headers.get("cookie"),
	);
	if (
		identity?.mustChangePassword &&
		options.allowPasswordChangeRequired !== true
	) {
		return null;
	}
	return identity;
}

export async function resolveSessionCookieHeader(
	cookieHeader: string | null,
): Promise<AuthIdentity | null> {
	const claims = readSessionClaims(cookieHeader);
	if (!claims) return null;
	return hydrateIdentity(claims.principal_id, claims.workspace_id, "local");
}

export function createSessionToken(identity: AuthIdentity): string {
	return createSignedSessionToken(identity);
}

export type ChangePasswordResult =
	| { ok: true; identity: AuthIdentity }
	| { ok: false; status: number; detail: string };

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

async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const hash = (await scrypt(password, salt, 64)) as Buffer;
	return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function changeLocalPassword(input: {
	identity: AuthIdentity;
	currentPassword: string;
	newPassword: string;
}): Promise<ChangePasswordResult> {
	if (input.identity.provider !== "local") {
		return {
			ok: false,
			status: 400,
			detail: "password is managed by the identity provider",
		};
	}
	const passwordError = validatePassword(input.newPassword);
	if (passwordError) {
		return {
			ok: false,
			status: 400,
			detail: passwordError,
		};
	}
	if (input.currentPassword === input.newPassword) {
		return {
			ok: false,
			status: 400,
			detail: "new password must differ from the current password",
		};
	}

	const db = getDatabase();
	const [credential] = await db
		.select({ passwordHash: localCredentials.passwordHash })
		.from(localCredentials)
		.where(eq(localCredentials.userId, input.identity.principalId))
		.limit(1);
	if (
		!credential ||
		!(await verifyPassword(input.currentPassword, credential.passwordHash))
	) {
		return { ok: false, status: 401, detail: "current password is incorrect" };
	}

	const now = new Date();
	const nextHash = await hashPassword(input.newPassword);
	const changed = await db.transaction(async (tx) => {
		const rows = await tx
			.update(localCredentials)
			.set({
				passwordHash: nextHash,
				mustChangePassword: false,
				failedAttempts: 0,
				lockedUntil: null,
				passwordChangedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(localCredentials.userId, input.identity.principalId),
					eq(localCredentials.passwordHash, credential.passwordHash),
				),
			)
			.returning({ userId: localCredentials.userId });
		if (rows.length !== 1) return false;
		await tx.insert(auditLogs).values({
			organizationId: input.identity.tenantId,
			workspaceId: input.identity.workspaceId,
			actorId: input.identity.principalId,
			action: "auth.password_changed",
			resourceType: "user",
			resourceId: input.identity.principalId,
			details: { provider: "local" },
		});
		return true;
	});
	if (!changed) {
		return {
			ok: false,
			status: 409,
			detail: "password changed concurrently; sign in again",
		};
	}

	const identity = await hydrateIdentity(
		input.identity.principalId,
		input.identity.workspaceId,
		"local",
	);
	if (!identity) {
		return { ok: false, status: 401, detail: "authentication required" };
	}
	return { ok: true, identity };
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
