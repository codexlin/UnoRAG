import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { getDatabase } from "@/db";
import {
	auditLogs,
	documentActiveVersions,
	documents,
	documentVersions,
	jobs,
	libraries,
} from "@/db/schema";
import type { AuthIdentity } from "@/lib/server/auth/provider";
import { documentIngestExecutionIdentity } from "@/lib/server/document-lifecycle-flag.mjs";
import {
	buildDocumentIngestPayload,
	documentIngestIdempotencyKey,
	nextDocumentVersionNumber,
} from "@/lib/server/document-version-core.mjs";

type UploadedSource = {
	kind: "upload";
	storageKey: string;
	contentHash: string;
	sizeBytes: number | null;
	filename: string;
	contentType: string;
	displayName: string;
};

type ReindexSource = {
	kind: "reindex";
};

export type CreateDocumentVersionInput = {
	identity: AuthIdentity;
	libraryId: string;
	documentId: string;
	requestId: string;
	source: UploadedSource | ReindexSource;
	ids?: {
		versionId: string;
		generationId: string;
		jobId: string;
	};
};

export type CreateDocumentVersionResult = {
	libraryId: string;
	ragLibraryId: string;
	documentId: string;
	ragDocumentId: string;
	displayName: string;
	filename: string;
	versionId: string;
	generationId: string;
	jobId: string;
	version: number;
};

export type DocumentVersionCommandErrorCode =
	| "library_unavailable"
	| "document_unavailable"
	| "document_processing"
	| "source_missing";

export class DocumentVersionCommandError extends Error {
	constructor(
		readonly code: DocumentVersionCommandErrorCode,
		message: string,
	) {
		super(message);
		this.name = "DocumentVersionCommandError";
	}
}

/**
 * Create a replacement/reindex version and its ingest job atomically.
 * Lifecycle writers always lock library -> document -> source version.
 */
