import "server-only";

import { createHash } from "node:crypto";

import { and, asc, desc, eq, gt } from "drizzle-orm";
import * as oidc from "openid-client";

import { getDatabase } from "@/db";
import {
	auditLogs,
	authIdentities,
	organizations,
	users,
	workspaceInvites,
	workspaceMembers,
	workspaces,
} from "@/db/schema";
import { type OidcSettings, readOidcSettings } from "./config";
import type {
	AuthIdentity,
	OidcCallbackInput,
	OidcIdentityProvider,
} from "./provider";
import { hydrateIdentity } from "./session";

export type OidcClaims = Readonly<{
	iss: string;
	sub: string;
	email?: string;
	email_verified?: boolean;
	name?: string;
	preferred_username?: string;
}>;

let configurationCache:
	| { key: string; promise: Promise<oidc.Configuration> }
	| undefined;

function configurationKey(settings: OidcSettings): string {
	return [
		settings.issuerUrl,
		settings.clientId,
		settings.clientAuthMethod,
	].join("\u0000");
}

async function oidcConfiguration(
	settings: OidcSettings,
): Promise<oidc.Configuration> {
	const key = configurationKey(settings);
	if (configurationCache?.key === key) return configurationCache.promise;
	const authentication =
		settings.clientAuthMethod === "client_secret_basic"
			? oidc.ClientSecretBasic(settings.clientSecret)
			: oidc.ClientSecretPost(settings.clientSecret);
	const promise = oidc.discovery(
		new URL(settings.issuerUrl),
		settings.clientId,
		{
			client_secret: settings.clientSecret,
			token_endpoint_auth_method: settings.clientAuthMethod,
		},
		authentication,
	);
	configurationCache = { key, promise };
	try {
		return await promise;
	} catch (error) {
		if (configurationCache?.promise === promise) configurationCache = undefined;
		throw error;
	}
}

function normalizeEmail(value: string | undefined): string | null {
	const email = value?.trim().toLowerCase() ?? "";
	return email && email.length <= 320 ? email : null;
}

function displayNameFor(claims: OidcClaims, email: string | null): string {
	return (
		claims.name?.trim() ||
		claims.preferred_username?.trim() ||
		email?.split("@")[0] ||
		"OIDC User"
	).slice(0, 256);
}

function legacyExternalSubject(issuer: string, subject: string): string {
	const digest = createHash("sha256")
		.update(`${issuer}\u0000${subject}`, "utf8")
		.digest("hex");
	return `oidc:${digest}`;
}

