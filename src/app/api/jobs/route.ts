import { and, desc, eq, type SQL } from "drizzle-orm";

import { getDatabase } from "@/db";
import { documents, documentVersions, jobs, libraries } from "@/db/schema";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { documentMetadataVisibilitySql } from "@/lib/server/document-visibility";
import { toApiJob } from "@/lib/server/job-access";

export async function GET(request: Request) {
	const identity = await resolveRequestSession(request);
	if (!identity) {
		return Response.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}
	const url = new URL(request.url);
	const libraryId = url.searchParams.get("library_id")?.trim();
	const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
	const limit =
		Number.isSafeInteger(requestedLimit) && requestedLimit > 0
			? Math.min(requestedLimit, 200)
			: 50;
	const conditions: SQL[] = [
		eq(jobs.organizationId, identity.tenantId),
		eq(jobs.workspaceId, identity.workspaceId),
		eq(documents.organizationId, identity.tenantId),
		eq(documents.workspaceId, identity.workspaceId),
		documentMetadataVisibilitySql(identity, documents.id),
	];
	if (libraryId) conditions.push(eq(libraries.ragLibraryId, libraryId));

	const rows = await getDatabase()
		.select({
			job: jobs,
			version: documentVersions,
			document: documents,
			library: libraries,
		})
		.from(jobs)
		.innerJoin(
			documentVersions,
			eq(documentVersions.id, jobs.documentVersionId),
		)
		.innerJoin(documents, eq(documents.id, documentVersions.documentId))
		.innerJoin(libraries, eq(libraries.id, documents.libraryId))
		.where(and(...conditions))
		.orderBy(desc(jobs.updatedAt))
		.limit(limit);
	return Response.json(rows.map(toApiJob));
}
