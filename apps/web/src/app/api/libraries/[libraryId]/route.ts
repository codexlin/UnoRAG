import { and, eq } from "drizzle-orm";

import { getDatabase } from "@/db";
import { libraries } from "@/db/schema";
import { resolveRequestSession } from "@/lib/server/auth/session";
import {
	canManageLibraries,
	canWriteLibraries,
	findAuthorizedLibrary,
} from "@/lib/server/library-access";
import { proxyRagRequest } from "@/lib/server/rag-proxy";

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
	const [updated] = await db
		.update(libraries)
		.set({
			...(body.name !== undefined
				? { name: body.name.trim().slice(0, 256) }
				: {}),
			...(body.description !== undefined
				? { description: body.description?.trim().slice(0, 2000) || null }
				: {}),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(libraries.id, current.id),
				eq(libraries.organizationId, identity.tenantId),
				eq(libraries.workspaceId, identity.workspaceId),
			),
		)
		.returning();
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
	const cleanupRequest = new Request(
		new URL(
			`/api/rag/v1/libraries/${encodeURIComponent(libraryId)}`,
			request.url,
		),
		{
			method: "DELETE",
			headers: { cookie: request.headers.get("cookie") ?? "" },
		},
	);
	const cleanup = await proxyRagRequest(cleanupRequest, [
		"v1",
		"libraries",
		libraryId,
	]);
	if (!cleanup.ok && cleanup.status !== 404) {
		return Response.json(
			{ detail: "RAG library cleanup failed" },
			{ status: 502 },
		);
	}
	const cleanupResult = cleanup.ok
		? ((await cleanup.clone().json()) as { deleted_documents?: number })
		: {};
	const db = getDatabase();
	await db
		.delete(libraries)
		.where(
			and(
				eq(libraries.id, current.id),
				eq(libraries.organizationId, identity.tenantId),
				eq(libraries.workspaceId, identity.workspaceId),
			),
		);
	return Response.json({
		ok: true,
		library_id: libraryId,
		deleted_documents: cleanupResult.deleted_documents ?? 0,
	});
}
