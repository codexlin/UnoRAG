import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { PoolClient } from "pg";

type LibraryScope = {
	libraryId: string;
	organizationId: string;
	workspaceId: string;
};

// Callers must hold the library row lock in the same transaction. This keeps
// the aggregate snapshot ordered with upload, activation and deletion writers.
export function libraryCountsUpdate(scope: LibraryScope) {
	return sql`
		UPDATE app.libraries AS library
		SET doc_count = counts.document_count,
			ready_count = counts.ready_count,
			status = CASE
				WHEN library.status = 'deleting' THEN 'deleting'
				WHEN counts.document_count = 0 THEN 'empty'
				WHEN counts.processing_count > 0 THEN 'indexing'
				WHEN counts.ready_count = counts.document_count THEN 'ready'
				WHEN counts.ready_count > 0 THEN 'degraded'
				WHEN counts.failed_count > 0 THEN 'failed'
				ELSE 'empty'
			END,
			updated_at = now()
		FROM (
			SELECT
				count(*) FILTER (WHERE status NOT IN ('deleting', 'deleted'))::integer
					AS document_count,
				count(*) FILTER (WHERE status IN ('ready', 'degraded'))::integer
					AS ready_count,
				count(*) FILTER (WHERE status = 'processing')::integer AS processing_count,
				count(*) FILTER (WHERE status = 'failed')::integer AS failed_count
			FROM app.documents
			WHERE library_id = ${scope.libraryId}
				AND organization_id = ${scope.organizationId}
				AND workspace_id = ${scope.workspaceId}
		) AS counts
		WHERE library.id = ${scope.libraryId}
			AND library.organization_id = ${scope.organizationId}
			AND library.workspace_id = ${scope.workspaceId}
			AND library.status <> 'deleted'
	`;
}

export async function refreshLockedLibraryCounts(
	client: Pick<PoolClient, "query">,
	scope: LibraryScope,
): Promise<void> {
	const query = new PgDialect().sqlToQuery(libraryCountsUpdate(scope));
	await client.query(query.sql, query.params);
}
