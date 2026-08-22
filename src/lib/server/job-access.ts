import "server-only";

import { and, eq } from "drizzle-orm";

import { getDatabase } from "@/db";
import { documents, documentVersions, jobs, libraries } from "@/db/schema";
import { formatParseStatusView } from "@/lib/parse-status-view.mjs";
import type { AuthIdentity } from "./auth/provider";
import { documentMetadataVisibilitySql } from "./document-visibility";

export async function findAuthorizedJob(identity: AuthIdentity, jobId: string) {
	const db = getDatabase();
	const [row] = await db
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
		.where(
			and(
				eq(jobs.id, jobId),
				eq(jobs.organizationId, identity.tenantId),
				eq(jobs.workspaceId, identity.workspaceId),
				eq(documents.organizationId, identity.tenantId),
				eq(documents.workspaceId, identity.workspaceId),
				documentMetadataVisibilitySql(identity, documents.id),
			),
		)
		.limit(1);
	return row ?? null;
}

export function toApiJob(row: {
	job: typeof jobs.$inferSelect;
	version: typeof documentVersions.$inferSelect;
	document: typeof documents.$inferSelect;
	library: typeof libraries.$inferSelect;
}) {
	const parser_report = row.version.parserReport;
	return {
		id: row.job.id,
		type: row.job.type,
		status: row.job.status,
		stage: row.job.stage,
		progress: row.job.progress,
		progress_current: row.job.progressCurrent,
		progress_total: row.job.progressTotal,
		attempt: row.job.attempt,
		max_attempts: row.job.maxAttempts,
		error_code: row.job.errorCode,
		error: row.job.error,
		parser_report,
		parse_status: formatParseStatusView({
			parserReport: parser_report as Record<string, unknown> | null,
			jobStatus: row.job.status,
			jobStage: row.job.stage,
			jobPayload: (row.job.payload as Record<string, unknown> | null) ?? null,
			documentStatus: row.document.status,
			parsePreference: row.version.parsePreference,
		}),
		document_id: row.document.ragDocumentId,
		document_version_id: row.version.id,
		generation_id: row.version.generationId,
		library_id: row.library.ragLibraryId,
		created_at: row.job.createdAt.toISOString(),
		started_at: row.job.startedAt?.toISOString() ?? null,
		finished_at: row.job.finishedAt?.toISOString() ?? null,
		updated_at: row.job.updatedAt.toISOString(),
	};
}
