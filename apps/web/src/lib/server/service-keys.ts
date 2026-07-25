import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";

import { getDatabase } from "@/db";
import { workspaceServiceKeys } from "@/db/schema";
import type { AuthIdentity } from "@/lib/server/auth/provider";
import {
	KEY_PREFIX,
	SERVICE_KEY_SCOPES,
	extractBearerServiceKey as extractBearerFromHeaders,
	generateServiceKeyRaw,
	hashServiceKey,
	normalizeLibraryIds,
	normalizeScopes,
	principalForServiceKey,
	serviceKeyAllowsLibrary as allowsLibrary,
	serviceKeyHasScope as hasScope,
} from "@/lib/server/service-keys-core.mjs";

export { SERVICE_KEY_SCOPES, hashServiceKey, generateServiceKeyRaw };
export type ServiceKeyScope = (typeof SERVICE_KEY_SCOPES)[number];

export type ServiceKeyRecord = {
	id: string;
	organizationId: string;
	workspaceId: string;
	name: string;
	prefix: string;
	scopes: string[];
	libraryIds: string[] | null;
	createdBy: string | null;
	revokedAt: Date | null;
	lastUsedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

export type AuthenticatedServiceKey = ServiceKeyRecord & {
	principalId: string;
};

function toPublicRow(row: typeof workspaceServiceKeys.$inferSelect) {
	const scopes = Array.isArray(row.scopes) ? row.scopes : [];
	return {
		id: row.id,
		name: row.name,
		prefix: row.prefix,
		scopes,
		library_ids: row.libraryIds,
		created_by: row.createdBy,
		revoked_at: row.revokedAt?.toISOString() ?? null,
		last_used_at: row.lastUsedAt?.toISOString() ?? null,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

export async function listWorkspaceServiceKeys(workspaceId: string) {
	const db = getDatabase();
	const rows = await db
		.select()
		.from(workspaceServiceKeys)
		.where(eq(workspaceServiceKeys.workspaceId, workspaceId))
		.orderBy(desc(workspaceServiceKeys.createdAt))
		.limit(100);
	return rows.map(toPublicRow);
}

export async function createWorkspaceServiceKey(input: {
	identity: AuthIdentity;
	name: string;
	scopes?: unknown;
	libraryIds?: unknown;
}): Promise<
	| { ok: true; key: ReturnType<typeof toPublicRow> & { key: string } }
	| { ok: false; status: number; detail: string }
> {
	const name = input.name.trim().slice(0, 128);
	if (!name) {
		return { ok: false, status: 400, detail: "name is required" };
	}
	const scopes = (normalizeScopes(input.scopes) as ServiceKeyScope[] | null) ?? [
		"ask",
		"retrieve",
	];
	const libraryIds = normalizeLibraryIds(input.libraryIds) as string[] | null;
	const { rawKey, prefix } = generateServiceKeyRaw();
	const keyHash = hashServiceKey(rawKey);
	const db = getDatabase();
	const [row] = await db
		.insert(workspaceServiceKeys)
		.values({
			organizationId: input.identity.tenantId,
			workspaceId: input.identity.workspaceId,
			name,
			prefix,
			keyHash,
			scopes,
			libraryIds,
			createdBy: input.identity.principalId,
		})
		.returning();
	if (!row) {
		return { ok: false, status: 500, detail: "failed to create service key" };
	}
	return {
		ok: true,
		key: {
			...toPublicRow(row),
			key: rawKey,
		},
	};
}

export async function revokeWorkspaceServiceKey(input: {
	identity: AuthIdentity;
	keyId: string;
}): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
	const keyId = input.keyId.trim();
	if (!keyId) {
		return { ok: false, status: 400, detail: "key id is required" };
	}
	const db = getDatabase();
	const [existing] = await db
		.select({
			id: workspaceServiceKeys.id,
			revokedAt: workspaceServiceKeys.revokedAt,
		})
		.from(workspaceServiceKeys)
		.where(
			and(
				eq(workspaceServiceKeys.id, keyId),
				eq(workspaceServiceKeys.workspaceId, input.identity.workspaceId),
			),
		)
		.limit(1);
	if (!existing) {
		return { ok: false, status: 404, detail: "service key not found" };
	}
	if (existing.revokedAt) {
		return { ok: true };
	}
	const now = new Date();
	await db
		.update(workspaceServiceKeys)
		.set({ revokedAt: now, updatedAt: now })
		.where(eq(workspaceServiceKeys.id, keyId));
	return { ok: true };
}

export function extractBearerServiceKey(request: Request): string | null {
	return extractBearerFromHeaders(
		request.headers.get("authorization") ??
			request.headers.get("Authorization"),
		request.headers.get("x-meriknow-service-key"),
	);
}

export async function authenticateServiceKey(
	rawKey: string,
): Promise<AuthenticatedServiceKey | null> {
	const trimmed = rawKey.trim();
	if (
		!trimmed.startsWith(KEY_PREFIX) ||
		trimmed.length < KEY_PREFIX.length + 16
	) {
		return null;
	}
	const keyHash = hashServiceKey(trimmed);
	const db = getDatabase();
	const [row] = await db
		.select()
		.from(workspaceServiceKeys)
		.where(
			and(
				eq(workspaceServiceKeys.keyHash, keyHash),
				isNull(workspaceServiceKeys.revokedAt),
			),
		)
		.limit(1);
	if (!row) return null;

	void db
		.update(workspaceServiceKeys)
		.set({ lastUsedAt: new Date() })
		.where(eq(workspaceServiceKeys.id, row.id))
		.catch(() => undefined);

	const scopes = Array.isArray(row.scopes) ? row.scopes : [];
	return {
		id: row.id,
		organizationId: row.organizationId,
		workspaceId: row.workspaceId,
		name: row.name,
		prefix: row.prefix,
		scopes,
		libraryIds: row.libraryIds,
		createdBy: row.createdBy,
		revokedAt: row.revokedAt,
		lastUsedAt: row.lastUsedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		principalId: principalForServiceKey(row.id),
	};
}

export function serviceKeyHasScope(
	key: AuthenticatedServiceKey,
	scope: ServiceKeyScope,
): boolean {
	return hasScope(key, scope);
}

export function serviceKeyAllowsLibrary(
	key: AuthenticatedServiceKey,
	libraryId: string,
): boolean {
	return allowsLibrary(key, libraryId);
}

export function serviceKeyToIdentity(
	key: AuthenticatedServiceKey,
): AuthIdentity {
	return {
		tenantId: key.organizationId,
		workspaceId: key.workspaceId,
		principalId: key.principalId,
		groupIds: [],
		role: "service",
		email: null,
		displayName: key.name,
		provider: "local",
	};
}
