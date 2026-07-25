import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import { getDatabase } from "@/db";
import {
	localCredentials,
	users,
	workspaceInvites,
	workspaceMembers,
	workspaces,
} from "@/db/schema";
import type { AuthIdentity } from "@/lib/server/auth/provider";
import { hashPassword } from "@/lib/server/auth/passwords.mjs";
import { hydrateIdentity } from "@/lib/server/auth/session";
import { sendInviteEmail } from "@/lib/server/email";
import { isAssignableInviteRole } from "@/lib/server/workspace-permissions.mjs";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashInviteToken(rawToken: string): string {
	return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function buildInviteUrl(origin: string, rawToken: string): string {
	const base = (process.env.APP_BASE_URL?.trim() || origin).replace(/\/$/, "");
	return `${base}/invite?token=${encodeURIComponent(rawToken)}`;
}

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export async function listWorkspaceMembers(workspaceId: string) {
	const db = getDatabase();
	return db
		.select({
			userId: users.id,
			email: users.email,
			displayName: users.displayName,
			status: users.status,
			role: workspaceMembers.role,
			lastLoginAt: users.lastLoginAt,
			joinedAt: workspaceMembers.createdAt,
		})
		.from(workspaceMembers)
		.innerJoin(users, eq(users.id, workspaceMembers.userId))
		.where(eq(workspaceMembers.workspaceId, workspaceId))
		.orderBy(desc(workspaceMembers.createdAt));
}

export async function listWorkspaceInvites(workspaceId: string) {
	const db = getDatabase();
	const rows = await db
		.select({
			id: workspaceInvites.id,
			email: workspaceInvites.email,
			role: workspaceInvites.role,
			status: workspaceInvites.status,
			expiresAt: workspaceInvites.expiresAt,
			acceptedAt: workspaceInvites.acceptedAt,
			lastSentAt: workspaceInvites.lastSentAt,
			createdAt: workspaceInvites.createdAt,
			invitedBy: workspaceInvites.invitedBy,
		})
		.from(workspaceInvites)
		.where(eq(workspaceInvites.workspaceId, workspaceId))
		.orderBy(desc(workspaceInvites.createdAt))
		.limit(100);

	const now = Date.now();
	return rows.map((row) => {
		const expired = row.status === "pending" && row.expiresAt.getTime() <= now;
		return {
			...row,
			status: expired ? "expired" : row.status,
		};
	});
}

export async function createWorkspaceInvite(input: {
	identity: AuthIdentity;
	email: string;
	role: string;
	origin: string;
	sendEmail?: boolean;
}): Promise<
	| {
			ok: true;
			invite: {
				id: string;
				email: string;
				role: string;
				status: string;
				expiresAt: Date;
				inviteUrl: string;
				emailDelivery: Awaited<ReturnType<typeof sendInviteEmail>>;
			};
	  }
	| { ok: false; status: number; detail: string }
> {
	const email = normalizeEmail(input.email);
	const role = input.role.trim();
	if (!email || !email.includes("@")) {
		return { ok: false, status: 400, detail: "valid email is required" };
	}
	if (!isAssignableInviteRole(role)) {
		return {
			ok: false,
			status: 400,
			detail: "role must be viewer, editor, or admin",
		};
	}

	const db = getDatabase();
	const [workspace] = await db
		.select({
			id: workspaces.id,
			name: workspaces.name,
			organizationId: workspaces.organizationId,
		})
		.from(workspaces)
		.where(
			and(
				eq(workspaces.id, input.identity.workspaceId),
				eq(workspaces.organizationId, input.identity.tenantId),
				eq(workspaces.status, "active"),
			),
		)
		.limit(1);
	if (!workspace) {
		return { ok: false, status: 404, detail: "workspace not found" };
	}

	const existingMembers = await db
		.select({ userId: users.id })
		.from(workspaceMembers)
		.innerJoin(users, eq(users.id, workspaceMembers.userId))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspace.id),
				eq(users.email, email),
			),
		)
		.limit(1);
	if (existingMembers.length > 0) {
		return { ok: false, status: 409, detail: "user is already a member" };
	}

	await db
		.update(workspaceInvites)
		.set({ status: "revoked", updatedAt: new Date() })
		.where(
			and(
				eq(workspaceInvites.workspaceId, workspace.id),
				eq(workspaceInvites.email, email),
				eq(workspaceInvites.status, "pending"),
			),
		);

	const rawToken = randomBytes(32).toString("base64url");
	const tokenHash = hashInviteToken(rawToken);
	const expiresAt = new Date(Date.now() + DEFAULT_TTL_MS);
	const [invite] = await db
		.insert(workspaceInvites)
		.values({
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
			email,
			role,
			tokenHash,
			status: "pending",
			invitedBy: input.identity.principalId,
			expiresAt,
		})
		.returning({
			id: workspaceInvites.id,
			email: workspaceInvites.email,
			role: workspaceInvites.role,
			status: workspaceInvites.status,
			expiresAt: workspaceInvites.expiresAt,
		});

	const inviteUrl = buildInviteUrl(input.origin, rawToken);
	let emailDelivery: Awaited<ReturnType<typeof sendInviteEmail>> = {
		sent: false,
		provider: "none",
		reason: "copy_link_only",
	};
	if (input.sendEmail !== false) {
		emailDelivery = await sendInviteEmail({
			to: email,
			inviteUrl,
			workspaceName: workspace.name,
			role,
		});
		if (emailDelivery.sent) {
			await db
				.update(workspaceInvites)
				.set({ lastSentAt: new Date(), updatedAt: new Date() })
				.where(eq(workspaceInvites.id, invite.id));
		}
	}

	return {
		ok: true,
		invite: {
			...invite,
			inviteUrl,
			emailDelivery,
		},
	};
}

