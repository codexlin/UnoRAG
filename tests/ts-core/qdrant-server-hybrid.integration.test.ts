import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { QdrantClient, type Schemas } from "@qdrant/js-client-rest";
import type { AuthorizedScope } from "../../src/core/contracts";
import type { IndexWritePayload } from "../../src/core/ingest/index-records";
import {
	type IngestPointScope,
	QdrantIngestWriteStore,
} from "../../src/core/ingest/qdrant-write-store";
import type { RetrievalScope } from "../../src/core/retrieval/contracts";
import type {
	EmbeddingProvider,
	SparseVector,
} from "../../src/core/retrieval/embedding/provider";
import { buildMandatoryQdrantFilter } from "../../src/core/retrieval/filters/qdrant-filter";
import {
	QdrantCollectionContractError,
	QdrantCollectionManager,
	type QdrantVectorSchema,
} from "../../src/core/retrieval/qdrant/collection-manager";
import { QdrantRetrievalStore } from "../../src/core/retrieval/qdrant/store";
import { DefaultRetrievalService } from "../../src/core/retrieval/retrieval-service";

const url = process.env.QDRANT_INGEST_E2E_URL?.trim();
const integration = {
	skip: url ? false : "QDRANT_INGEST_E2E_URL is not configured",
};
const query = "ZXQ987 合同违约金";

// Test-only fixture mapping simulating DashScope qwen3.7-text-embedding neural sparse output.
const TEST_NEURAL_VOCAB: ReadonlyArray<[string, number, number]> = [
	["zxq987", 987, 3.6],
	["合同", 1001, 2.2],
	["违约金", 1002, 2.9],
	["annual", 2001, 0.4],
	["report", 2002, 0.3],
];

function fixtureNeuralSparse(text: string): SparseVector {
	const lower = text.toLowerCase();
	const indices: number[] = [];
	const values: number[] = [];
	for (const [term, id, weight] of TEST_NEURAL_VOCAB) {
		if (lower.includes(term)) {
			indices.push(id);
			values.push(weight);
		}
	}
	return { indices, values };
}

const neuralSparseEmbeddings: EmbeddingProvider = {
	supportsSparse: true,
	async embedQuery() {
		return [1, 0];
	},
	async embedTexts(texts: string[]) {
		return texts.map(() => [1, 0]);
	},
	async embedQueryWithSparse(text: string) {
		return {
			dense: [1, 0],
			sparse: fixtureNeuralSparse(text),
		};
	},
	async embedTextsWithSparse(texts: string[]) {
		return texts.map((text) => ({
			dense: [1, 0],
			sparse: fixtureNeuralSparse(text),
		}));
	},
};

const denseOnlyEmbeddings: EmbeddingProvider = {
	supportsSparse: false,
	async embedQuery() {
		return [1, 0];
	},
	async embedTexts(texts: string[]) {
		return texts.map(() => [1, 0]);
	},
};

function createScope(): IngestPointScope {
	return {
		organizationId: randomUUID(),
		workspaceId: randomUUID(),
		libraryId: randomUUID(),
		documentId: randomUUID(),
		documentVersionId: randomUUID(),
		generationId: randomUUID(),
		title: "Hybrid fixture",
		acl: { scope: "workspace", principalIds: [], groupIds: [] },
	};
}

function record(scope: IngestPointScope, text: string): IndexWritePayload {
	return {
		_point_id: randomUUID(),
		tenant_id: scope.organizationId,
		workspace_id: scope.workspaceId,
		document_version_id: scope.documentVersionId,
		generation_id: scope.generationId,
		lifecycle_visibility: "staging",
		record_type: "chunk",
		record_id: randomUUID(),
		chunk_index: 0,
		text,
		body: text,
		embed_text: text,
		source_chunk_ids: [],
	};
}

function retrievalScope(scope: IngestPointScope): RetrievalScope {
	return {
		tenantId: scope.organizationId,
		workspaceId: scope.workspaceId,
		libraryId: scope.libraryId,
		documentIds: [scope.documentId],
		activeGenerationIds: [scope.generationId],
		principalIds: ["user-a"],
		groupIds: ["group-a"],
	};
}

function authorized(scope: RetrievalScope): AuthorizedScope {
	return {
		organizationId: scope.tenantId,
		workspaceId: scope.workspaceId,
		libraryIds: [scope.libraryId],
		documentIds: scope.documentIds,
		activeGenerationIds: scope.activeGenerationIds,
		principalIds: scope.principalIds,
		groupIds: scope.groupIds,
	};
}

