import { randomUUID } from "node:crypto";

import { and, desc, eq, notInArray } from "drizzle-orm";

import { getDatabase } from "@/db";
import { libraries, outboxEvents } from "@/db/schema";
import { resolveRequestSession } from "@/lib/server/auth/session";
import {
	DOCUMENT_PROFILE_DEFAULT,
	SCAN_HANDLING_DEFAULT,
	validateDocumentProfile,
	validateScanHandling,
} from "@/lib/server/document-policy.mjs";
import { canWriteLibraries } from "@/lib/server/library-access";
import { toApiLibrary } from "@/lib/server/library-api.mjs";
import { staleActiveVersionsSql } from "@/lib/server/library-reindex-sql";
import { runOutboxMutation } from "@/lib/server/outbox-transaction.mjs";

const RAG_LIBRARY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
			ingestPolicyVersion: libraries.ingestPolicyVersion,
			staleActiveVersions: staleActiveVersionsSql(),
			createdAt: libraries.createdAt,
			updatedAt: libraries.updatedAt,
		})
		.from(libraries)
		.where(
			and(
				eq(libraries.organizationId, identity.tenantId),
				eq(libraries.workspaceId, identity.workspaceId),
				notInArray(libraries.status, ["deleted"]),
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
	let body: {
		name?: string;
		description?: string | null;
		library_id?: string;
		document_profile?: string;
		scan_handling?: string;
	};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return Response.json({ detail: "invalid JSON body" }, { status: 400 });
	}
	const name = body.name?.trim();
	if (!name) {
		return Response.json({ detail: "name is required" }, { status: 400 });
	}
	const profileResult = validateDocumentProfile(
		body.document_profile ?? DOCUMENT_PROFILE_DEFAULT,
	);
	if (!profileResult.ok) {
		return Response.json({ detail: profileResult.detail }, { status: 400 });
	}
	const scanResult = validateScanHandling(
		body.scan_handling ?? SCAN_HANDLING_DEFAULT,
	);
	if (!scanResult.ok) {
		return Response.json({ detail: scanResult.detail }, { status: 400 });
	}
	const now = new Date();
	const id = randomUUID();
	const ragLibraryId = body.library_id?.trim() || id;
	if (!RAG_LIBRARY_ID_PATTERN.test(ragLibraryId)) {
		return Response.json(
			{
				detail:
					"library_id must be 1-128 characters using letters, numbers, dot, underscore, colon, or hyphen",
			},
			{ status: 400 },
		);
	}
	const db = getDatabase();
	const created = await runOutboxMutation(
		db,
		async (tx) => {
			const [row] = await tx
				.insert(libraries)
				.values({
					id,
					organizationId: identity.tenantId,
					workspaceId: identity.workspaceId,
					ragLibraryId,
					name: name.slice(0, 256),
					description: body.description?.trim().slice(0, 2000) || null,
					documentProfile: profileResult.value,
					scanHandling: scanResult.value,
					ingestPolicyVersion: 1,
					createdBy: identity.principalId,
					createdAt: now,
					updatedAt: now,
				})
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
					document_profile: row.documentProfile,
					scan_handling: row.scanHandling,
					principal_id: identity.principalId,
				},
				createdAt: now,
				updatedAt: now,
			}),
	);
	return Response.json(toApiLibrary(created), { status: 201 });
}
