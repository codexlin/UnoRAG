import { randomUUID } from "node:crypto";

import { and, eq, ne, notInArray } from "drizzle-orm";

import { getDatabase } from "@/db";
import { documents, libraries } from "@/db/schema";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { enqueueDocumentDelete } from "@/lib/server/document-delete-enqueue";
import {
	rejectDeployOnlyParseFields,
	validateDocumentProfile,
	validateParsePreference,
	validateScanHandling,
} from "@/lib/server/document-policy.mjs";
import {
	canManageLibraries,
	canWriteLibraries,
	findAuthorizedLibrary,
} from "@/lib/server/library-access";
import { toApiLibrary } from "@/lib/server/library-api.mjs";
import { staleActiveVersionsSql } from "@/lib/server/library-reindex-sql";

type RouteContext = {
	params: Promise<{ libraryId: string }>;
};

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
	let body: {
		name?: string;
		description?: string | null;
		document_profile?: string;
		scan_handling?: string;
		parse_preference?: string;
	};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return Response.json({ detail: "invalid JSON body" }, { status: 400 });
	}
	const deployOnly = rejectDeployOnlyParseFields(
		body as Record<string, unknown>,
	);
	if (!deployOnly.ok) {
		return Response.json({ detail: deployOnly.detail }, { status: 400 });
	}
	if (
		body.name === undefined &&
		body.description === undefined &&
		body.document_profile === undefined &&
		body.scan_handling === undefined &&
		body.parse_preference === undefined
	) {
		return Response.json(
			{
				detail:
					"name, description, document_profile, scan_handling, or parse_preference is required",
			},
			{ status: 400 },
		);
	}

	let nextProfile: string | undefined;
	if (body.document_profile !== undefined) {
		const profileResult = validateDocumentProfile(body.document_profile);
		if (!profileResult.ok) {
			return Response.json({ detail: profileResult.detail }, { status: 400 });
		}
		nextProfile = profileResult.value;
	}
	let nextScan: string | undefined;
	if (body.scan_handling !== undefined) {
		const scanResult = validateScanHandling(body.scan_handling);
		if (!scanResult.ok) {
			return Response.json({ detail: scanResult.detail }, { status: 400 });
		}
		nextScan = scanResult.value;
	}
	let nextPreference: string | undefined;
	if (body.parse_preference !== undefined) {
		const preferenceResult = validateParsePreference(body.parse_preference);
		if (!preferenceResult.ok) {
			return Response.json(
				{ detail: preferenceResult.detail },
				{ status: 400 },
			);
		}
		nextPreference = preferenceResult.value;
	}

	const profileChanged =
		nextProfile !== undefined && nextProfile !== current.documentProfile;
	const scanChanged =
		nextScan !== undefined && nextScan !== current.scanHandling;
	const preferenceChanged =
		nextPreference !== undefined &&
		nextPreference !== (current.parsePreference ?? "auto");
	const policyChanged = profileChanged || scanChanged || preferenceChanged;

	const db = getDatabase();
	const now = new Date();
	const [updated] = await db
		.update(libraries)
		.set({
			...(body.name !== undefined
				? { name: body.name.trim().slice(0, 256) }
				: {}),
			...(body.description !== undefined
				? { description: body.description?.trim().slice(0, 2000) || null }
				: {}),
			...(nextProfile !== undefined ? { documentProfile: nextProfile } : {}),
			...(nextScan !== undefined ? { scanHandling: nextScan } : {}),
			...(nextPreference !== undefined
				? { parsePreference: nextPreference }
				: {}),
			...(policyChanged
				? {
						ingestPolicyVersion: (current.ingestPolicyVersion ?? 1) + 1,
					}
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
	const [withStale] = await db
		.select({
			ragLibraryId: libraries.ragLibraryId,
			name: libraries.name,
			description: libraries.description,
			status: libraries.status,
			docCount: libraries.docCount,
			readyCount: libraries.readyCount,
			documentProfile: libraries.documentProfile,
			appliedDocumentProfile: libraries.appliedDocumentProfile,
			scanHandling: libraries.scanHandling,
			parsePreference: libraries.parsePreference,
			ingestPolicyVersion: libraries.ingestPolicyVersion,
			staleActiveVersions: staleActiveVersionsSql(),
			createdAt: libraries.createdAt,
			updatedAt: libraries.updatedAt,
		})
		.from(libraries)
		.where(eq(libraries.id, updated.id))
		.limit(1);
	return Response.json(toApiLibrary(withStale ?? updated));
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
