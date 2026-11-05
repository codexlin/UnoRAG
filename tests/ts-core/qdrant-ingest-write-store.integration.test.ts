import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { QdrantClient } from "@qdrant/js-client-rest";
import {
	type IndexWritePayload,
	type IngestPointScope,
	QdrantIngestWriteStore,
} from "../../src/core/ingest";
import type { EmbeddingProvider } from "../../src/core/retrieval/embedding/provider";
import {
	QdrantOperationError,
	QdrantRetrievalStore,
} from "../../src/core/retrieval/qdrant/store";
import type { DocumentIngestJob } from "../../src/worker/contracts";
import { LocalDocumentIngestSource } from "../../src/worker/document-ingest-production";
import { DocumentIngestStager } from "../../src/worker/document-ingest-staging";

const qdrantUrl = process.env.QDRANT_INGEST_E2E_URL?.trim();

test("real Qdrant read distinguishes a dropped connection from HTTP failure and recovers without retry", {
	skip: qdrantUrl ? false : "QDRANT_INGEST_E2E_URL is not configured",
}, async () => {
	assert.ok(qdrantUrl);
	const direct = new QdrantClient({
		url: qdrantUrl,
		checkCompatibility: false,
	});
	const collection = `unorag_transport_${randomUUID().replaceAll("-", "")}`;
	let dropped = false;
	let forwarded = 0;
	const proxy = createServer(async (request, response) => {
		if (!dropped && request.url?.endsWith("/points/query")) {
			dropped = true;
			request.socket.destroy();
			return;
		}
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const upstream = await fetch(new URL(request.url ?? "/", qdrantUrl), {
				method: request.method,
				headers: { "content-type": "application/json" },
				body: ["GET", "HEAD"].includes(request.method ?? "GET")
					? undefined
					: Buffer.concat(chunks),
			});
			forwarded++;
			response.writeHead(upstream.status, {
				"content-type": "application/json",
			});
			response.end(Buffer.from(await upstream.arrayBuffer()));
		} catch {
			response.writeHead(502).end();
		}
	});
	await direct.createCollection(collection, {
		vectors: { size: 2, distance: "Cosine" },
	});
	try {
		const scope = createScope();
		const writes = new QdrantIngestWriteStore(direct, collection);
		await writes.stage({
			records: [record(scope, 0)],
			vectors: [[1, 0]],
			scope,
		});
		await writes.setVisibility(scope, "active");
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const address = proxy.address();
		assert.ok(address && typeof address !== "string");
		const client = new QdrantClient({
			url: `http://127.0.0.1:${address.port}`,
			checkCompatibility: false,
			timeout: 5000,
		});
		const store = new QdrantRetrievalStore(
			client,
			collection,
			Promise.resolve(),
			{ timeoutMs: 5000 },
		);
		const input = {
			vector: [1, 0],
			limit: 6,
			scope: {
				tenantId: scope.organizationId,
				workspaceId: scope.workspaceId,
				libraryId: scope.libraryId,
				principalIds: scope.acl.principalIds,
				groupIds: [],
				activeGenerationIds: [scope.generationId],
			},
		};
		await assert.rejects(store.search(input), (error) => {
			assert.ok(error instanceof QdrantOperationError);
			assert.equal(error.diagnostics.category, "transport");
			assert.equal(error.diagnostics.statusCode, null);
			assert.equal(error.diagnostics.transportCode, "UND_ERR_SOCKET");
			assert.equal(error.diagnostics.attempts, 1);
			assert.equal(error.diagnostics.retryable, true);
			return true;
		});
		assert.equal(forwarded, 0);
		const result = await store.search(input);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.payload.generation_id, scope.generationId);
		assert.equal(forwarded, 1);
	} finally {
		proxy.closeAllConnections();
		if (proxy.listening)
			await new Promise<void>((resolve, reject) =>
				proxy.close((error) => (error ? reject(error) : resolve())),
			);
		await direct.deleteCollection(collection);
	}
});

