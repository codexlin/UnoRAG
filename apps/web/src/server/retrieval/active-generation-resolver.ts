import "server-only";

import { and, asc, eq, isNull } from "drizzle-orm";

import { getDatabase } from "@/db";
import {
	documentActiveVersions,
	documents,
	documentVersions,
	libraries,
} from "@/db/schema";

import {
	type ActiveGenerationResolver,
	ActiveGenerationSnapshotSchema,
} from "../../core/retrieval/active-generation";

export class DrizzleActiveGenerationResolver
	implements ActiveGenerationResolver
{
	async resolve(input: {
		organizationId: string;
		workspaceId: string;
		libraryId: string;
	}) {
		const db = getDatabase();
		const rows = await db
			.select({
				libraryId: libraries.ragLibraryId,
				generationId: documentVersions.generationId,
			})
			.from(libraries)
			.leftJoin(
				documents,
				and(eq(documents.libraryId, libraries.id), isNull(documents.deletedAt)),
			)
			.leftJoin(
				documentActiveVersions,
				eq(documentActiveVersions.documentId, documents.id),
			)
			.leftJoin(
				documentVersions,
				and(
					eq(documentVersions.id, documentActiveVersions.versionId),
					eq(documentVersions.documentId, documents.id),
					eq(documentVersions.status, "active"),
				),
			)
			.where(
				and(
					eq(libraries.organizationId, input.organizationId),
					eq(libraries.workspaceId, input.workspaceId),
					eq(libraries.ragLibraryId, input.libraryId),
				),
			)
			.orderBy(asc(documents.id));
		if (!rows.length) return null;
		return ActiveGenerationSnapshotSchema.parse({
			libraryId: rows[0]?.libraryId,
			generationIds: [
				...new Set(
					rows
						.map((row) => row.generationId)
						.filter((value): value is string => typeof value === "string"),
				),
			],
			resolvedAt: new Date(),
		});
	}
}
