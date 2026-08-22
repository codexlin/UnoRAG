import { randomUUID } from "node:crypto";

import { and, desc, eq, notInArray, sql } from "drizzle-orm";

import { getDatabase } from "@/db";
import { documents, libraries } from "@/db/schema";
import { resolveRequestSession } from "@/lib/server/auth/session";
import {
	DOCUMENT_PROFILE_DEFAULT,
	PARSE_PREFERENCE_DEFAULT,
	rejectDeployOnlyParseFields,
	SCAN_HANDLING_DEFAULT,
	validateDocumentProfile,
	validateParsePreference,
	validateScanHandling,
} from "@/lib/server/document-policy.mjs";
import { documentMetadataVisibilitySql } from "@/lib/server/document-visibility";
import { canWriteLibraries } from "@/lib/server/library-access";
import { toApiLibrary } from "@/lib/server/library-api.mjs";
import { staleActiveVersionsSql } from "@/lib/server/library-reindex-sql";

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
			id: libraries.id,
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
		.where(
			and(
				eq(libraries.organizationId, identity.tenantId),
				eq(libraries.workspaceId, identity.workspaceId),
				notInArray(libraries.status, ["deleted"]),
			),
		)
		.orderBy(desc(libraries.updatedAt));
	if (canWriteLibraries(identity)) {
		return Response.json(rows.map(toApiLibrary));
	}

	const visibleCounts = await db
		.select({
			libraryId: documents.libraryId,
			total: sql<number>`count(*) filter (where ${documents.status} not in ('deleted'))`,
			live: sql<number>`count(*) filter (where ${documents.status} not in ('deleting', 'deleted'))`,
			ready: sql<number>`count(*) filter (where ${documents.status} in ('ready', 'degraded'))`,
			processing: sql<number>`count(*) filter (where ${documents.status} in ('processing', 'deleting'))`,
			failed: sql<number>`count(*) filter (where ${documents.status} = 'failed')`,
		})
		.from(documents)
		.where(
			and(
				eq(documents.organizationId, identity.tenantId),
				eq(documents.workspaceId, identity.workspaceId),
				documentMetadataVisibilitySql(identity, documents.id),
			),
		)
		.groupBy(documents.libraryId);
	const countsByLibrary = new Map(
		visibleCounts.map((counts) => [counts.libraryId, counts]),
	);
	return Response.json(
		rows.map((row) => {
			const counts = countsByLibrary.get(row.id);
			const total = Number(counts?.total ?? 0);
			const live = Number(counts?.live ?? 0);
			const ready = Number(counts?.ready ?? 0);
			const processing = Number(counts?.processing ?? 0);
			const failed = Number(counts?.failed ?? 0);
			const status =
				row.status === "deleting"
					? "deleting"
					: live === 0
						? "empty"
						: processing > 0
							? "indexing"
							: ready === live
								? "ready"
								: ready > 0
									? "degraded"
									: failed > 0
										? "failed"
										: "empty";
			return toApiLibrary({
				...row,
				status,
				docCount: total,
				readyCount: ready,
				staleActiveVersions: 0,
			});
		}),
	);
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
	const preferenceResult = validateParsePreference(
		body.parse_preference ?? PARSE_PREFERENCE_DEFAULT,
	);
	if (!preferenceResult.ok) {
		return Response.json({ detail: preferenceResult.detail }, { status: 400 });
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
	const [created] = await db
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
			parsePreference: preferenceResult.value,
			ingestPolicyVersion: 1,
			createdBy: identity.principalId,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return Response.json(toApiLibrary(created), { status: 201 });
}
