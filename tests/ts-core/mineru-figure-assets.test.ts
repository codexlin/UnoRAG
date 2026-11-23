import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import type { Pool } from "pg";

import type { ParseInput, ParseResult } from "../../src/core/contracts";
import { DocumentIRSchema } from "../../src/core/document-ir";
import { chunkDocument } from "../../src/core/ingest";
import { LocalObjectStorage } from "../../src/core/object-storage/local";
import { MinerU302Provider, PdfDocumentParser } from "../../src/core/parsing";
import type { EmbeddingProvider } from "../../src/core/retrieval/embedding/provider";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import type {
	DocumentDeleteJob,
	DocumentIngestJob,
	GenerationCleanupJob,
} from "../../src/worker/contracts";
import { PostgresDocumentDeleteTransactions } from "../../src/worker/document-delete-ports";
import {
	DocumentIngestStager,
	type FigureAssetStorePort,
} from "../../src/worker/document-ingest-staging";
import {
	PostgresFigureAssetStore,
	QdrantGenerationCleanupStep,
} from "../../src/worker/production-ports";

const SAMPLE_PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
	0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
	0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44,
	0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0x0f, 0x00, 0x01, 0x01, 0x01, 0x00, 0x18,
	0xdd, 0x8d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
	0x60, 0x82,
]);

const require = createRequire(import.meta.url);
const nodeModule = require("node:module") as {
	_resolveFilename: (request: string, ...args: unknown[]) => string;
};
const originalResolve = nodeModule._resolveFilename.bind(nodeModule);
nodeModule._resolveFilename = (request, ...args) =>
	request === "server-only"
		? require.resolve("next/package.json")
		: originalResolve(request, ...args);
const downloadHandlerModule = import(
	"../../src/server/http/document/download-handler"
).finally(() => {
	nodeModule._resolveFilename = originalResolve;
});

test("MinerU302Provider extracts figure crops from result ZIP and strips transient img_path", async () => {
	const zip = new JSZip();
	zip.file(
		"report/report_content_list.json",
		JSON.stringify([
			{ type: "text", text: "财务图表概览", page_idx: 0 },
			{
				type: "image",
				img_path: "images/chart_1.png",
				image_caption: [],
				page_idx: 1,
			},
			{
				type: "image",
				img_path: "../etc/passwd.png",
				image_caption: ["越权路径应被忽略"],
				page_idx: 2,
			},
		]),
	);
	zip.file("report/images/chart_1.png", SAMPLE_PNG);
	zip.file("etc/passwd.png", SAMPLE_PNG);
	const archive = await zip.generateAsync({ type: "uint8array" });

	const provider = new MinerU302Provider({
		baseUrl: "https://api.302.ai",
		headers: { authorization: "Bearer test-secret" },
		sourceLoader: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
		fetch: async (request, init) => {
			const url = String(request);
			if (url.endsWith("/302/upload-file")) {
				return Response.json({
					code: 200,
					data: "https://file.302.ai/input/report.pdf",
				});
			}
			if (url.endsWith("/302/v2/mineru/task") && init?.method === "POST") {
				return Response.json({
					data: { task_id: "task-fig-1", status: "STARTED" },
				});
			}
			if (url.includes("task_id=task-fig-1")) {
				return Response.json({
					data: {
						task_id: "task-fig-1",
						status: "SUCCESS",
						result_url: "https://file.302.ai/output/report.zip",
					},
				});
			}
			if (url === "https://file.302.ai/output/report.zip") {
				return new Response(Buffer.from(archive), { status: 200 });
			}
			throw new Error(`unexpected request ${url}`);
		},
	});

	const input: ParseInput = {
		documentId: "rag-doc-fig-1",
		filename: "report.pdf",
		mimeType: "application/pdf",
		contentHash: "fixture",
		sourceUri: "storage://report.pdf",
	};
	await provider.submit(input, {
		externalParserAllowed: true,
		idempotencyKey: "ingest:fig-1",
		requestId: "request-fig-1",
	});
	const result = await provider.fetchResult({
		documentId: input.documentId,
		providerTaskId: "task-fig-1",
	});

	assert.equal(result.figureAssets?.length, 1);
	assert.deepEqual(
		{
			figureId: result.figureAssets?.[0]?.figureId,
			mimeType: result.figureAssets?.[0]?.mimeType,
			pageStart: result.figureAssets?.[0]?.pageStart,
			pageEnd: result.figureAssets?.[0]?.pageEnd,
			bytes: Array.from(result.figureAssets?.[0]?.bytes ?? []),
		},
		{
			figureId: "rag-doc-fig-1:figure:1",
			mimeType: "image/png",
			pageStart: 2,
			pageEnd: 2,
			bytes: Array.from(SAMPLE_PNG),
		},
	);
	for (const node of result.document.nodes) {
		assert.equal(node.meta?.img_path, undefined);
	}
});