test("real Qdrant preserves scoped staging and atomic replacement visibility", {
	skip: qdrantUrl ? false : "QDRANT_INGEST_E2E_URL is not configured",
}, async () => {
	assert.ok(qdrantUrl);
	const client = new QdrantClient({
		url: qdrantUrl,
		checkCompatibility: true,
	});
	const collection = `unorag_ingest_e2e_${randomUUID().replaceAll("-", "")}`;
	await client.createCollection(collection, {
		vectors: { size: 2, distance: "Cosine" },
	});

	try {
		const first = createScope();
		const second = {
			...first,
			documentVersionId: randomUUID(),
			generationId: randomUUID(),
		};
		const store = new QdrantIngestWriteStore(client, collection, {
			batchSize: 1,
		});

		await store.stage({
			records: [record(first, 0)],
			vectors: [[1, 0]],
			scope: first,
		});
		await store.setVisibility(first, "active");

		await store.stage({
			records: [record(second, 0), record(second, 1)],
			vectors: [
				[0, 1],
				[0.5, 0.5],
			],
			scope: second,
		});
		await store.setVisibility(first, "inactive");
		await store.setVisibility(second, "active");

		assert.equal(await scopedCount(client, collection, first, "inactive"), 1);
		assert.equal(await scopedCount(client, collection, second, "active"), 2);
		assert.equal(
			(
				await client.count(collection, {
					exact: true,
					filter: {
						must: [
							{
								key: "tenant_id",
								match: { value: randomUUID() },
							},
							{
								key: "workspace_id",
								match: { value: first.workspaceId },
							},
							{
								key: "lifecycle_visibility",
								match: { value: "active" },
							},
						],
					},
				})
			).count,
			0,
		);
	} finally {
		await client.deleteCollection(collection);
	}
});

test("real Qdrant retries never mix same-count parser manifests or rewrite active points", {
	skip: qdrantUrl ? false : "QDRANT_INGEST_E2E_URL is not configured",
}, async () => {
	assert.ok(qdrantUrl);
	const client = new QdrantClient({ url: qdrantUrl });
	const collection = `unorag_retry_${randomUUID().replaceAll("-", "")}`;
	await client.createCollection(collection, {
		vectors: { size: 2, distance: "Cosine" },
	});
	try {
		const scope = createScope();
		const records = [record(scope, 0), record(scope, 1)];
		const vectors = [
			[1, 0],
			[0, 1],
		];
		const store = new QdrantIngestWriteStore(client, collection, {
			batchSize: 1,
		});
		let checks = 0;
		await assert.rejects(
			store.stage({
				records,
				vectors,
				scope,
				beforeBatch: async () => {
					if (++checks === 3) throw new Error("interrupted");
				},
			}),
			/interrupted/,
		);
		for (const changed of [
			[records[0], record(scope, 2)],
			[
				records[0],
				{ ...records[1], body: "changed boundary", text: "changed boundary" },
			],
		]) {
			await assert.rejects(
				store.stage({ records: changed, vectors, scope }),
				/manifest mismatch/,
			);
		}
		assert.equal((await client.count(collection, { exact: true })).count, 1);
		assert.equal(await store.stage({ records, vectors, scope }), 2);
		assert.equal(await store.stage({ records, vectors, scope }), 2);
		await store.setVisibility(scope, "active");
		const before = await client.scroll(collection, {
			with_payload: true,
			with_vector: true,
		});
		await assert.rejects(
			store.stage({ records, vectors, scope }),
			/manifest mismatch/,
		);
		assert.deepEqual(
			await client.scroll(collection, {
				with_payload: true,
				with_vector: true,
			}),
			before,
		);
	} finally {
		await client.deleteCollection(collection);
	}
});

test("real local TXT parsing and chunking stages scoped points in Qdrant", {
	skip: qdrantUrl ? false : "QDRANT_INGEST_E2E_URL is not configured",
}, async () => {
	assert.ok(qdrantUrl);
	const client = new QdrantClient({
		url: qdrantUrl,
		checkCompatibility: true,
	});
	const collection = `unorag_txt_e2e_${randomUUID().replaceAll("-", "")}`;
	const storageRoot = await mkdtemp(path.join(tmpdir(), "unorag-txt-e2e-"));
	const storageKey = "documents/handbook.txt";
	const content = Buffer.from(
		"# Leave policy\n\nRequests are answered within three working days.\n",
		"utf8",
	);
	await mkdir(path.join(storageRoot, "documents"));
	await writeFile(path.join(storageRoot, storageKey), content);
	await client.createCollection(collection, {
		vectors: { size: 2, distance: "Cosine" },
	});

	try {
		const scope = createScope();
		const job = createJob(scope, storageKey, content);
		const stager = new DocumentIngestStager(
			new LocalDocumentIngestSource(storageRoot),
			{
				async load() {
					return {
						title: scope.title,
						documentId: scope.documentId,
						libraryId: scope.libraryId,
						acl: scope.acl,
					};
				},
			},
			deterministicEmbeddings(),
			new QdrantIngestWriteStore(client, collection),
		);

		const result = await stager.stageDocument(job);
		assert.equal(result.parserBackend, "native-text");
		assert.equal(result.chunkCount, 1);
		assert.equal(result.sectionCount, 1);
		assert.equal(result.pointCount, 2);

		await stager.setGenerationVisibility(job, scope.generationId, "active");
		assert.equal(await scopedCount(client, collection, scope, "active"), 2);
	} finally {
		await Promise.all([
			client.deleteCollection(collection),
			rm(storageRoot, { recursive: true, force: true }),
		]);
	}
});

