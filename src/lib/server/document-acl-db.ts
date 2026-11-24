import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, ne } from "drizzle-orm";
import { ingestAclFingerprint } from "@/core/ingest";
import { getDatabase } from "@/db";
import {
	documentAcl,
	documentActiveVersions,
	documents,
	documentVersions,
	jobs,
	libraries,
	users,
	workspaceMembers,
} from "@/db/schema";
import {
	EMPTY_RESTRICTED_ACL_PRINCIPAL,
	toDocumentAclResponse,
} from "@/lib/server/document-acl.mjs";

type AclTransaction = Parameters<
	Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]
>[0];

type AclDocument = {
	id: string;
	status: string;
	ragDocumentId: string;
};

async function updateAclProjection(
	tx: AclTransaction,
	input: {
		document: AclDocument;
		activeVersionId: string | undefined;
		organizationId: string;
		workspaceId: string;
		ragLibraryId: string;
		aclFingerprint: string;
		jobId: string;
		now: Date;
	},
): Promise<string | null> {
	const { document, aclFingerprint, now } = input;
	await tx
		.update(documents)
		.set({ aclFingerprint, updatedAt: now })
		.where(eq(documents.id, document.id));
	if (
		document.status === "deleting" ||
		document.status === "deleted" ||
		!input.activeVersionId
	) {
		return null;
	}

	// The DBOS dispatcher consumes this durable intent after the transaction commits.
	await tx.insert(jobs).values({
		id: input.jobId,
		organizationId: input.organizationId,
		workspaceId: input.workspaceId,
		documentVersionId: input.activeVersionId,
		type: "document.acl.project",
		executionEngine: "dbos",
		workflowId: input.jobId,
		status: "queued",
		stage: "accepted",
		idempotencyKey: `document.acl.project:${document.id}:${input.jobId}`,
		payload: {
			document_id: document.id,
			rag_document_id: document.ragDocumentId,
			library_id: input.ragLibraryId,
			acl_fingerprint: aclFingerprint,
		},
		createdAt: now,
		updatedAt: now,
	});
	return input.jobId;
}