test("chunkDocument keeps captionless figures only when has_figure_asset is true", async () => {
	const document = DocumentIRSchema.parse({
		id: "rag-doc-chunk",
		filename: "charts.pdf",
		source_format: "pdf",
		nodes: [
			{
				id: "fig-no-asset",
				type: "figure",
				figure_id: "rag-doc-chunk:figure:0",
				text: "",
				page_start: 1,
				page_end: 1,
			},
			{
				id: "fig-with-asset",
				type: "figure",
				figure_id: "rag-doc-chunk:figure:1",
				text: "",
				page_start: 3,
				page_end: 3,
				path: "业绩图表",
				meta: { has_figure_asset: true },
			},
		],
		parser_report: {
			source_format: "pdf",
			parser: "mineru-302",
			backend: "mineru",
			parser_version: "302ai-v2",
			mode: "ocr",
		},
	});

	const chunks = await chunkDocument(document);
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0]?.figure_id, "rag-doc-chunk:figure:1");
	assert.equal(chunks[0]?.split_strategy, "figure");
	assert.equal(chunks[0]?.body, "图表（第3页）");
});

test("PdfDocumentParser.parseWithAssets and DocumentIngestStager persist figure crops and index captionless figures", async () => {
	const parsedDoc = DocumentIRSchema.parse({
		id: "rag-doc-stage",
		filename: "charts.pdf",
		source_format: "pdf",
		nodes: [
			{
				id: "fig-0",
				type: "figure",
				figure_id: "rag-doc-stage:figure:0",
				text: "",
				page_start: 2,
				page_end: 2,
				path: "收入趋势",
			},
		],
		parser_report: {
			source_format: "pdf",
			parser: "mineru-302",
			backend: "mineru",
			parser_version: "302ai-v2",
			mode: "ocr",
		},
	});
	const providerResult: ParseResult = {
		document: parsedDoc,
		report: parsedDoc.parser_report,
		figureAssets: [
			{
				figureId: "rag-doc-stage:figure:0",
				mimeType: "image/png",
				extension: "png",
				bytes: SAMPLE_PNG,
				pageStart: 2,
				pageEnd: 2,
			},
		],
	};

	const minerUProvider = {
		name: "mineru-302",
		version: "1.0",
		capabilities: {
			formats: ["pdf"] as const,
			ocr: true,
			tables: true,
			figures: true,
			boundingBoxes: true,
			asynchronous: true,
			externalDataProcessing: false,
		},
		analyze: async () => ({
			pageCount: 2,
			hasTextLayer: false,
			needsOcr: true,
			scannedPages: [1, 2],
			hasTables: false,
			hasFigures: true,
			complexityScore: 0.9,
			sampleText: "",
			qualityScore: 0.9,
			warnings: [],
		}),
		submit: async () => ({
			documentId: "rag-doc-stage",
			providerTaskId: "task-stage",
			status: "completed" as const,
			submittedAt: new Date().toISOString(),
		}),
		poll: async () => ({
			documentId: "rag-doc-stage",
			providerTaskId: "task-stage",
			status: "completed" as const,
		}),
		fetchResult: async () => providerResult,
		cancel: async () => undefined,
	};
	const parser = new PdfDocumentParser({
		liteParse: minerUProvider,
		minerU: minerUProvider,
		externalParserAllowed: true,
		pollIntervalMs: 1,
	});

	const direct = await parser.parseWithAssets({
		input: {
			documentId: "rag-doc-stage",
			filename: "charts.pdf",
			mimeType: "application/pdf",
			contentHash: "hash",
			sourceUri: "storage://charts.pdf",
		},
		libraryId: "rag-lib-1",
		title: "charts.pdf",
		idempotencyKey: "parse:fig",
		requestId: "req-fig",
		policy: {
			deploymentPolicy: "cloud-allowed",
			externalParserAllowed: true,
			parsePreference: "quality",
			scanHandling: "auto",
		},
	});
	assert.equal(direct.figureAssets.length, 1);

	const persistedRecords: Array<unknown> = [];
	const libraryUuid = "10000000-0000-4000-8000-000000000007";
	const indexedRecords: Array<Record<string, unknown>> = [];
	const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
	const contentHash = `sha256:${createHash("sha256").update(pdfBytes).digest("hex")}`;
	const embedding: EmbeddingProvider = {
		async embedTexts(texts) {
			return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
		},
		async embedQuery() {
			return [0.1, 0.2, 0.3, 0.4];
		},
	};
	const figureStore: FigureAssetStorePort = {
		async persist(saveInput) {
			assert.equal(saveInput.libraryUuid, libraryUuid);
			persistedRecords.push(...saveInput.assets);
			return new Set(saveInput.assets.map((asset) => asset.figureId));
		},
	};
	const stager = new DocumentIngestStager(
		{
			async load() {
				return pdfBytes;
			},
		},
		{
			async load() {
				return {
					title: "charts.pdf",
					documentId: "rag-doc-stage",
					libraryId: "rag-lib-1",
					libraryUuid,
					acl: {
						scope: "workspace",
						principalIds: [],
						groupIds: [],
					},
				};
			},
		},
		embedding,
		{
			async stage(input) {
				for (const rec of input.records) {
					indexedRecords.push(rec as unknown as Record<string, unknown>);
				}
				return input.records.length;
			},
			async setVisibility() {
				return 1;
			},
		},
		parser,
		undefined,
		figureStore,
	);

	const job: DocumentIngestJob = {
		jobId: "30000000-0000-4000-8000-000000000001",
		organizationId: "10000000-0000-4000-8000-000000000002",
		workspaceId: "10000000-0000-4000-8000-000000000003",
		documentVersionId: "10000000-0000-4000-8000-000000000004",
		idempotencyKey: "ingest:fig",
		type: "document.ingest",
		payload: {
			document_id: "10000000-0000-4000-8000-000000000006",
			document_version_id: "10000000-0000-4000-8000-000000000004",
			library_id: "rag-lib-1",
			storage_key: "documents/charts.pdf",
			generation_id: "10000000-0000-4000-8000-000000000005",
			content_hash: contentHash,
			filename: "charts.pdf",
			content_type: "application/pdf",
			document_profile: "balanced",
			scan_handling: "auto",
			parse_preference: "quality",
			ingest_policy_version: 1,
			queue_class: "mineru",
		},
	};

	const staged = await stager.stageDocument(job);
	assert.equal(staged.chunkCount, 1);
	assert.equal(persistedRecords.length, 1);
	assert.equal(
		indexedRecords.some(
			(rec) =>
				rec.record_type === "figure" &&
				rec.figure_id === "rag-doc-stage:figure:0",
		),
		true,
	);
});