export async function createDocumentVersion(
	input: CreateDocumentVersionInput,
): Promise<CreateDocumentVersionResult> {
	const db = getDatabase();
	const versionId = input.ids?.versionId ?? randomUUID();
	const generationId = input.ids?.generationId ?? randomUUID();
	const jobId = input.ids?.jobId ?? randomUUID();
	const now = new Date();

	return db.transaction(async (tx) => {
		const [library] = await tx
			.select()
			.from(libraries)
			.where(
				and(
					eq(libraries.id, input.libraryId),
					eq(libraries.organizationId, input.identity.tenantId),
					eq(libraries.workspaceId, input.identity.workspaceId),
				),
			)
			.for("update")
			.limit(1);
		if (
			!library ||
			library.status === "deleting" ||
			library.status === "deleted"
		) {
			throw new DocumentVersionCommandError(
				"library_unavailable",
				"library is not accepting document versions",
			);
		}

		const [document] = await tx
			.select()
			.from(documents)
			.where(
				and(
					eq(documents.id, input.documentId),
					eq(documents.organizationId, input.identity.tenantId),
					eq(documents.workspaceId, input.identity.workspaceId),
					eq(documents.libraryId, library.id),
				),
			)
			.for("update")
			.limit(1);
		if (
			!document ||
			document.status === "deleted" ||
			document.status === "deleting"
		) {
			throw new DocumentVersionCommandError(
				"document_unavailable",
				"document is unavailable",
			);
		}
		if (input.source.kind === "reindex" && document.status === "processing") {
			throw new DocumentVersionCommandError(
				"document_processing",
				"document is already processing",
			);
		}

		let source: Omit<UploadedSource, "kind" | "displayName">;
		let sourceVersionId: string | null = null;
		if (input.source.kind === "upload") {
			source = input.source;
		} else {
			const [active] = await tx
				.select({ versionId: documentActiveVersions.versionId })
				.from(documentActiveVersions)
				.where(eq(documentActiveVersions.documentId, document.id))
				.limit(1);
			sourceVersionId = document.desiredVersionId ?? active?.versionId ?? null;
			if (!sourceVersionId) {
				throw new DocumentVersionCommandError(
					"source_missing",
					"document has no version to reindex",
				);
			}
			const [sourceVersion] = await tx
				.select()
				.from(documentVersions)
				.where(
					and(
						eq(documentVersions.id, sourceVersionId),
						eq(documentVersions.documentId, document.id),
					),
				)
				.for("update")
				.limit(1);
			if (!sourceVersion?.storageKey || !sourceVersion.contentHash) {
				throw new DocumentVersionCommandError(
					"source_missing",
					"source file was not retained; upload it again",
				);
			}
			source = {
				storageKey: sourceVersion.storageKey,
				contentHash: sourceVersion.contentHash,
				sizeBytes: sourceVersion.sizeBytes,
				filename: document.filename,
				contentType: document.contentType,
			};
		}

		const [maxRow] = await tx
			.select({
				maxVersion: sql<number>`coalesce(max(${documentVersions.version}), 0)`,
			})
			.from(documentVersions)
			.where(eq(documentVersions.documentId, document.id));
		const version = nextDocumentVersionNumber(maxRow?.maxVersion);

		const queuedVersions = await tx
			.select({ id: documentVersions.id })
			.from(documentVersions)
			.innerJoin(jobs, eq(jobs.documentVersionId, documentVersions.id))
			.where(
				and(
					eq(documentVersions.documentId, document.id),
					inArray(jobs.status, ["queued", "retry"]),
				),
			);
		const queuedVersionIds = queuedVersions.map((row) => row.id);
		if (queuedVersionIds.length > 0) {
			await tx
				.update(jobs)
				.set({
					status: "cancelled",
					stage: "done",
					cancelRequestedAt: now,
					finishedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						inArray(jobs.documentVersionId, queuedVersionIds),
						inArray(jobs.status, ["queued", "retry"]),
					),
				);
			await tx
				.update(documentVersions)
				.set({ status: "superseded", supersededAt: now, updatedAt: now })
				.where(
					and(
						inArray(documentVersions.id, queuedVersionIds),
						inArray(documentVersions.status, [
							"pending",
							"processing",
							"indexed",
							"activating",
						]),
					),
				);
		}

		const runningJobs = await tx
			.select({ id: jobs.id })
			.from(jobs)
			.innerJoin(
				documentVersions,
				eq(documentVersions.id, jobs.documentVersionId),
			)
			.where(
				and(
					eq(documentVersions.documentId, document.id),
					eq(jobs.status, "running"),
				),
			);
		if (runningJobs.length > 0) {
			await tx
				.update(jobs)
				.set({
					status: "cancelling",
					cancelRequestedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						inArray(
							jobs.id,
							runningJobs.map((row) => row.id),
						),
						eq(jobs.status, "running"),
					),
				);
		}

		await tx.insert(documentVersions).values({
			id: versionId,
			documentId: document.id,
			version,
			generationId,
			contentHash: source.contentHash,
			storageKey: source.storageKey,
			sizeBytes: source.sizeBytes,
			status: "pending",
			pipelineVersion: "document-lifecycle-v2",
			documentProfile: library.documentProfile ?? "auto",
			scanHandling: library.scanHandling ?? "auto",
			parsePreference: library.parsePreference ?? "auto",
			ingestPolicyVersion: library.ingestPolicyVersion ?? 1,
			createdAt: now,
			updatedAt: now,
		});
		const ingestPayload = buildDocumentIngestPayload({
			documentId: document.id,
			versionId,
			generationId,
			ragLibraryId: library.ragLibraryId,
			storageKey: source.storageKey,
			contentHash: source.contentHash,
			filename: source.filename,
			contentType: source.contentType,
			documentProfile: library.documentProfile ?? "auto",
			scanHandling: library.scanHandling ?? "auto",
			parsePreference: library.parsePreference ?? "auto",
			ingestPolicyVersion: library.ingestPolicyVersion ?? 1,
		});
		await tx.insert(jobs).values({
			id: jobId,
			organizationId: input.identity.tenantId,
			workspaceId: input.identity.workspaceId,
			documentVersionId: versionId,
			type: "document.ingest",
			...documentIngestExecutionIdentity(jobId, ingestPayload),
			status: "queued",
			stage: "accepted",
			idempotencyKey: documentIngestIdempotencyKey(versionId, generationId),
			payload: ingestPayload,
			createdAt: now,
			updatedAt: now,
		});

		const displayName =
			input.source.kind === "upload"
				? input.source.displayName.slice(0, 512)
				: document.name;
		await tx
			.update(documents)
			.set({
				...(input.source.kind === "upload"
					? {
							name: displayName,
							filename: source.filename,
							contentType: source.contentType,
						}
					: {}),
				status: "processing",
				desiredVersionId: versionId,
				latestJobId: jobId,
				updatedAt: now,
			})
			.where(eq(documents.id, document.id));
		await tx
			.update(libraries)
			.set({ status: "indexing", updatedAt: now })
			.where(eq(libraries.id, library.id));

		await tx.insert(auditLogs).values({
			organizationId: input.identity.tenantId,
			workspaceId: input.identity.workspaceId,
			actorId: input.identity.principalId,
			action:
				input.source.kind === "upload"
					? "document.version_created"
					: "document.reindex_requested",
			resourceType: "document",
			resourceId: document.id,
			requestId: input.requestId,
			details: {
				library_id: library.ragLibraryId,
				document_version_id: versionId,
				generation_id: generationId,
				job_id: jobId,
				version,
				content_hash: source.contentHash,
				...(input.source.kind === "upload"
					? {
							size_bytes: source.sizeBytes,
							previous_desired_version_id: document.desiredVersionId,
						}
					: { source_version_id: sourceVersionId, reused_storage_key: true }),
			},
		});

		return {
			libraryId: library.id,
			ragLibraryId: library.ragLibraryId,
			documentId: document.id,
			ragDocumentId: document.ragDocumentId,
			displayName,
			filename: source.filename,
			versionId,
			generationId,
			jobId,
			version,
		};
	});
}