export async function revokeWorkspaceDocumentGrants(
	tx: AclTransaction,
	input: {
		organizationId: string;
		workspaceId: string;
		principalId: string;
		actorId: string;
		now: Date;
	},
) {
	const grant = and(
		eq(documentAcl.subjectId, input.principalId),
		inArray(documentAcl.subjectType, ["principal", "user"]),
	);
	const grantedDocuments = tx
		.select({ id: documentAcl.documentId })
		.from(documentAcl)
		.where(grant);
	const affected = await tx
		.select({
			id: documents.id,
			status: documents.status,
			ragDocumentId: documents.ragDocumentId,
			libraryId: documents.libraryId,
		})
		.from(documents)
		.where(
			and(
				eq(documents.organizationId, input.organizationId),
				eq(documents.workspaceId, input.workspaceId),
				inArray(documents.id, grantedDocuments),
			),
		)
		.orderBy(documents.id)
		.for("update");

	let projectionJobs = 0;
	for (const document of affected) {
		const removed = await tx
			.delete(documentAcl)
			.where(and(eq(documentAcl.documentId, document.id), grant))
			.returning({ permission: documentAcl.permission });
		if (!removed.some((row) => row.permission === "read")) continue;

		const remaining = await tx
			.select({
				subjectType: documentAcl.subjectType,
				subjectId: documentAcl.subjectId,
			})
			.from(documentAcl)
			.where(
				and(
					eq(documentAcl.documentId, document.id),
					eq(documentAcl.permission, "read"),
				),
			);
		if (remaining.length === 0) {
			await tx.insert(documentAcl).values({
				documentId: document.id,
				subjectType: "principal",
				subjectId: EMPTY_RESTRICTED_ACL_PRINCIPAL,
				permission: "read",
				createdBy: input.actorId,
				createdAt: input.now,
			});
			remaining.push({
				subjectType: "principal",
				subjectId: EMPTY_RESTRICTED_ACL_PRINCIPAL,
			});
		}

		const [library] = await tx
			.select({
				ragLibraryId: libraries.ragLibraryId,
				activeVersionId: documentActiveVersions.versionId,
			})
			.from(libraries)
			.leftJoin(
				documentActiveVersions,
				eq(documentActiveVersions.documentId, document.id),
			)
			.where(eq(libraries.id, document.libraryId));
		if (!library) throw new Error("document library does not exist");
		const projection = await updateAclProjection(tx, {
			...input,
			document,
			ragLibraryId: library.ragLibraryId,
			activeVersionId: library.activeVersionId ?? undefined,
			aclFingerprint: ingestAclFingerprint({
				scope: "restricted",
				principalIds: remaining
					.filter((row) => ["principal", "user"].includes(row.subjectType))
					.map((row) => row.subjectId),
				groupIds: remaining
					.filter((row) => row.subjectType === "group")
					.map((row) => row.subjectId),
			}),
			jobId: randomUUID(),
		});
		if (projection) projectionJobs += 1;
	}
	return { affectedDocuments: affected.length, projectionJobs };
}

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
	organizationId: string;
	actorId: string;
	principalIds: string[];
	groupIds: string[];
	workspaceId: string;
	ragLibraryId: string;
	projectionJobId: string;
	projectionEnabled: boolean;
}) {
	const db = getDatabase();
	const now = new Date();
	const aclFingerprint = ingestAclFingerprint({
		scope:
			input.principalIds.length > 0 || input.groupIds.length > 0
				? "restricted"
				: "workspace",
		principalIds: input.principalIds,
		groupIds: input.groupIds,
	});

	const replacement = await db.transaction(async (tx) => {
		if (input.principalIds.length > 0) {
			const members = await tx
				.select({ userId: workspaceMembers.userId })
				.from(workspaceMembers)
				.where(
					and(
						eq(workspaceMembers.workspaceId, input.workspaceId),
						inArray(workspaceMembers.userId, input.principalIds),
					),
				)
				.orderBy(workspaceMembers.userId)
				.for("share");
			const allowed = new Set(members.map((row) => row.userId));
			if (input.principalIds.some((id) => !allowed.has(id))) {
				return { invalidPrincipals: true as const };
			}
		}
		const [lockedDocument] = await tx
			.select({
				id: documents.id,
				status: documents.status,
				ragDocumentId: documents.ragDocumentId,
			})
			.from(documents)
			.where(
				and(
					eq(documents.id, input.documentId),
					eq(documents.organizationId, input.organizationId),
					eq(documents.workspaceId, input.workspaceId),
				),
			)
			.for("update");
		if (!lockedDocument) return null;

		const [active] = await tx
			.select({ versionId: documentActiveVersions.versionId })
			.from(documentActiveVersions)
			.where(eq(documentActiveVersions.documentId, input.documentId))
			.limit(1);
		if (active?.versionId && !input.projectionEnabled) {
			return { projectionUnavailable: true as const };
		}

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

		const projectionJobId = await updateAclProjection(tx, {
			...input,
			document: lockedDocument,
			activeVersionId: active?.versionId,
			aclFingerprint,
			jobId: input.projectionJobId,
			now,
		});
		return {
			documentStatus: lockedDocument.status,
			projectionJobId,
		};
	});
	if (!replacement) {
		return {
			ok: false as const,
			status: 404,
			detail: "document not found",
		};
	}
	if ("invalidPrincipals" in replacement) {
		return {
			ok: false as const,
			status: 400,
			detail: "principal_ids must be workspace members",
		};
	}
	if ("projectionUnavailable" in replacement) {
		return {
			ok: false as const,
			status: 503,
			detail: "durable ACL projection is not available",
		};
	}

	const acl = await loadDocumentAclForApi(input.documentId, input.workspaceId);
	return { ok: true as const, acl, ...replacement };
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
