import "server-only";

import { and, eq, inArray, ne } from "drizzle-orm";

import { getDatabase } from "@/db";
import {
	documentAcl,
	documentActiveVersions,
	documents,
	documentVersions,
	users,
	workspaceMembers,
} from "@/db/schema";
import { toDocumentAclResponse } from "@/lib/server/document-acl.mjs";

export async function loadDocumentAclForApi(
	documentId: string,
	workspaceId: string,
) {
	const db = getDatabase();
	const rows = await db
		.select({
			subjectType: documentAcl.subjectType,
			subjectId: documentAcl.subjectId,
			permission: documentAcl.permission,
		})
		.from(documentAcl)
		.where(
			and(
				eq(documentAcl.documentId, documentId),
				eq(documentAcl.permission, "read"),
			),
		);

	const memberRows = await db
		.select({
			userId: users.id,
			email: users.email,
			displayName: users.displayName,
			role: workspaceMembers.role,
		})
		.from(workspaceMembers)
		.innerJoin(users, eq(users.id, workspaceMembers.userId))
		.where(eq(workspaceMembers.workspaceId, workspaceId));

	const memberById = new Map(
		memberRows.map((row) => [
			row.userId,
			{
				email: row.email,
				displayName: row.displayName,
				role: row.role,
			},
		]),
	);

	return toDocumentAclResponse(rows, memberById);
}

export async function replaceDocumentAcl(input: {
	documentId: string;
	actorId: string;
	principalIds: string[];
	groupIds: string[];
	workspaceId: string;
}) {
	const db = getDatabase();
	const now = new Date();

	if (input.principalIds.length > 0) {
		const members = await db
			.select({ userId: workspaceMembers.userId })
			.from(workspaceMembers)
			.where(
				and(
					eq(workspaceMembers.workspaceId, input.workspaceId),
					inArray(workspaceMembers.userId, input.principalIds),
				),
			);
		const allowed = new Set(members.map((row) => row.userId));
		const missing = input.principalIds.filter((id) => !allowed.has(id));
		if (missing.length > 0) {
			return {
				ok: false as const,
				status: 400,
				detail: "principal_ids must be workspace members",
			};
		}
	}

	await db.transaction(async (tx) => {
		await tx
			.delete(documentAcl)
			.where(eq(documentAcl.documentId, input.documentId));

		const values = [
			...input.principalIds.map((subjectId) => ({
				documentId: input.documentId,
				subjectType: "principal" as const,
				subjectId,
				permission: "read" as const,
				createdBy: input.actorId,
				createdAt: now,
			})),
			...input.groupIds.map((subjectId) => ({
				documentId: input.documentId,
				subjectType: "group" as const,
				subjectId,
				permission: "read" as const,
				createdBy: input.actorId,
				createdAt: now,
			})),
		];
		if (values.length > 0) {
			await tx.insert(documentAcl).values(values);
		}

		await tx
			.update(documents)
			.set({ updatedAt: now })
			.where(eq(documents.id, input.documentId));
	});

	const acl = await loadDocumentAclForApi(input.documentId, input.workspaceId);
	return { ok: true as const, acl };
}

export async function findLibraryDocumentForAcl(input: {
	tenantId: string;
	workspaceId: string;
	libraryUuid: string;
	ragDocumentId: string;
}) {
	const db = getDatabase();
	const [document] = await db
		.select()
		.from(documents)
		.where(
			and(
				eq(documents.organizationId, input.tenantId),
				eq(documents.workspaceId, input.workspaceId),
				eq(documents.libraryId, input.libraryUuid),
				eq(documents.ragDocumentId, input.ragDocumentId),
				ne(documents.status, "deleted"),
			),
		)
		.limit(1);
	if (!document) return null;

	const versionId =
		document.desiredVersionId ??
		(
			await db
				.select({ versionId: documentActiveVersions.versionId })
				.from(documentActiveVersions)
				.where(eq(documentActiveVersions.documentId, document.id))
				.limit(1)
		)[0]?.versionId;

	let hasStorageKey = false;
	if (versionId) {
		const [version] = await db
			.select({ storageKey: documentVersions.storageKey })
			.from(documentVersions)
			.where(eq(documentVersions.id, versionId))
			.limit(1);
		hasStorageKey = Boolean(version?.storageKey);
	}

	return { document, hasStorageKey };
}