function vectorMap(
	schema: QdrantVectorSchema,
	vector: number[],
	text: string,
): Schemas["VectorStruct"] {
	return {
		[schema.denseVectorName ?? ""]: vector,
		[schema.sparseVectorName ?? "sparse_v1"]: fixtureNeuralSparse(text),
	};
}

function service(
	store: QdrantRetrievalStore,
	provider: EmbeddingProvider = neuralSparseEmbeddings,
) {
	return new DefaultRetrievalService(provider, store, null, {
		hybridEnabled: true,
		rerankEnabled: false,
		bm25TopK: 10,
		rerankTopK: 2,
		rrfK: 60,
	});
}

test(
	"real Qdrant sparse_v1 prefetch and RRF enforce every authorization dimension and deletion boundary",
	integration,
	async () => {
		const client = new QdrantClient({ url, checkCompatibility: true });
		const collection = `unorag_sparse_gate_${randomUUID().replaceAll("-", "")}`;
		try {
			const ready = new QdrantCollectionManager(client, {
				collection,
				vectorSize: 2,
				distance: "Cosine",
				expectSparse: true,
			}).ensure();
			const { vectorSchema } = await ready;
			assert.deepEqual(vectorSchema, {
				denseVectorName: "dense",
				sparseVectorName: "sparse_v1",
			});
			const info = await client.getCollection(collection);
			assert.ok(info.config.params.sparse_vectors?.sparse_v1);
			assert.notEqual(
				info.config.params.sparse_vectors?.sparse_v1?.modifier,
				"idf",
			);
			const writer = new QdrantIngestWriteStore(client, collection, {
				vectorSchema,
			});
			const scope = createScope();
			const exact = record(scope, query);
			const decoy = record(scope, "ordinary semantic content");
			await writer.stage({
				scope,
				records: [exact, decoy],
				vectors: [
					[0, 1],
					[1, 0],
				],
				sparseVectors: [
					fixtureNeuralSparse(exact.embed_text),
					fixtureNeuralSparse(decoy.embed_text),
				],
			});
			await writer.setVisibility(scope, "active");
			const stored = (
				await client.retrieve(collection, {
					ids: [exact._point_id],
					with_vector: true,
					with_payload: true,
				})
			)[0];
			const storedSparse = (stored.vector as Record<string, unknown>)
				.sparse_v1 as SparseVector;
			assert.deepEqual(
				storedSparse.indices,
				fixtureNeuralSparse(query).indices,
			);
			for (let idx = 0; idx < storedSparse.values.length; idx += 1) {
				assert.ok(
					Math.abs(
						storedSparse.values[idx] - fixtureNeuralSparse(query).values[idx],
					) < 1e-4,
				);
			}
			const payload = stored.payload ?? {};
			const principalId = randomUUID();
			const groupId = randomUUID();
			const denied: Array<Record<string, unknown>> = [
				{ tenant_id: "other-tenant" },
				{ workspace_id: "other-workspace" },
				{ library_id: "other-library" },
				{ doc_id: "unselected-document" },
				{ generation_id: "non-active-generation" },
				{ acl_scope: null, acl_principal_ids: [], acl_group_ids: [] },
				{
					acl_scope: "restricted",
					acl_principal_ids: ["user-other"],
					acl_group_ids: ["group-other"],
				},
				{ lifecycle_visibility: "staging" },
				{ lifecycle_visibility: "inactive" },
				// Deleted in PostgreSQL, still physically active in Qdrant and still in generation snapshot.
				{ doc_id: "deleted-document-residue" },
			];
			const deniedIds = denied.map(() => randomUUID());
			await client.upsert(collection, {
				wait: true,
				points: [
					...denied.map((changes, index) => ({
						id: deniedIds[index],
						vector: vectorMap(vectorSchema, [1, 0], query),
						payload: { ...payload, ...changes },
					})),
					{
						id: principalId,
						vector: vectorMap(vectorSchema, [0, 1], "合同"),
						payload: {
							...payload,
							text: "principal-only 合同",
							body: "principal-only 合同",
							acl_scope: "restricted",
							acl_principal_ids: ["user-a"],
							acl_group_ids: [],
						},
					},
					{
						id: groupId,
						vector: vectorMap(vectorSchema, [0, 1], "合同"),
						payload: {
							...payload,
							text: "group-only 合同",
							body: "group-only 合同",
							acl_scope: "restricted",
							acl_principal_ids: [],
							acl_group_ids: ["group-a"],
						},
					},
				],
			});
			const scopeFilter = retrievalScope(scope);
			const allowedIds = [
				exact._point_id,
				decoy._point_id,
				principalId,
				groupId,
			];
			const filter = buildMandatoryQdrantFilter({
				scope: scopeFilter,
			}) as Schemas["Filter"];
			// Assert both legs directly, so final fusion/post-filtering cannot conceal a leak.
			for (const request of [
				{ query: [1, 0], using: "dense" },
				{ query: fixtureNeuralSparse(query), using: "sparse_v1" },
			]) {
				const leg = await client.query(collection, {
					...request,
					filter,
					limit: 100,
				});
				assert.ok(leg.points.length > 0);
				for (const point of leg.points)
					assert.ok(
						allowedIds.includes(String(point.id)),
						`prefetch leaked ${point.id}`,
					);
			}
			const store = new QdrantRetrievalStore(client, collection, ready, {
				vectorSchema: ready.then((result) => result.vectorSchema),
			});
			const fused = await store.hybridSearch({
				vector: [1, 0],
				query,
				sparseVector: fixtureNeuralSparse(query),
				scope: scopeFilter,
				limit: 100,
				sparseLimit: 100,
				rrfK: 60,
			});
			assert.ok(fused);
			assert.deepEqual(
				new Set(fused.map((hit) => String(hit.id))),
				new Set(allowedIds),
			);
			for (const id of deniedIds)
				assert.equal(
					fused.some((hit) => hit.id === id),
					false,
				);
			store.listCorpus = async () => {
				assert.fail("server hybrid must not scroll a bounded corpus");
			};
			const result = await service(store).retrieve({
				query: "ZXQ987",
				libraryId: scope.libraryId,
				scope: authorized(scopeFilter),
				topK: 4,
			});
			assert.equal(result.citations[0].id, exact._point_id);
			assert.equal(result.debug.usedHybrid, true);
			assert.equal(result.debug.hybridFailed, false);
			assert.equal(result.debug.retrievalMode, "hybrid");
			assert.equal(result.citations[0].dense_score, 0);
			assert.ok(
				result.citations.every((citation) => allowedIds.includes(citation.id)),
			);
			const chinese = await client.query(collection, {
				query: fixtureNeuralSparse("违约金"),
				using: "sparse_v1",
				filter,
				limit: 100,
			});
			assert.deepEqual(
				chinese.points.map((point) => String(point.id)),
				[exact._point_id],
			);
			const constrained = await store.hybridSearch({
				vector: [1, 0],
				query,
				sparseVector: fixtureNeuralSparse(query),
				scope: scopeFilter,
				userFilters: { document_version_id: "wrong-version" },
				limit: 100,
				sparseLimit: 100,
				rrfK: 60,
			});
			assert.deepEqual(constrained, []);
			for (const emptyScope of [
				{ ...scopeFilter, documentIds: [] },
				{ ...scopeFilter, activeGenerationIds: [] },
			]) {
				assert.deepEqual(
					await store.hybridSearch({
						vector: [1, 0],
						query,
						sparseVector: fixtureNeuralSparse(query),
						scope: emptyScope,
						limit: 100,
						sparseLimit: 100,
						rrfK: 60,
					}),
					[],
				);
			}
			const noGroups = await store.hybridSearch({
				vector: [1, 0],
				query,
				sparseVector: fixtureNeuralSparse(query),
				scope: {
					...scopeFilter,
					groupIds: [],
					principalIds: ["user-other-ungranted"],
				},
				limit: 100,
				sparseLimit: 100,
				rrfK: 60,
			});
			assert.deepEqual(
				new Set(noGroups?.map((hit) => String(hit.id))),
				new Set([exact._point_id, decoy._point_id]),
			);
			await client.delete(collection, {
				points: [exact._point_id],
				wait: true,
			});
			const deleted = await store.hybridSearch({
				vector: [1, 0],
				query,
				sparseVector: fixtureNeuralSparse(query),
				scope: scopeFilter,
				limit: 100,
				sparseLimit: 100,
				rrfK: 60,
			});
			assert.ok(deleted?.every((hit) => hit.id !== exact._point_id));
		} finally {
			if ((await client.collectionExists(collection)).exists)
				await client.deleteCollection(collection);
		}
	},
);

