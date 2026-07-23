import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDatabase } from "@/db";
import { libraries, outboxEvents } from "@/db/schema";
import { resolveRequestSession } from "@/lib/server/auth/session";
import {
	canManageLibraries,
	canWriteLibraries,
	findAuthorizedLibrary,
} from "@/lib/server/library-access";

type RouteContext = {
	params: Promise<{ libraryId: string }>;
};

function toApiLibrary(row: typeof libraries.$inferSelect) {
	return {
		id: row.ragLibraryId,
		name: row.name,
		description: row.description,
		status: row.status,
		doc_count: row.docCount,
		ready_count: row.readyCount,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

export async function PATCH(request: Request, context: RouteContext) {
	const identity = await resolveRequestSession(request);
	if (!identity) {
		return Response.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}
	if (!canWriteLibraries(identity)) {
		return Response.json(
			{ detail: "library write permission required" },
			{ status: 403 },
		);
	}
	const { libraryId } = await context.params;
	const current = await findAuthorizedLibrary(identity, libraryId);
	if (!current) {
		return Response.json({ detail: "library not found" }, { status: 404 });
	}
	let body: { name?: string; description?: string | null };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return Response.json({ detail: "invalid JSON body" }, { status: 400 });
	}
	if (body.name === undefined && body.description === undefined) {
		return Response.json(
			{ detail: "name or description is required" },
			{ status: 400 },
		);
	}
	const db = getDatabase();
	const now = new Date();
	const updated = await db.transaction(async (tx) => {
		const [row] = await tx
			.update(libraries)
			.set({
				...(body.name !== undefined
					? { name: body.name.trim().slice(0, 256) }
					: {}),
				...(body.description !== undefined
					? { description: body.description?.trim().slice(0, 2000) || null }
					: {}),
				updatedAt: now,
			})
			.where(
				and(
					eq(libraries.id, current.id),
					eq(libraries.organizationId, identity.tenantId),
					eq(libraries.workspaceId, identity.workspaceId),
				),
			)
			.returning();
		await tx.insert(outboxEvents).values({
			organizationId: identity.tenantId,
			workspaceId: identity.workspaceId,
			aggregateType: "library",
			aggregateId: row.ragLibraryId,
			eventType: "library.upsert",
			idempotencyKey: `library.upsert:${row.ragLibraryId}:${randomUUID()}`,
			payload: {
				library_id: row.ragLibraryId,
				name: row.name,
				description: row.description,
				principal_id: identity.principalId,
			},
			createdAt: now,
			updatedAt: now,
		});
		return row;
	});
	return Response.json(toApiLibrary(updated));
}

export async function DELETE(request: Request, context: RouteContext) {
	const identity = await resolveRequestSession(request);
	if (!identity) {
		return Response.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}
	if (!canManageLibraries(identity)) {
		return Response.json(
			{ detail: "library owner permission required" },
			{ status: 403 },
		);
	}
	const { libraryId } = await context.params;
	const current = await findAuthorizedLibrary(identity, libraryId);
	if (!current) {
		return Response.json({ detail: "library not found" }, { status: 404 });
	}
	const db = getDatabase();
	const now = new Date();
	await db.transaction(async (tx) => {
		await tx.insert(outboxEvents).values({
			organizationId: identity.tenantId,
			workspaceId: identity.workspaceId,
			aggregateType: "library",
			aggregateId: current.ragLibraryId,
			eventType: "library.delete",
			idempotencyKey: `library.delete:${current.ragLibraryId}:${randomUUID()}`,
			payload: {
				library_id: current.ragLibraryId,
				principal_id: identity.principalId,
			},
			createdAt: now,
			updatedAt: now,
		});
		await tx
			.delete(libraries)
			.where(
				and(
					eq(libraries.id, current.id),
					eq(libraries.organizationId, identity.tenantId),
					eq(libraries.workspaceId, identity.workspaceId),
				),
			);
	});
	return Response.json({
		ok: true,
		library_id: libraryId,
		deleted_documents: current.docCount,
		cleanup_queued: true,
	});
}
