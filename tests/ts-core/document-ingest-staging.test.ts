import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	DocumentIRSchema,
	ParserReportSchema,
} from "../../src/core/document-ir";
import type {
	IndexWritePayload,
	IngestPointScope,
} from "../../src/core/ingest";
import type { EmbeddingProvider } from "../../src/core/retrieval/embedding/provider";
import type { DocumentIngestJob } from "../../src/worker/contracts";
import {
	type DocumentIngestScopePort,
	DocumentIngestStager,
} from "../../src/worker/document-ingest-staging";
import { WorkerTaskError } from "../../src/worker/errors";

const content = new TextEncoder().encode(
	"# Leave policy\n\nRequests are answered within three working days.",
);
const contentHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;

test("text stager runs source, parser, chunks, embeddings, and scoped Qdrant write", async () => {
	const observed: {
		records?: IndexWritePayload[];
		vectors?: number[][];
		scope?: IngestPointScope;
	} = {};
	const progress: Array<{ stage: string; percent: number }> = [];
	const stager = new DocumentIngestStager(
		{
			async load(key) {
				assert.equal(key, "documents/handbook.txt");
				return content;
			},
		},
		scopePort(),
		embeddingProvider(),
		{
			async stage(input) {
				Object.assign(observed, input);
				return input.records.length;
			},
			async setVisibility() {
				return 2;
			},
		},
	);

	const result = await stager.stageDocument(job(), async (update) => {
		progress.push(update);
	});

	assert.deepEqual(result, {
		pointCount: 3,
		chunkCount: 1,
		sectionCount: 1,
		tableCount: 0,
		parserBackend: "native-text",
		parserReport: {
			source_format: "txt",
			parser: "native-text",
			backend: "typescript",
			parser_version: "1",
			mode: "native",
			latency_ms: null,
			text_pages: [],
			ocr_pages: [],
			vlm_pages: [],
			failed_pages: [],
			needs_ocr_pages: [],
			vlm_pending_pages: [],
			warnings: [],
			partial: false,
			notes: "",
			metrics: {
				document_context: {
					version: 1,
					title: "Leave policy",
					filename: "handbook.txt",
					identifiers: [],
					identifiers_complete: true,
					outline_complete: true,
					outline: [
						{
							node_id: "text-heading-0",
							text: "Leave policy",
							level: 1,
							page: null,
						},
					],
				},
				node_count: 2,
				heading_count: 1,
				chunking: {
					policy_version: "v1",
					profile: "balanced",
					chunk_count: 1,
					strategies: { heading: 1 },
					fallback_count: 0,
				},
			},
		},
	});
	assert.equal(observed.records?.length, 3);
	assert.equal(observed.vectors?.length, 3);
	assert.deepEqual(observed.scope, {
		organizationId: job().organizationId,
		workspaceId: job().workspaceId,
		libraryId: "rag-library",
		documentId: "rag-document",
		documentVersionId: job().payload.document_version_id,
		generationId: job().payload.generation_id,
		title: "Employee handbook",
		acl: {
			scope: "restricted",
			principalIds: ["10000000-0000-4000-8000-000000000008"],
			groupIds: [],
		},
	});
	assert.deepEqual(progress, [
		{ stage: "parsing", percent: 15 },
		{ stage: "chunking", percent: 45 },
		{ stage: "embedding", percent: 60 },
		{ stage: "indexing", percent: 80 },
	]);
});

test("document stager rejects unsupported formats and source hash mismatches", async () => {
	const stager = new DocumentIngestStager(
		{
			async load() {
				return content;
			},
		},
		scopePort(),
		embeddingProvider(),
		{
			async stage() {
				throw new Error("must not stage");
			},
			async setVisibility() {
				return 2;
			},
		},
	);

	await assert.rejects(
		() =>
			stager.stageDocument({
				...job(),
				payload: {
					...job().payload,
					filename: "contract.html",
					content_type: "text/html",
					queue_class: "local",
				},
			}),
		(error: unknown) =>
			error instanceof WorkerTaskError &&
			error.code === "dbos_ingest_format_not_enabled",
	);
	await assert.rejects(
		() =>
			stager.stageDocument({
				...job(),
				payload: { ...job().payload, content_hash: `sha256:${"0".repeat(64)}` },
			}),
		(error: unknown) =>
			error instanceof WorkerTaskError &&
			error.code === "document_content_hash_mismatch",
	);
});

