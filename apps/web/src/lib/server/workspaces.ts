import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { getDatabase } from "@/db";
import {
	auditLogs,
	workspaceMembers,
	workspaceSettings,
	workspaces,
} from "@/db/schema";
import type { AuthIdentity } from "@/lib/server/auth/provider";
import { hydrateIdentity } from "@/lib/server/auth/session";
import { canCreateWorkspaces } from "@/lib/server/organization-permissions.mjs";
import { validateWorkspaceCreateInput } from "@/lib/server/workspace-core.mjs";

export type WorkspaceListItem = {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	status: string;
	role: string;
	current: boolean;
};

type CreateWorkspaceResult =
	| { ok: true; workspace: WorkspaceListItem }
	| { ok: false; status: number; detail: string };

function isUniqueViolation(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	if ("code" in error && (error as { code?: unknown }).code === "23505") {
		return true;
	}
	return (
		"cause" in error && isUniqueViolation((error as { cause?: unknown }).cause)
	);
}

export async function listWorkspacesForIdentity(
	identity: AuthIdentity,
): Promise<WorkspaceListItem[]> {
	const rows = await getDatabase()
		.select({
			id: workspaces.id,
			name: workspaces.name,
			slug: workspaces.slug,
			description: workspaces.description,
			status: workspaces.status,
			role: workspaceMembers.role,
		})
		.from(workspaceMembers)
		.innerJoin(
			workspaces,
			and(
				eq(workspaces.id, workspaceMembers.workspaceId),
				eq(workspaces.organizationId, identity.tenantId),
			),
		)
		.where(
			and(
				eq(workspaceMembers.userId, identity.principalId),
				eq(workspaces.status, "active"),
			),
		)
		.orderBy(asc(workspaces.name), asc(workspaces.id));

	return rows.map((row) => ({
		...row,
		current: row.id === identity.workspaceId,
	}));
}

export async function createWorkspaceForIdentity(
	identity: AuthIdentity,
	raw: unknown,
	requestId: string,
): Promise<CreateWorkspaceResult> {
	if (!canCreateWorkspaces(identity)) {
		return {
			ok: false,
			status: 403,
			detail: "organization owner or admin role required",
		};
	}

	const id = requestId;
	const validated = validateWorkspaceCreateInput(raw, `ws-${id.slice(0, 8)}`);
	if (!validated.ok) {
		return validated;
	}
	const now = new Date();

	try {
		const workspace = await getDatabase().transaction(async (tx) => {
			const [created] = await tx
				.insert(workspaces)
				.values({
					id,
					organizationId: identity.tenantId,
					name: validated.value.name,
					slug: validated.value.slug,
					description: validated.value.description,
					status: "active",
					createdAt: now,
					updatedAt: now,
				})
				.returning({
					id: workspaces.id,
					name: workspaces.name,
					slug: workspaces.slug,
					description: workspaces.description,
					status: workspaces.status,
				});
			if (!created) {
				throw new Error("workspace insert returned no row");
			}

			await tx.insert(workspaceMembers).values({
				workspaceId: created.id,
				userId: identity.principalId,
				role: "owner",
				createdAt: now,
				updatedAt: now,
			});
			await tx.insert(workspaceSettings).values({
				workspaceId: created.id,
				ask: {},
				policyVersion: 1,
				updatedBy: identity.principalId,
				createdAt: now,
				updatedAt: now,
			});
			await tx.insert(auditLogs).values({
				organizationId: identity.tenantId,
				workspaceId: created.id,
				actorId: identity.principalId,
				action: "workspace.created",
				resourceType: "workspace",
				resourceId: created.id,
				details: {
					name: created.name,
					slug: created.slug,
					source_workspace_id: identity.workspaceId,
				},
				createdAt: now,
			});

			return created;
		});

		return {
			ok: true,
			workspace: { ...workspace, role: "owner", current: false },
		};
	} catch (error) {
		if (isUniqueViolation(error)) {
			const [existing] = await getDatabase()
				.select({
					id: workspaces.id,
					name: workspaces.name,
					slug: workspaces.slug,
					description: workspaces.description,
					status: workspaces.status,
				})
				.from(workspaces)
				.where(
					and(
						eq(workspaces.id, requestId),
						eq(workspaces.organizationId, identity.tenantId),
					),
				)
				.limit(1);
			if (
				existing &&
				existing.name === validated.value.name &&
				existing.slug === validated.value.slug &&
				existing.description === validated.value.description
			) {
				return {
					ok: true,
					workspace: {
						...existing,
						role: "owner",
						current: existing.id === identity.workspaceId,
					},
				};
			}
			return {
				ok: false,
				status: 409,
				detail: existing
					? "Idempotency-Key was already used with different workspace data"
					: "workspace slug already exists in this organization",
			};
		}
		throw error;
	}
}

export async function resolveWorkspaceSwitchIdentity(
	currentIdentity: AuthIdentity,
	targetWorkspaceId: string,
): Promise<AuthIdentity | null> {
	const nextIdentity = await hydrateIdentity(
		currentIdentity.principalId,
		targetWorkspaceId,
		currentIdentity.provider,
	);
	if (!nextIdentity || nextIdentity.tenantId !== currentIdentity.tenantId) {
		return null;
	}
	return nextIdentity;
}