test("figure persistence cleans up failed and redundant uploads without removing the saved object", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "unorag-fig-persist-"));
	try {
		const storage = new LocalObjectStorage(root);
		const attemptedKeys: string[] = [];
		const libraryUuid = randomUUID();
		const failure = new Error("figure row insert failed");
		const pool = {
			async query(sql: string, values: unknown[]) {
				assert.equal(values[2], libraryUuid);
				if (sql.includes("SELECT storage_key")) {
					return { rows: [{ storage_key: attemptedKeys[0] }] };
				}
				const storageKey = String(values[7]);
				assert.equal(await storage.exists(storageKey), true);
				attemptedKeys.push(storageKey);
				if (attemptedKeys.length === 2) throw failure;
				return { rowCount: attemptedKeys.length === 1 ? 1 : 0 };
			},
		} as Pick<Pool, "query">;
		const store = new PostgresFigureAssetStore(pool, storage);
		const input = {
			organizationId: randomUUID(),
			workspaceId: randomUUID(),
			libraryUuid,
			documentId: randomUUID(),
			documentVersionId: randomUUID(),
			generationId: randomUUID(),
			assets: [
				{
					figureId: "fig-1",
					extension: "png",
					mimeType: "image/png",
					bytes: Uint8Array.of(1, 2, 3),
					pageStart: 1,
					pageEnd: 1,
				},
			],
		} as const;
		assert.deepEqual(await store.persist(input), new Set(["fig-1"]));
		await assert.rejects(store.persist(input), failure);
		assert.deepEqual(await store.persist(input), new Set(["fig-1"]));
		await assert.rejects(
			store.persist({
				...input,
				assets: [{ ...input.assets[0], bytes: Uint8Array.of(1, 2, 4) }],
			}),
			{ code: "document_figure_asset_conflict" },
		);
		assert.equal(new Set(attemptedKeys).size, 4);
		assert.deepEqual(
			await Promise.all(attemptedKeys.map((key) => storage.exists(key))),
			[true, false, false, false],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("generation cleanup and document delete both include derived figure storage keys", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "unorag-fig-cleanup-"));
	try {
		const storage = new LocalObjectStorage(root);
		const derivedKey =
			"derived/figures/tenant-1/doc-1/gen-old/rag-doc-1_figure_0.png";
		await storage.putBytes(derivedKey, SAMPLE_PNG, {
			contentType: "image/png",
		});
		assert.equal(await storage.exists(derivedKey), true);

		const queries: Array<{ text: string; values?: unknown[] }> = [];
		const fakePool = {
			async query(text: string, values?: unknown[]) {
				queries.push({ text, values });
				if (text.includes("FROM app.document_figure_assets")) {
					return {
						command: "",
						rowCount: 1,
						oid: 0,
						fields: [],
						rows: [{ storage_key: derivedKey }],
					};
				}
				return { command: "", rowCount: 1, oid: 0, fields: [], rows: [] };
			},
		} as unknown as Pick<import("pg").Pool, "query">;

		const qdrantCalls: unknown[] = [];
		const cleanupStep = new QdrantGenerationCleanupStep(
			{
				async delete(_collection, input) {
					qdrantCalls.push(input);
					return { status: "completed" };
				},
			},
			"unorag_chunks",
			{ pool: fakePool, objectStorage: storage },
		);
		const cleanupJob: GenerationCleanupJob = {
			jobId: "30000000-0000-4000-8000-000000000010",
			organizationId: "10000000-0000-4000-8000-000000000002",
			workspaceId: "10000000-0000-4000-8000-000000000003",
			documentVersionId: "10000000-0000-4000-8000-000000000004",
			idempotencyKey: "cleanup:fig",
			type: "generation.cleanup",
			payload: {
				generation_id: "10000000-0000-4000-8000-000000000005",
				document_id: "10000000-0000-4000-8000-000000000006",
				library_id: "10000000-0000-4000-8000-000000000007",
				storage_keys: ["documents/shared-source.pdf"],
				reason: "superseded",
			},
		};

		await cleanupStep.deleteGeneration(cleanupJob);
		assert.equal(qdrantCalls.length, 1);
		assert.equal(await storage.exists(derivedKey), false);
		assert.equal(
			queries.some((q) =>
				q.text.includes("DELETE FROM app.document_figure_assets"),
			),
			true,
		);

		const deleteTx = new PostgresDocumentDeleteTransactions({
			async connect() {
				return {
					async query(text: string) {
						if (text.includes("FROM app.libraries")) {
							return {
								rows: [
									{
										id: "10000000-0000-4000-8000-000000000007",
										rag_library_id: "rag-lib-1",
										status: "deleting",
									},
								],
							};
						}
						if (text.includes("FROM app.documents")) {
							return {
								rows: [
									{
										id: "10000000-0000-4000-8000-000000000006",
										rag_document_id: "rag-doc-1",
										library_id: "10000000-0000-4000-8000-000000000007",
										status: "deleting",
									},
								],
							};
						}
						if (text.includes("FROM app.jobs AS job")) {
							return {
								rows: [
									{
										id: "30000000-0000-4000-8000-000000000020",
										status: "running",
										job_status: "running",
									},
								],
							};
						}
						if (text.includes("FROM app.document_versions")) {
							return {
								rows: [
									{
										generation_id: "gen-1",
										storage_key: "documents/source.pdf",
									},
								],
							};
						}
						if (text.includes("FROM app.document_figure_assets")) {
							return {
								rows: [{ storage_key: derivedKey }],
							};
						}
						return { rows: [] };
					},
					release() {},
				};
			},
		} as unknown as import("pg").Pool);

		const deleteJob: DocumentDeleteJob = {
			jobId: "30000000-0000-4000-8000-000000000020",
			organizationId: "10000000-0000-4000-8000-000000000002",
			workspaceId: "10000000-0000-4000-8000-000000000003",
			idempotencyKey: "delete:fig",
			type: "document.delete",
			payload: {
				document_id: "10000000-0000-4000-8000-000000000006",
				rag_document_id: "rag-doc-1",
				library_id: "10000000-0000-4000-8000-000000000007",
				rag_library_id: "rag-lib-1",
				storage_keys: [],
				generation_ids: [],
				library_delete: false,
			},
		};
		const targets = await deleteTx.loadTargets(deleteJob);
		assert.deepEqual(targets.storageKeys.sort(), [
			derivedKey,
			"documents/source.pdf",
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("handleNativeDocumentFigureRequest enforces ACL, query params, security headers, and streams figure bytes", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "unorag-fig-route-"));
	try {
		const storage = new LocalObjectStorage(root);
		const key = "derived/figures/t1/d1/g1/doc_figure_0.png";
		await storage.putBytes(key, SAMPLE_PNG, { contentType: "image/png" });
		const { handleNativeDocumentFigureRequest, isNativeDocumentFigurePath } =
			await downloadHandlerModule;

		assert.equal(
			isNativeDocumentFigurePath(["v1", "documents", "rag-doc-1", "figure"]),
			true,
		);
		const identity: AuthIdentity = {
			tenantId: "t1",
			workspaceId: "w1",
			principalId: "user-1",
			workspaceName: "Test",
			groupIds: ["group-a"],
			organizationRole: "member",
			role: "member",
			email: "u@example.test",
			displayName: "User 1",
			provider: "local",
			mustChangePassword: false,
		};

		const missingParam = await handleNativeDocumentFigureRequest({
			request: new Request(
				"https://example.test/v1/documents/rag-doc-1/figure",
			),
			path: ["v1", "documents", "rag-doc-1", "figure"],
			identity,
		});
		assert.equal(missingParam?.status, 400);

		const badMethod = await handleNativeDocumentFigureRequest({
			request: new Request(
				"https://example.test/v1/documents/rag-doc-1/figure?figure_id=rag-doc-1:figure:0",
				{ method: "POST" },
			),
			path: ["v1", "documents", "rag-doc-1", "figure"],
			identity,
		});
		assert.equal(badMethod?.status, 405);

		const badVersion = await handleNativeDocumentFigureRequest({
			request: new Request(
				"https://example.test/v1/documents/rag-doc-1/figure?figure_id=rag-doc-1:figure:0&version_id=not-uuid",
			),
			path: ["v1", "documents", "rag-doc-1", "figure"],
			identity,
		});
		assert.equal(badVersion?.status, 404);

		const denied = await handleNativeDocumentFigureRequest({
			request: new Request(
				"https://example.test/v1/documents/rag-doc-1/figure?figure_id=rag-doc-1:figure:0",
			),
			path: ["v1", "documents", "rag-doc-1", "figure"],
			identity,
			dependencies: {
				storage: storage as unknown as ReturnType<
					typeof import("../../src/lib/server/object-storage").documentObjectStorage
				>,
				loadAssetRows: async () => [
					{
						storageKey: key,
						mimeType: "image/png",
						subjectType: "user",
						subjectId: "other-user",
					},
				],
			},
		});
		assert.equal(denied?.status, 404);

		const allowed = await handleNativeDocumentFigureRequest({
			request: new Request(
				"https://example.test/v1/documents/rag-doc-1/figure?figure_id=rag-doc-1:figure:0",
			),
			path: ["v1", "documents", "rag-doc-1", "figure"],
			identity,
			dependencies: {
				storage: storage as unknown as ReturnType<
					typeof import("../../src/lib/server/object-storage").documentObjectStorage
				>,
				loadAssetRows: async () => [
					{
						storageKey: key,
						mimeType: "image/png",
						subjectType: "group",
						subjectId: "group-a",
					},
				],
			},
		});
		assert.equal(allowed?.status, 200);
		assert.equal(allowed?.headers.get("cache-control"), "private, no-store");
		assert.equal(allowed?.headers.get("x-content-type-options"), "nosniff");
		assert.equal(allowed?.headers.get("content-type"), "image/png");
		const streamed = new Uint8Array(await (allowed as Response).arrayBuffer());
		assert.deepEqual(Array.from(streamed), Array.from(SAMPLE_PNG));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