test("visibility can target a previous generation without changing document scope", async () => {
	let observed: IngestPointScope | undefined;
	const stager = new DocumentIngestStager(
		{
			async load() {
				return content;
			},
		},
		scopePort(),
		embeddingProvider(),
		{
			async stage() {
				return 0;
			},
			async setVisibility(scope) {
				observed = scope;
				return 2;
			},
		},
	);

	await stager.setGenerationVisibility(
		job(),
		"10000000-0000-4000-8000-000000000099",
		"inactive",
	);

	assert.equal(observed?.generationId, "10000000-0000-4000-8000-000000000099");
	assert.equal(observed?.documentId, "rag-document");
});

test("PDF staging uses the parser result before shared chunk/embed/Qdrant steps", async () => {
	const pdf = new Uint8Array([37, 80, 68, 70]);
	const hash = `sha256:${createHash("sha256").update(pdf).digest("hex")}`;
	let parserInput: unknown;
	let records: IndexWritePayload[] = [];
	const stager = new DocumentIngestStager(
		{
			async load() {
				return pdf;
			},
		},
		scopePort(),
		embeddingProvider(),
		{
			async stage(input) {
				records = input.records;
				return input.records.length;
			},
			async setVisibility() {
				return 1;
			},
		},
		{
			async parse(input) {
				parserInput = input;
				const report = ParserReportSchema.parse({
					source_format: "pdf",
					parser: "mineru",
					backend: "mineru-http",
					parser_version: "test",
					mode: "structured",
				});
				return DocumentIRSchema.parse({
					id: "rag-document",
					library_id: "rag-library",
					source: input.input.sourceUri,
					source_format: "pdf",
					title: "Employee handbook",
					filename: input.input.filename,
					content_hash: input.input.contentHash,
					nodes: [
						{
							id: "pdf-node-1",
							type: "paragraph",
							page_start: 1,
							page_end: 1,
							text: "Payment is due within thirty days.",
						},
					],
					parser_report: report,
				});
			},
		},
	);
	const pdfJob = {
		...job(),
		payload: {
			...job().payload,
			filename: "contract.pdf",
			content_type: "application/pdf",
			content_hash: hash,
			storage_key: "documents/contract.pdf",
			queue_class: "auto" as const,
			parse_preference: "quality",
		},
	};

	const result = await stager.stageDocument(pdfJob);

	assert.equal(result.parserBackend, "mineru");
	assert.equal(result.chunkCount, 1);
	assert.equal(records.length, 3);
	assert.equal(
		(parserInput as { idempotencyKey: string }).idempotencyKey,
		pdfJob.idempotencyKey,
	);
});

test("text staging observes cancellation between compute and Qdrant batches", async () => {
	let checks = 0;
	let staged = false;
	const stager = new DocumentIngestStager(
		{
			async load() {
				return content;
			},
		},
		{
			...scopePort(),
			async assertContinuing() {
				checks += 1;
				if (checks === 4) {
					throw new WorkerTaskError("cancelled", "job_cancelled", "cancelled");
				}
			},
		},
		embeddingProvider(),
		{
			async stage() {
				staged = true;
				return 2;
			},
			async setVisibility() {
				return 2;
			},
		},
	);

	await assert.rejects(
		() => stager.stageDocument(job()),
		(error: unknown) =>
			error instanceof WorkerTaskError && error.code === "job_cancelled",
	);
	assert.equal(staged, false);
	assert.equal(checks, 4);
});