export async function resolveOidcClaimsIdentity(
	settings: OidcSettings,
	claims: OidcClaims,
): Promise<AuthIdentity | null> {
	const issuer = claims.iss?.trim();
	const subject = claims.sub?.trim();
	if (!issuer || !subject || issuer !== settings.issuerUrl) return null;

	const email = normalizeEmail(claims.email);
	const emailCanLink =
		Boolean(email) &&
		(claims.email_verified === true || settings.trustEmailClaim);
	const displayName = displayNameFor(claims, email);
	const now = new Date();
	const db = getDatabase();

	const binding = await db.transaction(async (tx) => {
		const [organization] = await tx
			.select({ id: organizations.id })
			.from(organizations)
			.where(
				and(
					eq(organizations.id, settings.organizationId),
					eq(organizations.status, "active"),
				),
			)
			.limit(1);
		if (!organization) return null;

		const [bound] = await tx
			.select({
				userId: authIdentities.userId,
				status: users.status,
			})
			.from(authIdentities)
			.innerJoin(users, eq(users.id, authIdentities.userId))
			.where(
				and(
					eq(authIdentities.provider, "oidc"),
					eq(authIdentities.organizationId, settings.organizationId),
					eq(authIdentities.issuer, issuer),
					eq(authIdentities.subject, subject),
					eq(users.organizationId, settings.organizationId),
				),
			)
			.limit(1);

		let userId = bound?.userId;
		if (bound && bound.status !== "active") return null;

		if (!userId) {
			if (!emailCanLink || !email) return null;
			const matchingUsers = await tx
				.select({ id: users.id, status: users.status })
				.from(users)
				.where(
					and(
						eq(users.organizationId, settings.organizationId),
						eq(users.email, email),
					),
				)
				.limit(2);
			if (
				matchingUsers.length > 1 ||
				(matchingUsers[0] && matchingUsers[0].status !== "active")
			) {
				return null;
			}
			userId = matchingUsers[0]?.id;

			if (!userId) {
				const invites = await tx
					.select({
						id: workspaceInvites.id,
						workspaceId: workspaceInvites.workspaceId,
						role: workspaceInvites.role,
					})
					.from(workspaceInvites)
					.innerJoin(
						workspaces,
						and(
							eq(workspaces.id, workspaceInvites.workspaceId),
							eq(workspaces.organizationId, settings.organizationId),
							eq(workspaces.status, "active"),
						),
					)
					.where(
						and(
							eq(workspaceInvites.organizationId, settings.organizationId),
							eq(workspaceInvites.email, email),
							eq(workspaceInvites.status, "pending"),
							gt(workspaceInvites.expiresAt, now),
						),
					)
					.orderBy(desc(workspaceInvites.createdAt));
				if (invites.length === 0) return null;

				const [created] = await tx
					.insert(users)
					.values({
						organizationId: settings.organizationId,
						externalSubject: legacyExternalSubject(issuer, subject),
						email,
						displayName,
						status: "active",
						lastLoginAt: now,
					})
					.returning({ id: users.id });
				userId = created.id;

				const seenWorkspaces = new Set<string>();
				for (const invite of invites) {
					if (!seenWorkspaces.has(invite.workspaceId)) {
						seenWorkspaces.add(invite.workspaceId);
						await tx
							.insert(workspaceMembers)
							.values({
								workspaceId: invite.workspaceId,
								userId,
								role: invite.role,
							})
							.onConflictDoNothing();
					}
					await tx
						.update(workspaceInvites)
						.set({
							status: "accepted",
							acceptedAt: now,
							acceptedUserId: userId,
							updatedAt: now,
						})
						.where(
							and(
								eq(workspaceInvites.id, invite.id),
								eq(workspaceInvites.status, "pending"),
							),
						);
				}
			}

			await tx
				.insert(authIdentities)
				.values({
					organizationId: settings.organizationId,
					userId,
					provider: "oidc",
					issuer,
					subject,
					lastLoginAt: now,
				})
				.onConflictDoNothing();

			const [authoritativeBinding] = await tx
				.select({ userId: authIdentities.userId })
				.from(authIdentities)
				.where(
					and(
						eq(authIdentities.organizationId, settings.organizationId),
						eq(authIdentities.issuer, issuer),
						eq(authIdentities.subject, subject),
					),
				)
				.limit(1);
			if (authoritativeBinding?.userId !== userId) {
				throw new Error("OIDC identity binding conflict");
			}
		}

		await tx
			.update(authIdentities)
			.set({ lastLoginAt: now, updatedAt: now })
			.where(
				and(
					eq(authIdentities.organizationId, settings.organizationId),
					eq(authIdentities.issuer, issuer),
					eq(authIdentities.subject, subject),
				),
			);
		await tx
			.update(users)
			.set({ lastLoginAt: now, updatedAt: now })
			.where(eq(users.id, userId));

		const [membership] = await tx
			.select({ workspaceId: workspaceMembers.workspaceId })
			.from(workspaceMembers)
			.innerJoin(
				workspaces,
				and(
					eq(workspaces.id, workspaceMembers.workspaceId),
					eq(workspaces.organizationId, settings.organizationId),
					eq(workspaces.status, "active"),
				),
			)
			.where(eq(workspaceMembers.userId, userId))
			.orderBy(asc(workspaceMembers.createdAt))
			.limit(1);
		if (!membership) return null;
		await tx.insert(auditLogs).values({
			organizationId: settings.organizationId,
			workspaceId: membership.workspaceId,
			actorId: userId,
			action: "auth.oidc.login",
			resourceType: "user",
			resourceId: userId,
			details: { provider: "oidc" },
		});
		return { userId, workspaceId: membership.workspaceId };
	});

	return binding
		? hydrateIdentity(binding.userId, binding.workspaceId, "oidc")
		: null;
}

export const oidcIdentityProvider: OidcIdentityProvider = {
	id: "oidc",
	async authorizationUrl(input) {
		const settings = readOidcSettings();
		const config = await oidcConfiguration(settings);
		return oidc.buildAuthorizationUrl(config, {
			redirect_uri: input.redirectUri,
			scope: settings.scopes,
			response_type: "code",
			state: input.state,
			nonce: input.nonce,
			code_challenge: input.codeChallenge,
			code_challenge_method: "S256",
		}).href;
	},
	async authenticate(input: OidcCallbackInput) {
		const settings = readOidcSettings();
		const config = await oidcConfiguration(settings);
		const tokens = await oidc.authorizationCodeGrant(config, input.currentUrl, {
			pkceCodeVerifier: input.codeVerifier,
			expectedState: input.expectedState,
			expectedNonce: input.expectedNonce,
			idTokenExpected: true,
		});
		const claims = tokens.claims() as OidcClaims | undefined;
		return claims
			? resolveOidcClaimsIdentity(
					{
						...settings,
						issuerUrl: config.serverMetadata().issuer,
					},
					claims,
				)
			: null;
	},
};

export const oidcProtocol = {
	randomState: oidc.randomState,
	randomNonce: oidc.randomNonce,
	randomPKCECodeVerifier: oidc.randomPKCECodeVerifier,
	calculatePKCECodeChallenge: oidc.calculatePKCECodeChallenge,
};
