import "server-only";

import { createHash } from "node:crypto";
import { and, asc, eq, isNull, notInArray } from "drizzle-orm";

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
				aclFingerprint: documents.aclFingerprint,
			})
			.from(libraries)
			.leftJoin(
				documents,
				and(
					eq(documents.libraryId, libraries.id),
					isNull(documents.deletedAt),
					notInArray(documents.status, ["deleting", "deleted"]),
					eq(documents.aclFingerprint, documents.projectedAclFingerprint),
				),
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
					notInArray(libraries.status, ["deleting", "deleted"]),
				),
			)
			.orderBy(asc(documents.id));
		if (!rows.length) return null;
		const generationIds = [
			...new Set(
				rows
					.map((row) => row.generationId)
					.filter((value): value is string => typeof value === "string"),
			),
		];
		const aclEntries = [
			...new Set(
				rows
					.filter(
						(row): row is typeof row & { generationId: string } =>
							typeof row.generationId === "string",
					)
					.map((row) => `${row.generationId}:${row.aclFingerprint ?? ""}`),
			),
		].sort();
		const aclRevision = createHash("sha256")
			.update(aclEntries.join("\n"))
			.digest("hex");
		return ActiveGenerationSnapshotSchema.parse({
			libraryId: rows[0]?.libraryId,
			generationIds,
			aclRevision,
			resolvedAt: new Date(),
		});
	}
}