test("worker environment enables bounded deterministic context only in embedding/search fields", async (t) => {
	const keys = [
		"CONTEXTUAL_RETRIEVAL_ENABLED",
		"CONTEXTUAL_RETRIEVAL_MAX_CHUNKS",
		"CONTEXTUAL_RETRIEVAL_TIMEOUT_MS",
	];
	const previous = keys.map((key) => process.env[key]);
	t.after(() =>
		keys.forEach((key, index) => {
			if (previous[index] === undefined) delete process.env[key];
			else process.env[key] = previous[index];
		}),
	);
	process.env.CONTEXTUAL_RETRIEVAL_ENABLED = "true";
	process.env.CONTEXTUAL_RETRIEVAL_MAX_CHUNKS = "1";
	process.env.CONTEXTUAL_RETRIEVAL_TIMEOUT_MS = "1000";
	const text = "Payment is due thirty days after acceptance. ".repeat(20);
	const source = new TextEncoder().encode(text);
	let records: IndexWritePayload[] = [];
	const embedded: string[] = [];
	const stager = new DocumentIngestStager(
		{
			async load() {
				return source;
			},
		},
		scopePort(),
		{
			...embeddingProvider(),
			async embedTexts(texts) {
				embedded.push(...texts);
				return texts.map(() => [1, 0]);
			},
		},
		{
			async stage(input) {
				records = input.records;
				return records.length;
			},
			async setVisibility() {
				return 0;
			},
		},
	);
	await stager.stageDocument({
		...job(),
		payload: {
			...job().payload,
			content_hash: createHash("sha256").update(source).digest("hex"),
		},
	});
	assert.equal(records.filter((record) => record.contextual_prefix).length, 1);
	assert.deepEqual(
		embedded,
		records.map((record) => record.embed_text),
	);
	const contextual = records.find((record) => record.contextual_prefix);
	assert.ok(contextual);
	assert.match(contextual.contextual_prefix ?? "", /handbook/);
	assert.ok(text.includes(contextual.body ?? ""));
	assert.equal(contextual.text, contextual.body);
	assert.ok(
		contextual.embed_text.startsWith(contextual.contextual_prefix ?? ""),
	);
	assert.ok(
		records
			.filter((record) => record.record_type !== "chunk")
			.every((record) => record.contextual_prefix === undefined),
	);
	assert.ok(
		records.every(
			(record) =>
				record.generation_id === job().payload.generation_id &&
				record.tenant_id === job().organizationId &&
				record.workspace_id === job().workspaceId,
		),
	);
});

test("worker continues staging original evidence when an injected contextualizer fails", async () => {
	const source = new TextEncoder().encode(
		"Original narrative evidence for the document. ".repeat(10),
	);
	let records: IndexWritePayload[] = [];
	let attempts = 0;
	const stager = new DocumentIngestStager(
		{
			async load() {
				return source;
			},
		},
		scopePort(),
		embeddingProvider(),
		{
			async stage(input) {
				records = input.records;
				return records.length;
			},
			async setVisibility() {
				return 0;
			},
		},
		undefined,
		{
			enabled: true,
			contextualizer: {
				async contextualize() {
					attempts += 1;
					throw new Error("provider unavailable");
				},
			},
		},
	);
	const result = await stager.stageDocument({
		...job(),
		payload: {
			...job().payload,
			content_hash: createHash("sha256").update(source).digest("hex"),
		},
	});
	assert.equal(attempts, 1);
	assert.ok(result.pointCount > 0);
	assert.ok(records.every((record) => record.contextual_prefix === undefined));
	assert.equal(
		records.find((record) => record.record_type === "chunk")?.body,
		new TextDecoder().decode(source).trim(),
	);
});

function embeddingProvider(): EmbeddingProvider {
	return {
		async embedQuery() {
			return [1, 0];
		},
		async embedTexts(texts) {
			return texts.map((_, index) => [index, 1]);
		},
	};
}

function scopePort(): DocumentIngestScopePort {
	return {
		async load() {
			return {
				title: "Employee handbook",
				documentId: "rag-document",
				libraryId: "rag-library",
				acl: {
					scope: "restricted",
					principalIds: ["10000000-0000-4000-8000-000000000008"],
					groupIds: [],
				},
			};
		},
	};
}

function job(): DocumentIngestJob {
	return {
		jobId: "10000000-0000-4000-8000-000000000001",
		organizationId: "10000000-0000-4000-8000-000000000002",
		workspaceId: "10000000-0000-4000-8000-000000000003",
		documentVersionId: "10000000-0000-4000-8000-000000000005",
		idempotencyKey: "document.ingest:test",
		type: "document.ingest",
		payload: {
			document_id: "10000000-0000-4000-8000-000000000004",
			document_version_id: "10000000-0000-4000-8000-000000000005",
			generation_id: "10000000-0000-4000-8000-000000000006",
			library_id: "rag-library",
			storage_key: "documents/handbook.txt",
			content_hash: contentHash,
			filename: "handbook.txt",
			content_type: "text/plain",
			document_profile: "balanced",
			scan_handling: "auto",
			parse_preference: "auto",
			ingest_policy_version: 1,
			queue_class: "local",
		},
	};
}