test("real Qdrant query enforces workspace and principal ACL isolation", {
	skip: qdrantUrl ? false : "QDRANT_INGEST_E2E_URL is not configured",
}, async () => {
	assert.ok(qdrantUrl);
	const client = new QdrantClient({ url: qdrantUrl, checkCompatibility: true });
	const collection = `unorag_acl_e2e_${randomUUID().replaceAll("-", "")}`;
	await client.createCollection(collection, {
		vectors: { size: 2, distance: "Cosine" },
	});

	try {
		const scope = createScope();
		const writeStore = new QdrantIngestWriteStore(client, collection);
		await writeStore.stage({
			records: [record(scope, 0)],
			vectors: [[1, 0]],
			scope,
		});
		await writeStore.setVisibility(scope, "active");
		const retrieval = new QdrantRetrievalStore(client, collection);
		const retrievalScope = {
			tenantId: scope.organizationId,
			workspaceId: scope.workspaceId,
			libraryId: scope.libraryId,
			principalIds: scope.acl.principalIds,
			groupIds: [],
			activeGenerationIds: [scope.generationId],
		};

		assert.equal(
			(
				await retrieval.search({
					vector: [1, 0],
					scope: retrievalScope,
					limit: 5,
				})
			).length,
			1,
		);
		assert.equal(
			(
				await retrieval.search({
					vector: [1, 0],
					scope: { ...retrievalScope, principalIds: [randomUUID()] },
					limit: 5,
				})
			).length,
			0,
		);
		assert.equal(
			(
				await retrieval.search({
					vector: [1, 0],
					scope: { ...retrievalScope, workspaceId: randomUUID() },
					limit: 5,
				})
			).length,
			0,
		);
	} finally {
		await client.deleteCollection(collection);
	}
});

function createScope(): IngestPointScope {
	return {
		organizationId: randomUUID(),
		workspaceId: randomUUID(),
		libraryId: randomUUID(),
		documentId: randomUUID(),
		documentVersionId: randomUUID(),
		generationId: randomUUID(),
		title: "Real Qdrant ingest fixture",
		acl: {
			scope: "restricted",
			principalIds: [randomUUID()],
			groupIds: [],
		},
	};
}

function createJob(
	scope: IngestPointScope,
	storageKey: string,
	content: Uint8Array,
): DocumentIngestJob {
	return {
		jobId: randomUUID(),
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		documentVersionId: scope.documentVersionId,
		idempotencyKey: `document.ingest:e2e:${scope.generationId}`,
		type: "document.ingest",
		payload: {
			document_id: randomUUID(),
			document_version_id: scope.documentVersionId,
			generation_id: scope.generationId,
			library_id: scope.libraryId,
			storage_key: storageKey,
			content_hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
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

function deterministicEmbeddings(): EmbeddingProvider {
	return {
		async embedQuery() {
			return [1, 0];
		},
		async embedTexts(texts) {
			return texts.map((_, index) => [1, index + 1]);
		},
	};
}

function record(scope: IngestPointScope, index: number): IndexWritePayload {
	return {
		chunk_index: index,
		text: `chunk ${index}`,
		body: `chunk ${index}`,
		embed_text: `embedding chunk ${index}`,
		record_type: "chunk",
		record_id: `record-${index}`,
		document_version_id: scope.documentVersionId,
		tenant_id: scope.organizationId,
		workspace_id: scope.workspaceId,
		_point_id: randomUUID(),
		generation_id: scope.generationId,
		lifecycle_visibility: "staging",
		source_chunk_ids: [],
	};
}

async function scopedCount(
	client: QdrantClient,
	collection: string,
	scope: IngestPointScope,
	visibility: "active" | "inactive",
): Promise<number> {
	return (
		await client.count(collection, {
			exact: true,
			filter: {
				must: [
					{ key: "tenant_id", match: { value: scope.organizationId } },
					{ key: "workspace_id", match: { value: scope.workspaceId } },
					{ key: "library_id", match: { value: scope.libraryId } },
					{ key: "doc_id", match: { value: scope.documentId } },
					{ key: "generation_id", match: { value: scope.generationId } },
					{
						key: "lifecycle_visibility",
						match: { value: visibility },
					},
				],
			},
		})
	).count;
}
