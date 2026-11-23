import { and, eq, isNull, notInArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@/db/schema";
import {
	documentActiveVersions,
	documents,
	documentVersions,
	libraries,
} from "@/db/schema";

/** Instance-level existence only; never returns document identities or content. */
export async function hasActiveDocuments(
	db: Pick<NodePgDatabase<typeof schema>, "select">,
): Promise<boolean> {
	const rows = await db
		.select({ id: documents.id })
		.from(documents)
		.innerJoin(libraries, eq(libraries.id, documents.libraryId))
		.innerJoin(
			documentActiveVersions,
			eq(documentActiveVersions.documentId, documents.id),
		)
		.innerJoin(
			documentVersions,
			and(
				eq(documentVersions.id, documentActiveVersions.versionId),
				eq(documentVersions.documentId, documents.id),
				eq(documentVersions.status, "active"),
			),
		)
		.where(
			and(
				isNull(documents.deletedAt),
				notInArray(documents.status, ["deleting", "deleted"]),
				notInArray(libraries.status, ["deleting", "deleted"]),
			),
		)
		.limit(1);
	return rows.length > 0;
}