for (const scenario of [
	{ name: "named dense without sparse_v1", named: true, sparse: undefined },
	{ name: "unnamed dense without sparse_v1", named: false, sparse: undefined },
	{
		name: "legacy lexical_v1 (idf)",
		named: true,
		sparse: { lexical_v1: { modifier: "idf" as const } },
	},
	{
		name: "sparse_v1 with wrong idf modifier",
		named: true,
		sparse: { sparse_v1: { modifier: "idf" as const } },
	},
]) {
	test(
		`real Qdrant ${scenario.name} fails closed when expectSparse is true`,
		integration,
		async () => {
			const client = new QdrantClient({ url, checkCompatibility: true });
			const collection = `unorag_sparse_legacy_${randomUUID().replaceAll("-", "")}`;
			try {
				await client.createCollection(collection, {
					vectors: scenario.named
						? { dense: { size: 2, distance: "Cosine" } }
						: { size: 2, distance: "Cosine" },
					...(scenario.sparse ? { sparse_vectors: scenario.sparse } : {}),
				});
				await assert.rejects(
					new QdrantCollectionManager(client, {
						collection,
						vectorSize: 2,
						distance: "Cosine",
						expectSparse: true,
					}).ensure(),
					QdrantCollectionContractError,
				);
			} finally {
				if ((await client.collectionExists(collection)).exists)
					await client.deleteCollection(collection);
			}
		},
	);
}

