import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "@/db";
import {
	auditLogs,
	documentAcl,
	documents,
	localCredentials,
	organizations,
	users,
	workspaceInvites,
	workspaceMembers,
	workspaces,
} from "@/db/schema";
import { logger } from "@/lib/observability";
import {
	hashPasswordAsync,
	validatePassword,
	verifyPasswordSync,
} from "@/lib/server/auth/passwords.mjs";
import type { AuthIdentity } from "@/lib/server/auth/provider";
import { hydrateIdentity } from "@/lib/server/auth/session";
import { sendInviteEmail } from "@/lib/server/email";
import {
	authorizeRemoveMember,
	isAssignableInviteRole,
} from "@/lib/server/workspace-permissions.mjs";
import { accountEmailBaseUrl } from "./auth/email-tokens";
import { resolveClientAddress } from "./auth/login-rate-limit";
import { consumeFixedWindow } from "./security/fixed-window-rate-limit";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashInviteToken(rawToken: string): string {
	return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function buildInviteUrl(_origin: string, rawToken: string): string {
	const base = accountEmailBaseUrl(process.env.APP_BASE_URL);
	// Relative URLs are copy-link only and are resolved by the browser, never mailed.
	return `${base ?? ""}/invite#${new URLSearchParams({ token: rawToken })}`;
}

function inviteEmailReason(
	delivery: Awaited<ReturnType<typeof sendInviteEmail>>,
): string {
	if (delivery.sent) return "provider_accepted";
	if (delivery.reason === "EMAIL_PROVIDER=none") return "email_not_configured";
	if (delivery.reason === "RESEND_API_KEY or EMAIL_FROM missing")
		return "email_configuration_missing";
	const safeReasons = new Set([
		"copy_link_only",
		"app_base_url_not_configured",
		"send_failed",
		"invalid_idempotency_key",
		"invalid_recipient",
		"invalid_email_template",
		"resend_timeout",
		"resend_invalid_response",
		"resend_fetch_failed",
	]);
	return safeReasons.has(delivery.reason) ||
		/^resend_http_[1-5]\d{2}$/.test(delivery.reason)
		? delivery.reason
		: "send_failed";
}

export const inviteEmailSchema = z
	.string()
	.trim()
	.toLowerCase()
	.max(320)
	.email();
export const inviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export async function readInviteJson(
	request: Request,
): Promise<unknown | Response> {
	const origin = request.headers.get("origin");
	if (
		request.headers.get("sec-fetch-site") === "cross-site" ||
		(origin &&
			origin !==
				(accountEmailBaseUrl(process.env.APP_BASE_URL) ??
					new URL(request.url).origin))
	) {
		return Response.json({ detail: "forbidden" }, { status: 403 });
	}
	if (
		!/^application\/json(?:\s*;|$)/i.test(
			request.headers.get("content-type") ?? "",
		)
	) {
		return Response.json(
			{ detail: "application/json required" },
			{ status: 415 },
		);
	}
	const reader = request.body?.getReader();
	if (!reader)
		return Response.json({ detail: "invalid JSON body" }, { status: 400 });
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > 4096) {
				await reader.cancel();
				return Response.json({ detail: "body too large" }, { status: 413 });
			}
			chunks.push(value);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return Response.json({ detail: "invalid JSON body" }, { status: 400 });
	} finally {
		reader.releaseLock();
	}
}

