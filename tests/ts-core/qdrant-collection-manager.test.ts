import assert from "node:assert/strict";
import test from "node:test";

import type { QdrantClient } from "@qdrant/js-client-rest";
import {
	parseQdrantDistance,
	type QdrantCollectionClient,
	QdrantCollectionContractError,
	QdrantCollectionManager,
	UNORAG_QDRANT_PAYLOAD_INDEXES,
} from "../../src/core/retrieval/qdrant/collection-manager";
import { QdrantRetrievalStore } from "../../src/core/retrieval/qdrant/store";

type CollectionInfo = Awaited<ReturnType<QdrantClient["getCollection"]>>;

function collectionInfo(input?: {
	size?: number;
	distance?: "Cosine" | "Euclid" | "Dot" | "Manhattan";
	indexes?: Record<string, "keyword" | "integer">;
}): CollectionInfo {
	return {
		status: "green",
		optimizer_status: "ok",
		segments_count: 1,
		config: {
			params: {
				vectors: {
					size: input?.size ?? 1_024,
					distance: input?.distance ?? "Cosine",
				},
				shard_number: 1,
				replication_factor: 1,
				write_consistency_factor: 1,
				on_disk_payload: false,
			},
			hnsw_config: {
				m: 16,
				ef_construct: 100,
				full_scan_threshold: 10_000,
				max_indexing_threads: 0,
				on_disk: false,
			},
			optimizer_config: {
				deleted_threshold: 0.2,
				vacuum_min_vector_number: 1_000,
				default_segment_number: 0,
				max_segment_size: null,
				memmap_threshold: null,
				indexing_threshold: 20_000,
				flush_interval_sec: 5,
				max_optimization_threads: null,
			},
			wal_config: {
				wal_capacity_mb: 32,
				wal_segments_ahead: 0,
			},
		},
		payload_schema: Object.fromEntries(
			Object.entries(input?.indexes ?? {}).map(([field, dataType]) => [
				field,
				{ data_type: dataType, points: 0 },
			]),
		),
	};
}

function fakeClient(input?: {
	exists?: boolean;
	info?: CollectionInfo;
	createCollectionError?: Error;
}): {
	client: QdrantCollectionClient;
	calls: Array<{ name: string; fieldName?: string; fieldSchema?: unknown }>;
} {
	let exists = input?.exists ?? false;
	let info = input?.info ?? collectionInfo();
	const calls: Array<{
		name: string;
		fieldName?: string;
		fieldSchema?: unknown;
	}> = [];
	return {
		client: {
			async collectionExists() {
				calls.push({ name: "collectionExists" });
				return { exists };
			},
			async createCollection(_collection, request) {
				calls.push({ name: "createCollection" });
				if (input?.createCollectionError) {
					exists = true;
					throw input.createCollectionError;
				}
				const vectors = request.vectors as {
					size: number;
					distance: "Cosine" | "Euclid" | "Dot" | "Manhattan";
				};
				exists = true;
				info = collectionInfo({
					size: vectors.size,
					distance: vectors.distance,
				});
				return true;
			},
			async getCollection() {
				calls.push({ name: "getCollection" });
				return info;
			},
			async createPayloadIndex(_collection, request) {
				calls.push({
					name: "createPayloadIndex",
					fieldName: request.field_name,
					fieldSchema: request.field_schema,
				});
				info = {
					...info,
					payload_schema: {
						...info.payload_schema,
						[request.field_name]: { data_type: "keyword", points: 0 },
					},
				};
				return { status: "completed" };
			},
		},
		calls,
	};
}

test("collection manager creates the dense collection and every UnoRAG payload index", async () => {
	const { client, calls } = fakeClient();
	const manager = new QdrantCollectionManager(client, {
		collection: "unorag_chunks",
		vectorSize: 1_024,
		distance: "Cosine",
	});

	const result = await manager.ensure();

	assert.equal(result.created, true);
	assert.deepEqual(
		result.createdPayloadIndexes,
		UNORAG_QDRANT_PAYLOAD_INDEXES.map((index) => index.fieldName),
	);
	assert.equal(
		calls.filter((call) => call.name === "createCollection").length,
		1,
	);
	assert.equal(
		calls.filter((call) => call.name === "createPayloadIndex").length,
		UNORAG_QDRANT_PAYLOAD_INDEXES.length,
	);
	assert.deepEqual(
		calls.find(
			(call) =>
				call.name === "createPayloadIndex" && call.fieldName === "tenant_id",
		)?.fieldSchema,
		{ type: "keyword", is_tenant: true },
	);
});

