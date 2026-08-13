import { constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import path from "node:path";

import type { QueryResult, QueryResultRow } from "pg";

import type { DocumentObjectStorage } from "../core/object-storage/contracts";
import { ObjectStorageNotFoundError } from "../core/object-storage/contracts";
import type { DocumentIngestJob } from "./contracts";
import type {
	DocumentIngestScopePort,
	DocumentIngestScopeSnapshot,
	DocumentIngestSourcePort,
} from "./document-ingest-staging";
import { WorkerTaskError } from "./errors";

export interface IngestSqlPool {
	query(text: string, values?: unknown[]): Promise<QueryResult<QueryResultRow>>;
}

interface ScopeRow extends QueryResultRow {
	title: string;
	rag_document_id: string;
	rag_library_id: string;
	subject_type: string | null;
	subject_id: string | null;
}

export class LocalDocumentIngestSource implements DocumentIngestSourcePort {
	private readonly root: string;

	constructor(
		root: string,
		private readonly maxBytes = 50 * 1024 * 1024,
	) {
		if (!root.trim()) throw new Error("document storage root is required");
		if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
			throw new Error("document source maxBytes must be positive");
		}
		this.root = path.resolve(root);
	}

	async load(storageKey: string): Promise<Uint8Array> {
		const target = await resolveStorageTarget(this.root, storageKey);
		let handle: FileHandle | undefined;
		try {
			handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
			const metadata = await handle.stat();
			if (!metadata.isFile()) {
				throw new WorkerTaskError(
					"Document storage object is not a regular file",
					"document_storage_object_invalid",
					"permanent",
				);
			}
			if (metadata.size <= 0 || metadata.size > this.maxBytes) {
				throw new WorkerTaskError(
					"Document storage object size is outside the allowed range",
					"document_storage_size_invalid",
					"permanent",
				);
			}
			return await handle.readFile();
		} catch (error) {
			if (error instanceof WorkerTaskError) throw error;
			const code =
				error instanceof Error &&
				"code" in error &&
				typeof error.code === "string"
					? error.code
					: "";
			throw new WorkerTaskError(
				code === "ENOENT"
					? "Document storage object does not exist"
					: code === "ELOOP"
						? "Document storage object cannot be a symbolic link"
						: error instanceof Error
							? error.message
							: "Document storage read failed",
				code === "ENOENT"
					? "document_storage_object_missing"
					: code === "ELOOP"
						? "document_storage_key_invalid"
						: "document_storage_read_failed",
				code === "ENOENT" || code === "ELOOP" ? "permanent" : "transient",
			);
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}
}

export class ObjectStorageDocumentIngestSource
	implements DocumentIngestSourcePort
{
	constructor(
		private readonly storage: Pick<DocumentObjectStorage, "load">,
		private readonly maxBytes = 50 * 1024 * 1024,
	) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
			throw new Error("document source maxBytes must be positive");
		}
	}

	async load(storageKey: string): Promise<Uint8Array> {
		try {
			return await this.storage.load(storageKey, this.maxBytes);
		} catch (error) {
			if (error instanceof WorkerTaskError) throw error;
			const missing = error instanceof ObjectStorageNotFoundError;
			const invalidSize =
				error instanceof Error && /size is outside/.test(error.message);
			throw new WorkerTaskError(
				missing
					? "Document storage object does not exist"
					: invalidSize
						? "Document storage object size is outside the allowed range"
						: error instanceof Error
							? error.message
							: "Document storage read failed",
				missing
					? "document_storage_object_missing"
					: invalidSize
						? "document_storage_size_invalid"
						: "document_storage_read_failed",
				missing || invalidSize ? "permanent" : "transient",
			);
		}
	}
}

export class PostgresDocumentIngestScope implements DocumentIngestScopePort {
	constructor(private readonly pool: IngestSqlPool) {}