test(
	"real Qdrant dense-only mode (Ollama bge-m3) stages and retrieves cleanly without sparse vectors",
	integration,
	async () => {
		const client = new QdrantClient({ url, checkCompatibility: true });
		const collection = `unorag_ollama_dense_${randomUUID().replaceAll("-", "")}`;
		try {
			const ready = new QdrantCollectionManager(client, {
				collection,
				vectorSize: 2,
				distance: "Cosine",
				expectSparse: false,
			}).ensure();
			const { vectorSchema } = await ready;
			assert.deepEqual(vectorSchema, {
				denseVectorName: "dense",
				sparseVectorName: null,
			});
			const scope = createScope();
			const doc = record(scope, "private local bge-m3 chunk");
			const writer = new QdrantIngestWriteStore(client, collection, {
				vectorSchema,
			});
			await writer.stage({ scope, records: [doc], vectors: [[1, 0]] });
			await writer.setVisibility(scope, "active");
			const store = new QdrantRetrievalStore(client, collection, ready, {
				vectorSchema: ready.then((result) => result.vectorSchema),
			});
			const result = await service(store, denseOnlyEmbeddings).retrieve({
				query: "local bge-m3",
				libraryId: scope.libraryId,
				scope: authorized(retrievalScope(scope)),
				topK: 1,
			});
			assert.equal(result.citations[0].id, doc._point_id);
			assert.equal(result.debug.usedHybrid, false);
			assert.equal(result.debug.hybridFailed, false);
			assert.equal(result.debug.retrievalMode, "dense");
		} finally {
			if ((await client.collectionExists(collection)).exists)
				await client.deleteCollection(collection);
		}
	},
);

test(
	"real Qdrant sparse_v1 (modifier: none) preserves neural sparse term weights directly without double IDF",
	integration,
	async () => {
		const client = new QdrantClient({ url, checkCompatibility: true });
		const collection = `unorag_sparse_neural_${randomUUID().replaceAll("-", "")}`;
		try {
			const ready = new QdrantCollectionManager(client, {
				collection,
				vectorSize: 2,
				distance: "Cosine",
				expectSparse: true,
			}).ensure();
			const { vectorSchema } = await ready;
			const scope = createScope();
			const boilerplate = Array.from({ length: 4 }, () =>
				record(scope, "annual report"),
			);
			const salient = record(scope, "ZXQ987");
			const records = [...boilerplate, salient];
			const writer = new QdrantIngestWriteStore(client, collection, {
				vectorSchema,
			});
			await writer.stage({
				scope,
				records,
				vectors: records.map(() => [1, 0]),
				sparseVectors: records.map((item) =>
					fixtureNeuralSparse(item.embed_text),
				),
			});
			await writer.setVisibility(scope, "active");
			const sparseHits = await client.query(collection, {
				query: fixtureNeuralSparse("annual report ZXQ987"),
				using: "sparse_v1",
				filter: buildMandatoryQdrantFilter({
					scope: retrievalScope(scope),
				}) as Schemas["Filter"],
				limit: 3,
				with_payload: false,
			});
			assert.equal(sparseHits.points[0]?.id, salient._point_id);
		} finally {
			if ((await client.collectionExists(collection)).exists)
				await client.deleteCollection(collection);
		}
	},
);
