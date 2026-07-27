import "server-only";

import { sql } from "drizzle-orm";

/**
 * Correlated subquery counting active versions whose policy snapshot
 * differs from the current library row.
 */
export function staleActiveVersionsSql() {
	return sql`(
		SELECT count(*)::int
		FROM app.documents AS d
		INNER JOIN app.document_active_versions AS dav
			ON dav.document_id = d.id
		INNER JOIN app.document_versions AS dv
			ON dv.id = dav.version_id
		WHERE d.library_id = "app"."libraries"."id"
			AND d.deleted_at IS NULL
			AND (
				coalesce(dv.document_profile, 'auto')
					IS DISTINCT FROM "app"."libraries"."document_profile"
				OR coalesce(dv.scan_handling, 'auto')
					IS DISTINCT FROM "app"."libraries"."scan_handling"
				OR coalesce(dv.ingest_policy_version, 0)
					IS DISTINCT FROM "app"."libraries"."ingest_policy_version"
			)
	)`.mapWith(Number);
}