test("collection manager is reusable, validates existing indexes, and coalesces ensure calls", async () => {
	const indexes = Object.fromEntries(
		UNORAG_QDRANT_PAYLOAD_INDEXES.map((index) => [index.fieldName, "keyword"]),
	) as Record<string, "keyword">;
	const { client, calls } = fakeClient({
		exists: true,
		info: collectionInfo({ indexes }),
	});
	const manager = new QdrantCollectionManager(client, {
		collection: "unorag_chunks",
		vectorSize: 1_024,
		distance: "Cosine",
	});

	const [first, second] = await Promise.all([
		manager.ensure(),
		manager.ensure(),
	]);

	assert.deepEqual(first, second);
	assert.equal(first.created, false);
	assert.deepEqual(first.createdPayloadIndexes, []);
	assert.equal(
		calls.filter((call) => call.name === "collectionExists").length,
		1,
	);
	assert.equal(
		calls.some((call) => call.name === "createPayloadIndex"),
		false,
	);
});

test("collection manager accepts compatible create races", async () => {
	const { client } = fakeClient({
		createCollectionError: new Error("already exists"),
	});
	const manager = new QdrantCollectionManager(client, {
		collection: "unorag_chunks",
		vectorSize: 1_024,
		distance: "Cosine",
	});

	const result = await manager.ensure();

	assert.equal(result.created, false);
	assert.equal(
		result.createdPayloadIndexes.length,
		UNORAG_QDRANT_PAYLOAD_INDEXES.length,
	);
});

test("collection manager fails closed on vector and payload index contract mismatches", async () => {
	const wrongSize = fakeClient({
		exists: true,
		info: collectionInfo({ size: 768 }),
	});
	await assert.rejects(
		new QdrantCollectionManager(wrongSize.client, {
			collection: "unorag_chunks",
			vectorSize: 1_024,
			distance: "Cosine",
		}).ensure(),
		/vector size mismatch/,
	);

	const wrongDistance = fakeClient({
		exists: true,
		info: collectionInfo({ distance: "Dot" }),
	});
	await assert.rejects(
		new QdrantCollectionManager(wrongDistance.client, {
			collection: "unorag_chunks",
			vectorSize: 1_024,
			distance: "Cosine",
		}).ensure(),
		/distance mismatch/,
	);

	const wrongIndex = fakeClient({
		exists: true,
		info: collectionInfo({ indexes: { tenant_id: "integer" } }),
	});
	await assert.rejects(
		new QdrantCollectionManager(wrongIndex.client, {
			collection: "unorag_chunks",
			vectorSize: 1_024,
			distance: "Cosine",
		}).ensure(),
		/payload index tenant_id must be keyword/,
	);
});

test("distance parser normalizes supported values and rejects unknown values", () => {
	assert.equal(parseQdrantDistance(undefined), "Cosine");
	assert.equal(parseQdrantDistance(" dot "), "Dot");
	assert.throws(
		() => parseQdrantDistance("hamming"),
		QdrantCollectionContractError,
	);
});

test("retrieval store never queries before collection readiness succeeds", async () => {
	let searches = 0;
	const client = {
		async search() {
			searches += 1;
			return [];
		},
	} as unknown as QdrantClient;
	const store = new QdrantRetrievalStore(
		client,
		"unorag_chunks",
		Promise.reject(new Error("collection contract mismatch")),
	);

	await assert.rejects(
		store.search({
			vector: [1, 0],
			scope: {
				tenantId: "tenant",
				workspaceId: "workspace",
				libraryId: "library",
				principalIds: ["principal"],
				groupIds: [],
				activeGenerationIds: ["generation"],
			},
			limit: 1,
		}),
		/collection contract mismatch/,
	);
	assert.equal(searches, 0);
});
