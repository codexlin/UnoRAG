import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import type { DocumentIngestJob } from "../../src/worker/contracts";
import { LocalDocumentIngestSource } from "../../src/worker/document-ingest-production";
import { DocumentIngestStager } from "../../src/worker/document-ingest-staging";

const qdrantUrl = process.env.QDRANT_INGEST_E2E_URL?.trim();

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
