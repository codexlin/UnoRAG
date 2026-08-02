import { createHash } from "node:crypto";
import type { DocumentIR } from "../core/document-ir";
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
import { type ParsePdfInput, parseDocxDocument } from "../core/parsing";
import type { EmbeddingProvider } from "../core/retrieval/embedding/provider";
import type { DocumentIngestJob } from "./contracts";
import { WorkerTaskError } from "./errors";
import type {
	DocumentIngestExternalPort,
	DocumentIngestStageResult,
} from "./ports";

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

export interface PdfParserPort {
	parse(input: ParsePdfInput): Promise<DocumentIR>;
}

export class DocumentIngestStager implements DocumentIngestExternalPort {
	constructor(
		private readonly source: DocumentIngestSourcePort,
		private readonly scopes: DocumentIngestScopePort,
		private readonly embeddings: EmbeddingProvider,
		private readonly qdrant: DocumentIngestVectorStore,
		private readonly pdfParser?: PdfParserPort,
	) {}

	async stageDocument(
		input: DocumentIngestJob,
	): Promise<DocumentIngestStageResult> {
		const format = supportedFormat(input);
		const [content, snapshot] = await Promise.all([
			this.source.load(input.payload.storage_key),
			this.scopes.load(input),
		]);
		await this.assertContinuing(input);
		assertDocumentContentHash(content, input.payload.content_hash);
		const document = await this.parseDocument(input, snapshot, content, format);
		await this.assertContinuing(input);
		const profileName = CHUNK_PROFILES.has(
			input.payload.document_profile as ChunkProfileName,
		)
			? (input.payload.document_profile as ChunkProfileName)
			: "balanced";
		const chunks = await chunkDocument(document, { profileName });
		if (chunks.length === 0) {
			throw new WorkerTaskError(
				"Document parser produced no indexable chunks",
				"document_ingest_empty",
				"permanent",
			);
		}
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
			parserBackend:
				String(document.parser_report.parser).trim() ||
				String(document.parser_report.backend).trim() ||
				format,
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

	private async parseDocument(
		input: DocumentIngestJob,
		snapshot: DocumentIngestScopeSnapshot,
		content: Uint8Array,
		format: SupportedFormat,
	): Promise<DocumentIR> {
		const source = `storage://${input.payload.storage_key}`;
		if (format === "txt" || format === "md" || format === "markdown") {
			return parseTextDocument({
				documentId: snapshot.documentId,
				libraryId: snapshot.libraryId,
				filename: input.payload.filename,
				contentHash: input.payload.content_hash,
				content,
				source,
				sourceFormat: format,
			});
		}
		if (format === "docx") {
			return parseDocxDocument({
				documentId: snapshot.documentId,
				libraryId: snapshot.libraryId,
				filename: input.payload.filename,
				title: snapshot.title,
				contentHash: input.payload.content_hash,
				content,
				source,
			});
		}
		if (!this.pdfParser) {
			throw new WorkerTaskError(
				"PDF ParserProvider runtime is not configured",
				"parser_provider_unavailable",
				"permanent",
			);
		}
		return this.pdfParser.parse({
			input: {
				documentId: snapshot.documentId,
				filename: input.payload.filename,
				mimeType: input.payload.content_type,
				contentHash: input.payload.content_hash,
				sourceUri: source,
			},
			libraryId: snapshot.libraryId,
			title: snapshot.title,
			idempotencyKey: input.idempotencyKey,
			requestId: input.jobId,
			policy: {
				deploymentPolicy:
					input.payload.parse_preference === "local_only"
						? "strict-private"
						: "private-preferred",
				externalParserAllowed: input.payload.parse_preference !== "local_only",
				parsePreference: parsePreference(input.payload.parse_preference),
				scanHandling: scanHandling(input.payload.scan_handling),
			},
			assertContinuing: () => this.assertContinuing(input),
		});
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

type SupportedFormat = "txt" | "md" | "markdown" | "pdf" | "docx";

function supportedFormat(input: DocumentIngestJob): SupportedFormat {
	const contentType = input.payload.content_type
		.split(";", 1)[0]
		?.trim()
		.toLowerCase();
	const filename = input.payload.filename.toLowerCase();
	const format: SupportedFormat | null = filename.endsWith(".markdown")
		? "markdown"
		: filename.endsWith(".md")
			? "md"
			: filename.endsWith(".txt")
				? "txt"
				: filename.endsWith(".pdf")
					? "pdf"
					: filename.endsWith(".docx")
						? "docx"
						: null;
	const validContentType =
		(format === "txt" && contentType === "text/plain") ||
		((format === "md" || format === "markdown") &&
			["text/markdown", "text/x-markdown", "text/plain"].includes(
				contentType,
			)) ||
		(format === "pdf" && contentType === "application/pdf") ||
		(format === "docx" &&
			contentType ===
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document");
	const validQueue =
		(format === "pdf" &&
			(input.payload.queue_class === "auto" ||
				input.payload.queue_class === "mineru")) ||
		(format !== "pdf" && input.payload.queue_class === "local");
	if (!format || !validContentType || !validQueue) {
		throw new WorkerTaskError(
			"DBOS ingest does not support this format, content type, or queue class",
			"dbos_ingest_format_not_enabled",
			"permanent",
		);
	}
	return format;
}

function parsePreference(value: string): "auto" | "quality" | "local_only" {
	return value === "quality" || value === "local_only" ? value : "auto";
}

function scanHandling(value: string): "auto" | "force_ocr" | "disabled" {
	return value === "force_ocr" || value === "disabled" ? value : "auto";
}

export function assertDocumentContentHash(
	content: Uint8Array,
	expected: string,
): void {
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
