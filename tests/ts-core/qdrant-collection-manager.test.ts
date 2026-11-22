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
import {
	diagnoseQdrantError,
	projectQdrantDiagnostic,
} from "../../src/core/retrieval/qdrant/diagnostics";
import {
	QdrantOperationError,
	QdrantRetrievalStore,
} from "../../src/core/retrieval/qdrant/store";

type CollectionInfo = Awaited<ReturnType<QdrantClient["getCollection"]>>;

test("Qdrant cause classification preserves only safe structured metadata", () => {
	for (const [error, category, status, code, retryable] of [
		[
			new TypeError("fetch failed private-url sk-secret", {
				cause: Object.assign(new Error("private body"), { code: "ECONNRESET" }),
			}),
			"transport",
			null,
			"ECONNRESET",
			true,
		],
		[
			Object.assign(new Error("private body"), {
				name: "ApiError",
				status: 503,
			}),
			"http",
			503,
			null,
			true,
		],
		[
			Object.assign(
				new Error(
					"Unexpected Response: 401 Unauthorized\nRaw response content: private body",
				),
				{ name: "QdrantClientUnexpectedResponseError" },
			),
			"http",
			401,
			null,
			false,
		],
		[
			Object.assign(new Error("private body"), {
				name: "QdrantClientTimeoutError",
			}),
			"timeout",
			null,
			null,
			true,
		],
		[
			Object.assign(new Error("private body"), {
				name: "QdrantClientResourceExhaustedError",
			}),
			"http",
			429,
			null,
			true,
		],
		[
			Object.assign(new Error("private body"), { code: "ENOTFOUND" }),
			"transport",
			null,
			"ENOTFOUND",
			false,
		],
		[
			new DOMException("private body", "AbortError"),
			"cancelled",
			null,
			null,
			false,
		],
		[new SyntaxError("private body"), "invalid_response", null, null, false],
		[
			new TypeError("fetch failed private body"),
			"transport",
			null,
			null,
			false,
		],
		[
			Object.assign(new Error("private body"), { code: "sk-secret" }),
			"unknown",
			null,
			null,
			false,
		],
	] as const) {
		const detail = diagnoseQdrantError("query", error, {
			durationMs: 201,
			timeoutMs: 5000,
		});
		assert.equal(detail.category, category);
		assert.equal(detail.statusCode, status);
		assert.equal(detail.transportCode, code);
		assert.equal(detail.retryable, retryable);
		assert.equal(detail.attempts, 1);
		assert.equal(detail.durationMs, 201);
		assert.doesNotMatch(JSON.stringify(detail), /private|sk-secret/);
		assert.deepEqual(
			projectQdrantDiagnostic({
				...detail,
				message: "private body",
				url: "private-url",
			}),
			detail,
		);
	}
	assert.equal(
		projectQdrantDiagnostic({
			...diagnoseQdrantError("query", null),
			category: "private body",
		}),
		null,
	);
	const circular = new Error("private body");
	circular.cause = circular;
	assert.equal(diagnoseQdrantError("scroll", circular).category, "unknown");
});

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
					dense: {
						size: input?.size ?? 1_024,
						distance: input?.distance ?? "Cosine",
					},
				},
				sparse_vectors: {
					lexical_v1: {
						modifier: "idf",
					},
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
	calls: Array<{
		name: string;
		fieldName?: string;
		fieldSchema?: unknown;
		createCollection?: string;
		createRequest?: unknown;
	}>;
} {
	let exists = input?.exists ?? false;
	let info = input?.info ?? collectionInfo();
	const calls: Array<{
		name: string;
		fieldName?: string;
		fieldSchema?: unknown;
		createCollection?: string;
		createRequest?: unknown;
	}> = [];
	return {
		client: {
			async collectionExists() {
				calls.push({ name: "collectionExists" });
				return { exists };
			},
			async createCollection(collection, request) {
				calls.push({
					name: "createCollection",
					createCollection: collection,
					createRequest: request,
				});
				if (input?.createCollectionError) {
					exists = true;
					throw input.createCollectionError;
				}
				exists = true;
				info = collectionInfo();
				if (request.vectors) {
					info.config.params.vectors =
						request.vectors as CollectionInfo["config"]["params"]["vectors"];
				}
				if (request.sparse_vectors) {
					info.config.params.sparse_vectors =
						request.sparse_vectors as CollectionInfo["config"]["params"]["sparse_vectors"];
				}
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

test("new-collection mode refuses existing targets before modifying indexes", async () => {
	const { client, calls } = fakeClient({ exists: true });
	const manager = new QdrantCollectionManager(
		client,
		{
			collection: "unorag_chunks_hybrid",
			vectorSize: 1_024,
			distance: "Cosine",
		},
		{ requireNew: true },
	);
	await assert.rejects(manager.ensure(), /already exists/);
	assert.deepEqual(
		calls.map((call) => call.name),
		["collectionExists"],
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
		async query() {
			searches += 1;
			return { points: [] };
		},
	} as unknown as QdrantClient;
	const store = new QdrantRetrievalStore(
		client,
		"unorag_chunks",
		Promise.reject(
			new QdrantCollectionContractError("collection contract mismatch"),
		),
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

for (const operation of ["ready", "query", "scroll"] as const) {
	test(`retrieval store identifies Qdrant ${operation} failures without exposing provider content`, async () => {
		const cause = new TypeError(
			"fetch failed: private endpoint and request content",
		);
		const client = {
			async query() {
				throw cause;
			},
			async scroll() {
				throw cause;
			},
		} as unknown as QdrantClient;
		const store = new QdrantRetrievalStore(
			client,
			"unorag_chunks",
			operation === "ready" ? Promise.reject(cause) : Promise.resolve(),
		);
		const input = {
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
		};
		await assert.rejects(
			operation === "scroll" ? store.listCorpus(input) : store.search(input),
			(error) => {
				assert.ok(error instanceof QdrantOperationError);
				assert.equal(error.operation, operation);
				assert.equal(error.cause, cause);
				assert.equal(error.message, `Qdrant ${operation} operation failed`);
				return true;
			},
		);
	});
}

test("retrieval store uses the universal query API with mandatory scope", async () => {
	const calls: unknown[] = [];
	const client = {
		async query(_collection: string, input: unknown) {
			calls.push(input);
			return { points: [] };
		},
	} as unknown as QdrantClient;
	const store = new QdrantRetrievalStore(client, "unorag_chunks");

	assert.deepEqual(
		await store.search({
			vector: [1, 0],
			scope: {
				tenantId: "tenant",
				workspaceId: "workspace",
				libraryId: "library",
				principalIds: ["principal"],
				groupIds: [],
				activeGenerationIds: ["generation"],
			},
			limit: 3,
		}),
		[],
	);
	const request = calls[0] as {
		query: number[];
		filter: { must: Array<Record<string, unknown>> };
		limit: number;
		with_payload: boolean;
		with_vector: boolean;
	};
	assert.deepEqual(request.query, [1, 0]);
	assert.equal(request.limit, 3);
	assert.equal(request.with_payload, true);
	assert.equal(request.with_vector, false);
	assert.ok(
		request.filter.must.some(
			(condition) =>
				condition.key === "tenant_id" &&
				JSON.stringify(condition.match) === JSON.stringify({ value: "tenant" }),
		),
	);
	assert.ok(
		request.filter.must.some(
			(condition) =>
				condition.key === "workspace_id" &&
				JSON.stringify(condition.match) ===
					JSON.stringify({ value: "workspace" }),
		),
	);
});

test("collection capability detects named and migrated unnamed dense schemas", async () => {
	for (const named of [false, true]) {
		const info = collectionInfo();
		info.config.params.vectors = named
			? { dense: { size: 1024, distance: "Cosine" } }
			: { size: 1024, distance: "Cosine" };
		info.config.params.sparse_vectors = { lexical_v1: { modifier: "idf" } };
		const { client } = fakeClient({ exists: true, info });
		const result = await new QdrantCollectionManager(client, {
			collection: "test",
			vectorSize: 1024,
			distance: "Cosine",
		}).ensure();
		assert.deepEqual(result.vectorSchema, {
			denseVectorName: named ? "dense" : null,
			sparseVectorName: "lexical_v1",
		});
	}
	const legacyInfo = collectionInfo();
	legacyInfo.config.params.vectors = { size: 1024, distance: "Cosine" };
	delete legacyInfo.config.params.sparse_vectors;
	const { client, calls } = fakeClient({ exists: true, info: legacyInfo });
	await assert.rejects(
		new QdrantCollectionManager(client, {
			collection: "legacy",
			vectorSize: 1024,
			distance: "Cosine",
		}).ensure(),
		QdrantCollectionContractError,
	);
	assert.equal(
		calls.some((call) => call.name === "createCollection"),
		false,
	);
});

test("creating a collection always configures named dense and lexical_v1 with Qdrant IDF modifier", async () => {
	const { client, calls } = fakeClient({ exists: false });
	const result = await new QdrantCollectionManager(client, {
		collection: "hybrid_new",
		vectorSize: 1024,
		distance: "Cosine",
	}).ensure();
	assert.equal(result.created, true);
	assert.deepEqual(result.vectorSchema, {
		denseVectorName: "dense",
		sparseVectorName: "lexical_v1",
	});
	const createCall = calls.find((call) => call.name === "createCollection");
	assert.ok(createCall);
	assert.equal(createCall.createCollection, "hybrid_new");
	assert.deepEqual(createCall.createRequest, {
		vectors: { dense: { size: 1024, distance: "Cosine" } },
		sparse_vectors: { lexical_v1: { modifier: "idf" } },
	});
});

test("incompatible named dimensions, unknown dense names and missing or non-IDF sparse fail closed", async () => {
	for (const params of [
		{ vectors: { dense: { size: 3, distance: "Cosine" as const } } },
		{ vectors: { unknown: { size: 1024, distance: "Cosine" as const } } },
		{ sparse_vectors: undefined },
		{ sparse_vectors: { lexical_v1: {} } },
		{ sparse_vectors: { lexical_v1: { modifier: "none" as const } } },
	]) {
		const info = collectionInfo();
		Object.assign(info.config.params, params);
		const { client } = fakeClient({ exists: true, info });
		await assert.rejects(
			new QdrantCollectionManager(client, {
				collection: "test",
				vectorSize: 1024,
				distance: "Cosine",
			}).ensure(),
			QdrantCollectionContractError,
		);
	}
});

test("both server prefetch branches and fusion carry the complete mandatory authorization filter", async () => {
	const scope = {
		tenantId: "tenant",
		workspaceId: "workspace",
		libraryId: "library",
		principalIds: ["principal"],
		groupIds: ["group"],
		activeGenerationIds: ["generation"],
		documentIds: ["document"],
	};
	const requests: Array<Parameters<QdrantClient["query"]>[1]> = [];
	const client = {
		async query(
			_collection: string,
			request: Parameters<QdrantClient["query"]>[1],
		) {
			requests.push(request);
			return { points: [] };
		},
	} as unknown as QdrantClient;
	const store = new QdrantRetrievalStore(client, "test", Promise.resolve(), {
		vectorSchema: Promise.resolve({
			denseVectorName: "dense",
			sparseVectorName: "lexical_v1",
		}),
	});
	await store.search({ vector: [1, 0], scope, limit: 5 });
	assert.equal(requests[0].using, "dense");
	const result = await store.hybridSearch({
		vector: [1, 0],
		query: "合同 ZXQ987",
		scope,
		userFilters: { document_version_id: "version" },
		limit: 5,
		sparseLimit: 3,
		rrfK: 60,
	});
	assert.deepEqual(result, []);
	const request = requests[1];
	assert.deepEqual(request.query, { rrf: { k: 60 } });
	assert.ok(Array.isArray(request.prefetch));
	assert.equal(request.prefetch.length, 2);
	for (const prefetch of request.prefetch) {
		assert.deepEqual(prefetch.filter, request.filter);
		assert.ok((prefetch.limit ?? 0) >= 5);
		const encoded = JSON.stringify(prefetch.filter);
		for (const value of [
			"tenant_id",
			"workspace_id",
			"library_id",
			"generation_id",
			"doc_id",
			"acl_principal_ids",
			"acl_group_ids",
			"lifecycle_visibility",
			"document_version_id",
			"principal",
			"group",
			"generation",
			"version",
		])
			assert.ok(encoded.includes(value), value);
	}
	assert.equal(request.prefetch[0].using, "dense");
	assert.equal(request.prefetch[1].using, "lexical_v1");
	assert.equal(
		await store.hybridSearch({
			vector: [1, 0],
			query: "!?",
			scope,
			limit: 5,
			sparseLimit: 5,
			rrfK: 60,
		}),
		null,
	);
	assert.equal(requests.length, 2);
});