export async function revokeWorkspaceInvite(input: {
	identity: AuthIdentity;
	inviteId: string;
}): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
	const db = getDatabase();
	const [row] = await db
		.select({
			id: workspaceInvites.id,
			status: workspaceInvites.status,
		})
		.from(workspaceInvites)
		.where(
			and(
				eq(workspaceInvites.id, input.inviteId),
				eq(workspaceInvites.workspaceId, input.identity.workspaceId),
				eq(workspaceInvites.organizationId, input.identity.tenantId),
			),
		)
		.limit(1);
	if (!row) return { ok: false, status: 404, detail: "invite not found" };
	if (row.status !== "pending") {
		return { ok: false, status: 409, detail: "invite is not pending" };
	}
	await db
		.update(workspaceInvites)
		.set({ status: "revoked", updatedAt: new Date() })
		.where(eq(workspaceInvites.id, row.id));
	return { ok: true };
}

export async function previewInvite(rawToken: string) {
	const db = getDatabase();
	const tokenHash = hashInviteToken(rawToken);
	const [row] = await db
		.select({
			id: workspaceInvites.id,
			email: workspaceInvites.email,
			role: workspaceInvites.role,
			status: workspaceInvites.status,
			expiresAt: workspaceInvites.expiresAt,
			workspaceName: workspaces.name,
		})
		.from(workspaceInvites)
		.innerJoin(workspaces, eq(workspaces.id, workspaceInvites.workspaceId))
		.where(eq(workspaceInvites.tokenHash, tokenHash))
		.limit(1);
	if (!row) return null;
	const expired =
		row.status === "pending" && row.expiresAt.getTime() <= Date.now();
	return {
		email: row.email,
		role: row.role,
		workspaceName: row.workspaceName,
		expiresAt: row.expiresAt,
		status: expired ? "expired" : row.status,
	};
}

export async function acceptInvite(input: {
	rawToken: string;
	password: string;
	displayName?: string;
}): Promise<
	| { ok: true; identity: AuthIdentity }
	| { ok: false; status: number; detail: string }
