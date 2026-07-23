import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import { getDatabase } from "@/db";
import { libraries } from "@/db/schema";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { canWriteLibraries } from "@/lib/server/library-access";

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

export async function GET(request: Request) {
	const identity = await resolveRequestSession(request);
	if (!identity) {
		return Response.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}
	const db = getDatabase();
	const rows = await db
		.select()
		.from(libraries)
		.where(
			and(
				eq(libraries.organizationId, identity.tenantId),
				eq(libraries.workspaceId, identity.workspaceId),
			),
		)
		.orderBy(desc(libraries.updatedAt));
	return Response.json(rows.map(toApiLibrary));
}

export async function POST(request: Request) {
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
	let body: { name?: string; description?: string | null; library_id?: string };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return Response.json({ detail: "invalid JSON body" }, { status: 400 });
	}
	const name = body.name?.trim();
	if (!name) {
		return Response.json({ detail: "name is required" }, { status: 400 });
	}
	const now = new Date();
	const id = randomUUID();
	const db = getDatabase();
	const [created] = await db
		.insert(libraries)
		.values({
			id,
			organizationId: identity.tenantId,
			workspaceId: identity.workspaceId,
			ragLibraryId: body.library_id?.trim() || id,
			name: name.slice(0, 256),
			description: body.description?.trim().slice(0, 2000) || null,
			createdBy: identity.principalId,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return Response.json(toApiLibrary(created), { status: 201 });
}
