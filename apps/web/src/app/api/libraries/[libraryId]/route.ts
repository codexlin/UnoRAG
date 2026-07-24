import { randomUUID } from "node:crypto";

import { and, eq, ne, notInArray } from "drizzle-orm";

import { getDatabase } from "@/db";
import { documents, libraries, outboxEvents } from "@/db/schema";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { enqueueDocumentDelete } from "@/lib/server/document-delete-enqueue";
import { documentLifecycleV2Enabled } from "@/lib/server/document-lifecycle";
import {
	canManageLibraries,
	canWriteLibraries,
	findAuthorizedLibrary,
} from "@/lib/server/library-access";
import { runOutboxMutation } from "@/lib/server/outbox-transaction.mjs";

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
	if (current.status === "deleting" || current.status === "deleted") {
		return Response.json(
			{ detail: "library is being deleted" },
			{ status: 409 },
		);
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
	const updated = await runOutboxMutation(
		db,
		async (tx) => {
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
			return row;
		},
		(tx, row) =>
			tx.insert(outboxEvents).values({
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
			}),
	);
	return Response.json(toApiLibrary(updated));
}

/**
 * Delete a library by fan-out to document.delete jobs (V2) so a large library
 * never blocks a single HTTP request on synchronous RAG cleanup.
 * Empty libraries still hard-delete + enqueue projection cleanup immediately.
 */
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
	if (current.status === "deleted") {
		return Response.json({
			ok: true,
			library_id: libraryId,
			deleted_documents: 0,
			cleanup_queued: false,
			already_deleted: true,
		});
	}

	const db = getDatabase();
	const now = new Date();
	const requestId = request.headers.get("x-request-id") ?? randomUUID();

	if (!documentLifecycleV2Enabled()) {
		await runOutboxMutation(
			db,
			(tx) =>
				tx
					.delete(libraries)
					.where(
						and(
							eq(libraries.id, current.id),
							eq(libraries.organizationId, identity.tenantId),
							eq(libraries.workspaceId, identity.workspaceId),
						),
					),
			(tx) =>
				tx.insert(outboxEvents).values({
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
				}),
		);
		return Response.json({
			ok: true,
			library_id: libraryId,
			deleted_documents: current.docCount,
			cleanup_queued: true,
		});
	}

	const outcome = await db.transaction(async (tx) => {
		const [locked] = await tx
			.select()
			.from(libraries)
			.where(eq(libraries.id, current.id))
			.for("update")
			.limit(1);
		if (!locked || locked.status === "deleted") {
			return {
				queuedJobs: 0,
				documentCount: 0,
				immediate: true as const,
			};
		}

		const liveDocuments = await tx
			.select()
			.from(documents)
			.where(
				and(
					eq(documents.libraryId, locked.id),
					notInArray(documents.status, ["deleted", "deleting"]),
				),
			)
			.for("update");

		if (liveDocuments.length === 0) {
			const deletingDocs = await tx
				.select({ id: documents.id })
				.from(documents)
				.where(
					and(
						eq(documents.libraryId, locked.id),
						ne(documents.status, "deleted"),
					),
				);
			if (deletingDocs.length === 0) {
				await tx.delete(libraries).where(eq(libraries.id, locked.id));
				await tx.insert(outboxEvents).values({
					organizationId: identity.tenantId,
					workspaceId: identity.workspaceId,
					aggregateType: "library",
					aggregateId: locked.ragLibraryId,
					eventType: "library.delete",
					idempotencyKey: `library.delete:${locked.ragLibraryId}:${randomUUID()}`,
					payload: {
						library_id: locked.ragLibraryId,
						principal_id: identity.principalId,
					},
					createdAt: now,
					updatedAt: now,
				});
				return {
					queuedJobs: 0,
					documentCount: 0,
					immediate: true as const,
				};
			}
			await tx
				.update(libraries)
				.set({ status: "deleting", updatedAt: now })
				.where(eq(libraries.id, locked.id));
			return {
				queuedJobs: 0,
				documentCount: deletingDocs.length,
				immediate: false as const,
			};
		}

		await tx
			.update(libraries)
			.set({ status: "deleting", updatedAt: now })
			.where(eq(libraries.id, locked.id));

		let queuedJobs = 0;
		for (const document of liveDocuments) {
			const enqueued = await enqueueDocumentDelete({
				tx,
				identity,
				library: locked,
				document,
				libraryDelete: true,
				requestId,
				now,
			});
			if (!enqueued.alreadyQueued) queuedJobs += 1;
		}
		return {
			queuedJobs,
			documentCount: liveDocuments.length,
			immediate: false as const,
		};
	});

	return Response.json(
		{
			ok: true,
			library_id: libraryId,
			deleted_documents: outcome.documentCount,
			delete_jobs_queued: outcome.queuedJobs,
			cleanup_queued: true,
			status: outcome.immediate ? "deleted" : "deleting",
			accepted: !outcome.immediate,
		},
		{ status: outcome.immediate ? 200 : 202 },
	);
}