export async function limitInviteRequest(
	request: Request,
	action: string,
	subject?: string,
) {
	try {
		const subjects = [`ip:${resolveClientAddress(request)}`];
		if (subject) subjects.push(`subject:${subject}`);
		for (const key of subjects) {
			const rate = await consumeFixedWindow({
				namespace: `invite-${action}`,
				subject: key,
				limit: action === "preview" ? 60 : 10,
				windowSeconds: 900,
			});
			if (!rate.ok)
				return Response.json(
					{ detail: "too many requests" },
					{
						status: 429,
						headers: { "Retry-After": String(rate.retryAfterSeconds) },
					},
				);
		}
		return null;
	} catch {
		return Response.json(
			{ detail: "service temporarily unavailable" },
			{ status: 503 },
		);
	}
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
	const parsedEmail = inviteEmailSchema.safeParse(input.email);
	const email = parsedEmail.success ? parsedEmail.data : "";
	const role = input.role.trim();
	if (!parsedEmail.success) {
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
	const created = await db.transaction(async (tx) => {
		// Serialize writers while allowing account-email FK KEY SHARE locks.
		const [workspace] = await tx
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
			.limit(1)
			.for("no key update");
		if (!workspace) {
			return { ok: false as const, status: 404, detail: "workspace not found" };
		}
		const [actor] = await tx
			.select({ role: workspaceMembers.role })
			.from(workspaceMembers)
			.innerJoin(users, eq(users.id, workspaceMembers.userId))
			.innerJoin(organizations, eq(organizations.id, users.organizationId))
			.where(
				and(
					eq(workspaceMembers.workspaceId, workspace.id),
					eq(users.id, input.identity.principalId),
					eq(users.organizationId, workspace.organizationId),
					eq(users.status, "active"),
					eq(organizations.status, "active"),
				),
			)
			.for("share");
		if (!actor || !["owner", "admin"].includes(actor.role)) {
			return { ok: false as const, status: 403, detail: "forbidden" };
		}

		const existingMembers = await tx
			.select({ userId: users.id })
			.from(workspaceMembers)
			.innerJoin(users, eq(users.id, workspaceMembers.userId))
			.where(
				and(
					eq(workspaceMembers.workspaceId, workspace.id),
					sql`lower(${users.email}) = ${email}`,
				),
			)
			.limit(1);
		if (existingMembers.length > 0) {
			return {
				ok: false as const,
				status: 409,
				detail: "user is already a member",
			};
		}

		await tx
			.update(workspaceInvites)
			.set({ status: "revoked", updatedAt: new Date() })
			.where(
				and(
					eq(workspaceInvites.workspaceId, workspace.id),
					sql`lower(${workspaceInvites.email}) = ${email}`,
					eq(workspaceInvites.status, "pending"),
				),
			);

		const rawToken = randomBytes(32).toString("base64url");
		const tokenHash = hashInviteToken(rawToken);
		const expiresAt = new Date(Date.now() + DEFAULT_TTL_MS);
		const [invite] = await tx
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
		await tx.insert(auditLogs).values({
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
			actorId: input.identity.principalId,
			action: "workspace.invite.created",
			resourceType: "workspace_invite",
			resourceId: invite.id,
			details: { role },
		});
		return { ok: true as const, invite, rawToken, workspace };
	});
	if (!created.ok) return created;
	const { invite, rawToken, workspace } = created;

	const inviteUrl = buildInviteUrl(input.origin, rawToken);
	let emailDelivery: Awaited<ReturnType<typeof sendInviteEmail>> = {
		sent: false,
		provider: "none",
		reason: "copy_link_only",
	};
	if (
		input.sendEmail !== false &&
		!accountEmailBaseUrl(process.env.APP_BASE_URL)
	) {
		emailDelivery = {
			sent: false,
			provider: "none",
			reason: "app_base_url_not_configured",
		};
	} else if (input.sendEmail !== false) {
		try {
			emailDelivery = await sendInviteEmail({
				inviteId: invite.id,
				to: email,
				inviteUrl,
				workspaceName: workspace.name,
				role,
			});
		} catch {
			emailDelivery = { sent: false, provider: "none", reason: "send_failed" };
		}
	}
	try {
		await db.transaction(async (tx) => {
			if (emailDelivery.sent) {
				await tx
					.update(workspaceInvites)
					.set({ lastSentAt: new Date(), updatedAt: new Date() })
					.where(eq(workspaceInvites.id, invite.id));
			}
			await tx.insert(auditLogs).values({
				organizationId: workspace.organizationId,
				workspaceId: workspace.id,
				actorId: input.identity.principalId,
				action: "workspace.invite.email",
				resourceType: "workspace_invite",
				resourceId: invite.id,
				details: {
					accepted: emailDelivery.sent,
					provider: emailDelivery.provider,
					reason: inviteEmailReason(emailDelivery),
					messageId:
						emailDelivery.sent &&
						emailDelivery.messageId &&
						/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
							emailDelivery.messageId,
						)
							? emailDelivery.messageId
							: null,
				},
			});
		});
	} catch {
		// The invite is already committed; diagnostics must not discard its copy URL.
		logger.warn({
			event: "workspace.invite.email_audit_failed",
			inviteId: invite.id,
		});
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
	const revoked = await db
		.update(workspaceInvites)
		.set({ status: "revoked", updatedAt: new Date() })
		.where(
			and(
				eq(workspaceInvites.id, row.id),
				eq(workspaceInvites.status, "pending"),
			),
		)
		.returning({ id: workspaceInvites.id });
	if (!revoked.length)
		return { ok: false, status: 409, detail: "invite is not pending" };
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
	const [account] = await db
		.select({ id: users.id })
		.from(users)
		.innerJoin(
			workspaceInvites,
			eq(workspaceInvites.organizationId, users.organizationId),
		)
		.where(
			and(
				eq(workspaceInvites.id, row.id),
				eq(workspaceInvites.status, "pending"),
				sql`${workspaceInvites.expiresAt} > now()`,
				sql`lower(${users.email}) = ${normalizeEmail(row.email)}`,
			),
		)
		.limit(1);
	const expired =
		row.status === "pending" && row.expiresAt.getTime() <= Date.now();
	return {
		email: row.email,
		role: row.role,
		workspaceName: row.workspaceName,
		expiresAt: row.expiresAt,
		status: expired ? "expired" : row.status,
		existingAccount: Boolean(account),
	};
}

export type AcceptedInvite = {
	ok: true;
	identity: AuthIdentity;
	credentialVersion: string;
};

export async function acceptInvite(input: {
	rawToken: string;
	password: string;
	displayName?: string;
}): Promise<AcceptedInvite | { ok: false; status: number; detail: string }> {
	const fail = (status: number, detail: string) => ({
		ok: false as const,
		status,
		detail,
	});
	if (!inviteTokenSchema.safeParse(input.rawToken).success)
		return fail(404, "invite not found");
	if (
		typeof input.password !== "string" ||
		!input.password ||
		input.password.length > 4096
	) {
		return fail(400, "password is required");
	}
	const db = getDatabase();
	const tokenHash = hashInviteToken(input.rawToken);
	const result = await db.transaction(async (tx) => {
		// NO KEY UPDATE preserves FK references; workspace -> invite matches creation.
		const [hint] = await tx
			.select({ workspaceId: workspaceInvites.workspaceId })
			.from(workspaceInvites)
			.where(eq(workspaceInvites.tokenHash, tokenHash))
			.limit(1);
		if (!hint) return fail(404, "invite not found");
		const [workspace] = await tx
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, hint.workspaceId))
			.for("no key update");
		if (workspace?.status !== "active")
			return fail(403, "workspace unavailable");
		const [organization] = await tx
			.select()
			.from(organizations)
			.where(eq(organizations.id, workspace.organizationId))
			.for("share");
		if (organization?.status !== "active")
			return fail(403, "organization unavailable");
		const [invite] = await tx
			.select()
			.from(workspaceInvites)
			.where(eq(workspaceInvites.tokenHash, tokenHash))
			.for("update");
		if (!invite || invite.organizationId !== workspace.organizationId)
			return fail(404, "invite not found");
		if (invite.status !== "pending") return fail(409, "invite is not pending");
		if (invite.expiresAt.getTime() <= Date.now())
			return fail(410, "invite expired");
		if (!isAssignableInviteRole(invite.role))
			return fail(403, "invalid invite role");
		const email = normalizeEmail(invite.email);
		// Serialize account creation across invitations in different workspaces.
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`${invite.organizationId}:${email}`}, 0))`,
		);
		const accounts = await tx
			.select()
			.from(users)
			.where(
				and(
					eq(users.organizationId, invite.organizationId),
					sql`lower(${users.email}) = ${email}`,
				),
			)
			.limit(2)
			.for("no key update");
		if (accounts.length > 1) return fail(403, "account unavailable");
		const existing = accounts[0];
		let userId: string;
		let credentialVersion: string;
		if (existing) {
			if (existing.status !== "active") return fail(403, "user is disabled");
			// Credentials, not the deployment-defined external subject, identify local accounts.
			const [credential] = await tx
				.select()
				.from(localCredentials)
				.where(eq(localCredentials.userId, existing.id))
				.for("update");
			if (!credential) return fail(403, "local credentials required");
			if (
				credential.lockedUntil &&
				credential.lockedUntil.getTime() > Date.now()
			) {
				return fail(403, "account is locked");
			}
			if (!verifyPasswordSync(input.password, credential.passwordHash))
				return fail(403, "invalid password");
			const [membership] = await tx
				.select({ userId: workspaceMembers.userId })
				.from(workspaceMembers)
				.where(
					and(
						eq(workspaceMembers.workspaceId, workspace.id),
						eq(workspaceMembers.userId, existing.id),
					),
				);
			if (membership) return fail(409, "user is already a member");
			userId = existing.id;
			credentialVersion = String(credential.passwordChangedAt.getTime());
			if (invite.expiresAt.getTime() <= Date.now())
				return fail(410, "invite expired");
		} else {
			const passwordError = validatePassword(input.password);
			if (passwordError) return fail(400, passwordError);
			const displayName =
				input.displayName?.trim() || email.split("@")[0] || "Member";
			if (displayName.length > 256) return fail(400, "display name too long");
			const passwordHash = await hashPasswordAsync(input.password);
			if (invite.expiresAt.getTime() <= Date.now())
				return fail(410, "invite expired");
			const [created] = await tx
				.insert(users)
				.values({
					organizationId: invite.organizationId,
					externalSubject: `local:${email}`,
					email,
					displayName,
					status: "active",
				})
				.returning({ id: users.id });
			userId = created.id;
			const [credential] = await tx
				.insert(localCredentials)
				.values({
					userId,
					passwordHash,
				})
				.returning({ passwordChangedAt: localCredentials.passwordChangedAt });
			credentialVersion = String(credential.passwordChangedAt.getTime());
		}
		const now = new Date();
		await tx
			.insert(workspaceMembers)
			.values({ workspaceId: workspace.id, userId, role: invite.role });
		await tx
			.update(workspaceInvites)
			.set({
				status: "accepted",
				acceptedAt: now,
				acceptedUserId: userId,
				updatedAt: now,
			})
			.where(eq(workspaceInvites.id, invite.id));
		await tx.insert(auditLogs).values({
			organizationId: invite.organizationId,
			workspaceId: workspace.id,
			actorId: userId,
			action: "workspace.invite.accepted",
			resourceType: "workspace_invite",
			resourceId: invite.id,
			details: {},
		});
		return {
			ok: true as const,
			userId,
			workspaceId: workspace.id,
			credentialVersion,
		};
	});
	if (!result.ok) return result;
	const identity = await hydrateIdentity(
		result.userId,
		result.workspaceId,
		"local",
	);
	if (!identity) return fail(403, "account unavailable; please sign in");
	return { ok: true, identity, credentialVersion: result.credentialVersion };
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

/**
 * Revoke workspace access for a member.
 * Does NOT cascade-delete documents, chunks, audit, or threads.
 */
export async function removeWorkspaceMember(input: {
	identity: AuthIdentity;
	userId: string;
}): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
	const userId = input.userId.trim();
	if (!userId) {
		return { ok: false, status: 400, detail: "user_id is required" };
	}
	if (userId === input.identity.principalId) {
		return { ok: false, status: 400, detail: "cannot remove yourself" };
	}

	const db = getDatabase();
	const workspaceId = input.identity.workspaceId;
	const [target] = await db
		.select({
			userId: workspaceMembers.userId,
			role: workspaceMembers.role,
			email: users.email,
		})
		.from(workspaceMembers)
		.innerJoin(users, eq(users.id, workspaceMembers.userId))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(workspaceMembers.userId, userId),
			),
		)
		.limit(1);
	if (!target) {
		return { ok: false, status: 404, detail: "member not found" };
	}

	const gate = authorizeRemoveMember({
		actorPrincipalId: input.identity.principalId,
		targetUserId: target.userId,
		targetRole: target.role,
	});
	if (!gate.ok) {
		return {
			ok: false,
			status: gate.status ?? 403,
			detail: gate.detail ?? "forbidden",
		};
	}

	const now = new Date();
	await db.transaction(async (tx) => {
		await tx
			.delete(workspaceMembers)
			.where(
				and(
					eq(workspaceMembers.workspaceId, workspaceId),
					eq(workspaceMembers.userId, userId),
				),
			);

		const workspaceDocIds = tx
			.select({ id: documents.id })
			.from(documents)
			.where(eq(documents.workspaceId, workspaceId));

		await tx
			.delete(documentAcl)
			.where(
				and(
					eq(documentAcl.subjectId, userId),
					inArray(documentAcl.subjectType, ["principal", "user"]),
					inArray(documentAcl.documentId, workspaceDocIds),
				),
			);

		if (target.email) {
			await tx
				.update(workspaceInvites)
				.set({ status: "revoked", updatedAt: now })
				.where(
					and(
						eq(workspaceInvites.workspaceId, workspaceId),
						eq(workspaceInvites.email, normalizeEmail(target.email)),
						eq(workspaceInvites.status, "pending"),
					),
				);
		}
	});

	return { ok: true };
}
