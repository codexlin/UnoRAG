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
import { buildMandatoryQdrantFilter } from "../../src/core/retrieval/filters/qdrant-filter";
import { sparseVector } from "../../src/core/retrieval/hybrid/sparse-vector";
import {
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
const embeddings = {
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
		[schema.sparseVectorName ?? "lexical_v1"]: sparseVector(text),
	};
}

function service(store: QdrantRetrievalStore) {
	return new DefaultRetrievalService(embeddings, store, null, {
		hybridEnabled: true,
		rerankEnabled: false,
		bm25TopK: 10,
		rerankTopK: 2,
		rrfK: 60,
		corpusLimit: 3,
	});
}

test(
	"real Qdrant sparse prefetch and RRF enforce every authorization dimension and deletion boundary",
	integration,
	async () => {
		const client = new QdrantClient({ url, checkCompatibility: true });
		const collection = `unorag_sparse_gate_${randomUUID().replaceAll("-", "")}`;
		try {
			const ready = new QdrantCollectionManager(client, {
				collection,
				vectorSize: 2,
				distance: "Cosine",
				serverHybridEnabled: true,
			}).ensure();
			const { vectorSchema } = await ready;
			assert.deepEqual(vectorSchema, {
				denseVectorName: "dense",
				sparseVectorName: "lexical_v1",
			});
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
			});
			await writer.setVisibility(scope, "active");
			const stored = (
				await client.retrieve(collection, {
					ids: [exact._point_id],
					with_vector: true,
					with_payload: true,
				})
			)[0];
			assert.deepEqual(
				(stored.vector as Record<string, unknown>).lexical_v1,
				sparseVector(query),
			);
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
				{ query: sparseVector(query), using: "lexical_v1" },
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
				serverHybridEnabled: true,
				vectorSchema: ready.then((result) => result.vectorSchema),
			});
			const fused = await store.hybridSearch({
				vector: [1, 0],
				query,
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
				query: sparseVector("违约金"),
				using: "lexical_v1",
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

for (const named of [false, true]) {
	test(
		`real Qdrant ${named ? "named" : "legacy unnamed"} dense without sparse falls back to bounded BM25`,
		integration,
		async () => {
			const client = new QdrantClient({ url, checkCompatibility: true });
			const collection = `unorag_sparse_legacy_${randomUUID().replaceAll("-", "")}`;
			try {
				await client.createCollection(collection, {
					vectors: named
						? { dense: { size: 2, distance: "Cosine" } }
						: { size: 2, distance: "Cosine" },
				});
				const ready = new QdrantCollectionManager(client, {
					collection,
					vectorSize: 2,
					distance: "Cosine",
					serverHybridEnabled: true,
				}).ensure();
				const { vectorSchema } = await ready;
				assert.equal(vectorSchema.sparseVectorName, null);
				const scope = createScope();
				const exact = record(scope, query);
				const writer = new QdrantIngestWriteStore(client, collection, {
					vectorSchema,
				});
				await writer.stage({ scope, records: [exact], vectors: [[1, 0]] });
				await writer.setVisibility(scope, "active");
				const store = new QdrantRetrievalStore(client, collection, ready, {
					serverHybridEnabled: true,
					vectorSchema: ready.then((result) => result.vectorSchema),
				});
				let corpusReads = 0;
				const listCorpus = store.listCorpus.bind(store);
				store.listCorpus = async (input) => {
					corpusReads += 1;
					assert.equal(input.limit, 3);
					return listCorpus(input);
				};
				const result = await service(store).retrieve({
					query,
					libraryId: scope.libraryId,
					scope: authorized(retrievalScope(scope)),
					topK: 1,
				});
				assert.equal(result.citations[0].id, exact._point_id);
				assert.equal(result.debug.usedHybrid, true);
				assert.equal(result.debug.hybridFailed, false);
				assert.equal(corpusReads, 1);
			} finally {
				if ((await client.collectionExists(collection)).exists)
					await client.deleteCollection(collection);
			}
		},
	);
}

test(
	"real Qdrant migrated unnamed dense plus sparse supports dual writes and query-switch rollback",
	integration,
	async () => {
		const client = new QdrantClient({ url, checkCompatibility: true });
		const collection = `unorag_sparse_migrated_${randomUUID().replaceAll("-", "")}`;
		try {
			await client.createCollection(collection, {
				vectors: { size: 2, distance: "Cosine" },
				sparse_vectors: { lexical_v1: {} },
			});
			const ready = new QdrantCollectionManager(client, {
				collection,
				vectorSize: 2,
				distance: "Cosine",
				serverHybridEnabled: false,
			}).ensure();
			const { vectorSchema } = await ready;
			assert.deepEqual(vectorSchema, {
				denseVectorName: null,
				sparseVectorName: "lexical_v1",
			});
			const scope = createScope();
			const exact = record(scope, query);
			const writer = new QdrantIngestWriteStore(client, collection, {
				vectorSchema,
			});
			await writer.stage({ scope, records: [exact], vectors: [[1, 0]] });
			await writer.setVisibility(scope, "active");
			for (const enabled of [true, false]) {
				const store = new QdrantRetrievalStore(client, collection, ready, {
					serverHybridEnabled: enabled,
					vectorSchema: ready.then((result) => result.vectorSchema),
				});
				const result = await service(store).retrieve({
					query,
					libraryId: scope.libraryId,
					scope: authorized(retrievalScope(scope)),
					topK: 1,
				});
				assert.equal(result.citations[0].id, exact._point_id);
				assert.equal(result.debug.usedHybrid, true);
				assert.equal(result.debug.hybridFailed, false);
			}
		} finally {
			if ((await client.collectionExists(collection)).exists)
				await client.deleteCollection(collection);
		}
	},
);
