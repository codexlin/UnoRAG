import { createHash } from "node:crypto";
import {
	buildIndexPayloads,
	type ChunkProfileName,
	chunkDocument,
	type IndexWritePayload,
	type IngestAclSnapshot,
	type IngestPointScope,
	ingestAclFingerprint,
	parseTextDocument,
} from "../core/ingest";
import type { EmbeddingProvider } from "../core/retrieval/embedding/provider";
import type { DocumentIngestJob } from "./contracts";
import { WorkerTaskError } from "./errors";
import type {
	DocumentIngestExternalPort,
	DocumentIngestStageResult,
} from "./ports";

const TEXT_CONTENT_TYPES = new Set([
	"text/plain",
	"text/markdown",
	"text/x-markdown",
]);
const CHUNK_PROFILES = new Set<ChunkProfileName>([
	"precise",
	"balanced",
	"narrative",
	"table_heavy",
]);
const CANCELLABLE_EMBEDDING_BATCH_SIZE = 16;

export interface DocumentIngestSourcePort {
	load(storageKey: string): Promise<Uint8Array>;
}

export interface DocumentIngestScopeSnapshot {
	title: string;
	documentId: string;
	libraryId: string;
	acl: IngestAclSnapshot;
}

export interface DocumentIngestScopePort {
	load(input: DocumentIngestJob): Promise<DocumentIngestScopeSnapshot>;
	assertContinuing?(input: DocumentIngestJob): Promise<void>;
}

export interface DocumentIngestVectorStore {
	stage(input: {
		records: IndexWritePayload[];
		vectors: number[][];
		scope: IngestPointScope;
		beforeBatch?: () => Promise<void>;
	}): Promise<number>;
	setVisibility(
		scope: IngestPointScope,
		visibility: "active" | "inactive",
	): Promise<number>;
}

export class TextDocumentIngestStager implements DocumentIngestExternalPort {
	constructor(
		private readonly source: DocumentIngestSourcePort,
		private readonly scopes: DocumentIngestScopePort,
		private readonly embeddings: EmbeddingProvider,
		private readonly qdrant: DocumentIngestVectorStore,
	) {}

	async stageTextDocument(
		input: DocumentIngestJob,
	): Promise<DocumentIngestStageResult> {
		assertTextCanary(input);
		const [content, snapshot] = await Promise.all([
			this.source.load(input.payload.storage_key),
			this.scopes.load(input),
		]);
		await this.assertContinuing(input);
		assertContentHash(content, input.payload.content_hash);
		const sourceFormat = input.payload.filename.toLowerCase().endsWith(".md")
			? "md"
			: input.payload.filename.toLowerCase().endsWith(".markdown")
				? "markdown"
				: "txt";
		const document = parseTextDocument({
			documentId: snapshot.documentId,
			libraryId: snapshot.libraryId,
			filename: input.payload.filename,
			contentHash: input.payload.content_hash,
			content,
			source: `storage://${input.payload.storage_key}`,
			sourceFormat,
		});
		const profileName = CHUNK_PROFILES.has(
			input.payload.document_profile as ChunkProfileName,
		)
			? (input.payload.document_profile as ChunkProfileName)
			: "balanced";
		const chunks = await chunkDocument(document, { profileName });
		await this.assertContinuing(input);
		const scope = pointScope(input, snapshot);
		const records = buildIndexPayloads(chunks, {
			documentId: snapshot.documentId,
			documentVersionId: input.payload.document_version_id,
			generationId: input.payload.generation_id,
			libraryId: snapshot.libraryId,
			organizationId: input.organizationId,
			workspaceId: input.workspaceId,
			filename: input.payload.filename,
			lifecycleVisibility: "staging",
		});
		const vectors: number[][] = [];
		for (
			let offset = 0;
			offset < records.length;
			offset += CANCELLABLE_EMBEDDING_BATCH_SIZE
		) {
			await this.assertContinuing(input);
			vectors.push(
				...(await this.embeddings.embedTexts(
					records
						.slice(offset, offset + CANCELLABLE_EMBEDDING_BATCH_SIZE)
						.map((record) => record.embed_text),
				)),
			);
		}
		await this.assertContinuing(input);
		const pointCount = await this.qdrant.stage({
			records,
			vectors,
			scope,
			beforeBatch: () => this.assertContinuing(input),
		});
		return {
			pointCount,
			chunkCount: records.filter((record) => record.record_type === "chunk")
				.length,
			sectionCount: records.filter((record) => record.record_type === "section")
				.length,
			tableCount: records.filter(
				(record) =>
					record.record_type === "table" ||
					record.record_type === "table_summary",
			).length,
			parserBackend: "native-text",
			parserReport: structuredClone(document.parser_report),
		};
	}

	async setGenerationVisibility(
		input: DocumentIngestJob,
		generationId: string,
		visibility: "active" | "inactive",
	): Promise<{ pointCount: number; aclFingerprint: string }> {
		const snapshot = await this.scopes.load(input);
		const scope = {
			...pointScope(input, snapshot),
			generationId,
		};
		const pointCount = await this.qdrant.setVisibility(scope, visibility);
		return {
			pointCount,
			aclFingerprint: ingestAclFingerprint(scope.acl),
		};
	}

	private async assertContinuing(input: DocumentIngestJob): Promise<void> {
		await this.scopes.assertContinuing?.(input);
	}
}

function pointScope(
	input: DocumentIngestJob,
	snapshot: DocumentIngestScopeSnapshot,
): IngestPointScope {
	return {
		organizationId: input.organizationId,
		workspaceId: input.workspaceId,
		libraryId: snapshot.libraryId,
		documentId: snapshot.documentId,
		documentVersionId: input.payload.document_version_id,
		generationId: input.payload.generation_id,
		title: snapshot.title,
		acl: snapshot.acl,
	};
}

function assertTextCanary(input: DocumentIngestJob): void {
	const contentType = input.payload.content_type
		.split(";", 1)[0]
		?.trim()
		.toLowerCase();
	const filename = input.payload.filename.toLowerCase();
	if (
		!contentType ||
		!TEXT_CONTENT_TYPES.has(contentType) ||
		!(
			filename.endsWith(".txt") ||
			filename.endsWith(".md") ||
			filename.endsWith(".markdown")
		) ||
		input.payload.queue_class !== "local"
	) {
		throw new WorkerTaskError(
			"DBOS ingest canary accepts local UTF-8 text documents only",
			"dbos_ingest_format_not_enabled",
			"permanent",
		);
	}
}

function assertContentHash(content: Uint8Array, expected: string): void {
	const actual = createHash("sha256").update(content).digest("hex");
	const normalized = expected
		.trim()
		.toLowerCase()
		.replace(/^sha256:/, "");
	if (!/^[a-f0-9]{64}$/.test(normalized) || actual !== normalized) {
		throw new WorkerTaskError(
			"Document source hash does not match the queued version",
			"document_content_hash_mismatch",
			"permanent",
		);
	}
}