> {
	const password = input.password;
	if (password.length < 8) {
		return {
			ok: false,
			status: 400,
			detail: "password must be at least 8 characters",
		};
	}
	const db = getDatabase();
	const tokenHash = hashInviteToken(input.rawToken);
	const [invite] = await db
		.select()
		.from(workspaceInvites)
		.where(eq(workspaceInvites.tokenHash, tokenHash))
		.limit(1);
	if (!invite) {
		return { ok: false, status: 404, detail: "invite not found" };
	}
	if (invite.status !== "pending") {
		return { ok: false, status: 409, detail: `invite is ${invite.status}` };
	}
	if (invite.expiresAt.getTime() <= Date.now()) {
		await db
			.update(workspaceInvites)
			.set({ status: "expired", updatedAt: new Date() })
			.where(eq(workspaceInvites.id, invite.id));
		return { ok: false, status: 410, detail: "invite expired" };
	}

	const email = normalizeEmail(invite.email);
	const displayName =
		input.displayName?.trim() || email.split("@")[0] || "Member";
	const now = new Date();

	const result = await db.transaction(async (tx) => {
		const [existing] = await tx
			.select({
				id: users.id,
				status: users.status,
			})
			.from(users)
			.where(
				and(
					eq(users.organizationId, invite.organizationId),
					eq(users.email, email),
				),
			)
			.limit(1);

		let userId = existing?.id;
		if (!userId) {
			const [created] = await tx
				.insert(users)
				.values({
					organizationId: invite.organizationId,
					externalSubject: `local:${email}`,
					email,
					displayName,
					status: "active",
					lastLoginAt: now,
				})
				.returning({ id: users.id });
			userId = created.id;
			await tx.insert(localCredentials).values({
				userId,
				passwordHash: hashPassword(password),
			});
		} else {
			if (existing.status !== "active") {
				return { error: "user is disabled" as const };
			}
			await tx
				.update(users)
				.set({ displayName, lastLoginAt: now, updatedAt: now })
				.where(eq(users.id, userId));
			const [cred] = await tx
				.select({ userId: localCredentials.userId })
				.from(localCredentials)
				.where(eq(localCredentials.userId, userId))
				.limit(1);
			if (cred) {
				await tx
					.update(localCredentials)
					.set({
						passwordHash: hashPassword(password),
						failedAttempts: 0,
						lockedUntil: null,
						passwordChangedAt: now,
						updatedAt: now,
					})
					.where(eq(localCredentials.userId, userId));
			} else {
				await tx.insert(localCredentials).values({
					userId,
					passwordHash: hashPassword(password),
				});
			}
		}

		const [membership] = await tx
			.select({ role: workspaceMembers.role })
			.from(workspaceMembers)
			.where(
				and(
					eq(workspaceMembers.workspaceId, invite.workspaceId),
					eq(workspaceMembers.userId, userId),
				),
			)
			.limit(1);
		if (membership) {
			return { error: "already_member" as const };
		}
		await tx.insert(workspaceMembers).values({
			workspaceId: invite.workspaceId,
			userId,
			role: invite.role,
		});
		await tx
			.update(workspaceInvites)
			.set({
				status: "accepted",
				acceptedAt: now,
				acceptedUserId: userId,
				updatedAt: now,
			})
			.where(eq(workspaceInvites.id, invite.id));

		return { userId };
	});

	if ("error" in result) {
		if (result.error === "already_member") {
			return { ok: false, status: 409, detail: "user is already a member" };
		}
		return {
			ok: false,
			status: 403,
			detail: result.error ?? "invite accept failed",
		};
	}

	const identity = await hydrateIdentity(
		result.userId,
		invite.workspaceId,
		"local",
	);
	if (!identity) {
		return { ok: false, status: 500, detail: "failed to hydrate session" };
	}
	return { ok: true, identity };
}

export async function updateMemberRole(input: {
	identity: AuthIdentity;
	userId: string;
	role: string;
}): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
	const role = input.role.trim();
	if (!isAssignableInviteRole(role)) {
		return { ok: false, status: 400, detail: "invalid role" };
	}
	if (input.userId === input.identity.principalId) {
		return { ok: false, status: 400, detail: "cannot change your own role" };
	}

	const db = getDatabase();
	const [target] = await db
		.select({
			userId: workspaceMembers.userId,
			role: workspaceMembers.role,
		})
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.workspaceId, input.identity.workspaceId),
				eq(workspaceMembers.userId, input.userId),
			),
		)
		.limit(1);
	if (!target) {
		return { ok: false, status: 404, detail: "member not found" };
	}
	if (target.role === "owner") {
		return { ok: false, status: 403, detail: "cannot change owner role" };
	}

	await db
		.update(workspaceMembers)
		.set({ role, updatedAt: new Date() })
		.where(
			and(
				eq(workspaceMembers.workspaceId, input.identity.workspaceId),
				eq(workspaceMembers.userId, input.userId),
			),
		);
	return { ok: true };
}