	async load(input: DocumentIngestJob): Promise<DocumentIngestScopeSnapshot> {
		const result = (await this.pool.query(
			`
			SELECT document.name AS title,
			       document.rag_document_id,
			       library.rag_library_id,
			       acl.subject_type,
			       acl.subject_id::text
			FROM app.jobs AS job
			JOIN app.document_versions AS version
			  ON version.id = job.document_version_id
			JOIN app.documents AS document
			  ON document.id = version.document_id
			JOIN app.libraries AS library
			  ON library.id = document.library_id
			LEFT JOIN app.document_acl AS acl
			  ON acl.document_id = document.id
			 AND acl.permission = 'read'
			WHERE job.id = $1
			  AND job.type = 'document.ingest'
			  AND job.execution_engine = 'dbos'
			  AND job.organization_id = $2
			  AND job.workspace_id = $3
			  AND job.document_version_id = $4
			  AND document.id = $5
			  AND document.organization_id = $2
			  AND document.workspace_id = $3
			  AND document.deleted_at IS NULL
			  AND document.status NOT IN ('deleting', 'deleted')
			  AND library.organization_id = $2
			  AND library.workspace_id = $3
			  AND library.rag_library_id = $6
			  AND library.status NOT IN ('deleting', 'deleted')
			  AND version.generation_id = $7
			  AND version.storage_key = $8
			ORDER BY acl.subject_type NULLS FIRST, acl.subject_id NULLS FIRST
			`,
			[
				input.jobId,
				input.organizationId,
				input.workspaceId,
				input.payload.document_version_id,
				input.payload.document_id,
				input.payload.library_id,
				input.payload.generation_id,
				input.payload.storage_key,
			],
		)) as QueryResult<ScopeRow>;
		if (result.rows.length === 0) {
			throw new WorkerTaskError(
				"Document ingest scope no longer exists or does not match the job",
				"document_ingest_scope_invalid",
				"permanent",
			);
		}
		const first = result.rows[0];
		if (!first) throw new Error("document ingest scope query returned no row");
		const principalIds: string[] = [];
		const groupIds: string[] = [];
		for (const row of result.rows) {
			if (
				row.title !== first.title ||
				row.rag_document_id !== first.rag_document_id ||
				row.rag_library_id !== first.rag_library_id
			) {
				throw new WorkerTaskError(
					"Document ingest scope query returned inconsistent rows",
					"document_ingest_scope_inconsistent",
					"permanent",
				);
			}
			if (!row.subject_type && !row.subject_id) continue;
			if (!row.subject_id) {
				throw new WorkerTaskError(
					"Document ACL row is incomplete",
					"document_acl_invalid",
					"permanent",
				);
			}
			if (row.subject_type === "principal" || row.subject_type === "user") {
				pushUnique(principalIds, row.subject_id);
			} else if (row.subject_type === "group") {
				pushUnique(groupIds, row.subject_id);
			} else {
				throw new WorkerTaskError(
					"Document ACL contains an unsupported subject type",
					"document_acl_invalid",
					"permanent",
				);
			}
		}
		const restricted = principalIds.length > 0 || groupIds.length > 0;
		return {
			title: first.title,
			documentId: first.rag_document_id,
			libraryId: first.rag_library_id,
			acl: {
				scope: restricted ? "restricted" : "workspace",
				principalIds,
				groupIds,
			},
		};
	}

	async assertContinuing(input: DocumentIngestJob): Promise<void> {
		const result = await this.pool.query(
			`
			SELECT 1
			FROM app.jobs
			WHERE id = $1
			  AND organization_id = $2
			  AND workspace_id = $3
			  AND document_version_id = $4
			  AND type = 'document.ingest'
			  AND execution_engine = 'dbos'
			  AND workflow_id = id::text
			  AND status = 'running'
			  AND cancel_requested_at IS NULL
			`,
			[
				input.jobId,
				input.organizationId,
				input.workspaceId,
				input.payload.document_version_id,
			],
		);
		if (result.rowCount !== 1) {
			throw new WorkerTaskError(
				"Document ingest was cancelled or no longer owns the job",
				"job_cancelled",
				"cancelled",
			);
		}
	}
}

async function resolveStorageTarget(
	root: string,
	storageKey: string,
): Promise<string> {
	const normalized = storageKey.replaceAll("\\", "/").replace(/^\/+/, "");
	const parts = normalized.split("/");
	if (
		!normalized ||
		parts.some((part) => !part || part === "." || part === "..")
	) {
		throw new WorkerTaskError(
			"Invalid document storage key",
			"document_storage_key_invalid",
			"permanent",
		);
	}
	const lexical = path.resolve(root, normalized);
	if (lexical === root || !lexical.startsWith(`${root}${path.sep}`)) {
		throw new WorkerTaskError(
			"Document storage key escapes its configured root",
			"document_storage_key_invalid",
			"permanent",
		);
	}
	try {
		const [resolvedRoot, resolvedParent] = await Promise.all([
			realpath(root),
			realpath(path.dirname(lexical)),
		]);
		if (
			resolvedParent !== resolvedRoot &&
			!resolvedParent.startsWith(`${resolvedRoot}${path.sep}`)
		) {
			throw new WorkerTaskError(
				"Document storage key escapes its configured root",
				"document_storage_key_invalid",
				"permanent",
			);
		}
		return path.join(resolvedParent, path.basename(lexical));
	} catch (error) {
		if (error instanceof WorkerTaskError) throw error;
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ELOOP"
		) {
			throw new WorkerTaskError(
				"Document storage path contains a symbolic link loop",
				"document_storage_key_invalid",
				"permanent",
			);
		}
		throw new WorkerTaskError(
			error instanceof Error
				? error.message
				: "Document storage path validation failed",
			"document_storage_path_validation_failed",
			"transient",
		);
	}
}

function pushUnique(target: string[], value: string): void {
	if (!target.includes(value)) target.push(value);
}
