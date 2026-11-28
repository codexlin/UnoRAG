import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import test, { type TestContext } from "node:test";
import type { LanguageModel } from "ai";
import { AnswerStreamAdapter } from "../../src/core/ai/answer-stream";
import { StructuredOutputAdapter } from "../../src/core/ai/structured-output";
import type { AuthorizedScope } from "../../src/core/contracts";
import type {
	ActiveGenerationResolver,
	QdrantSearchHit,
	RetrievalResult,
	RetrievalScope,
	RetrievalVectorStore,
} from "../../src/core/retrieval";
import { DefaultRetrievalService } from "../../src/core/retrieval/retrieval-service";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import type { AuthenticatedServiceKey } from "../../src/lib/server/service-keys";
import {
	type NativeAskPolicy,
	NativeAskPolicySchema,
} from "../../src/server/http/ask/policy";

type ResolveFilename = (
	request: string,
	parent?: unknown,
	isMain?: boolean,
	options?: unknown,
) => string;

const require = createRequire(import.meta.url);
const nodeModule = require("node:module") as {
	_resolveFilename: ResolveFilename;
};
const originalResolveFilename = nodeModule._resolveFilename.bind(nodeModule);
const inertServerOnlyModule = require.resolve("next/package.json");
nodeModule._resolveFilename = (request, parent, isMain, options) =>
	request === "server-only"
		? inertServerOnlyModule
		: originalResolveFilename(request, parent, isMain, options);

const protectedModules = Promise.all([
	import("../../src/server/http/ask/native-runtime"),
	import("../../src/server/retrieval/active-generation-resolver"),
	import("../../src/server/http/retrieval/service"),
	import("../../src/lib/server/integration-rag"),
]).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

const LIBRARY_ID = "library-a";
const GENERATION_ID = "generation-a";
const THRESHOLD = 0.65;
const identity: AuthIdentity = {
	tenantId: "tenant-a",
	workspaceId: "workspace-a",
	workspaceName: "Offline workspace",
	principalId: "user-a",
	groupIds: ["finance"],
	organizationRole: "member",
	role: "editor",
	email: "offline@example.test",
	displayName: "Offline",
	provider: "local",
	mustChangePassword: false,
};

type RetrieveInput = Parameters<DefaultRetrievalService["retrieve"]>[0];

function authorizedScope(caller: AuthIdentity): AuthorizedScope {
	return {
		organizationId: caller.tenantId,
		workspaceId: caller.workspaceId,
		principalIds: [caller.principalId],
		groupIds: caller.groupIds,
		libraryIds: [LIBRARY_ID],
		activeGenerationIds: [GENERATION_ID],
	};
}

function assertScope(scope: AuthorizedScope, caller: AuthIdentity) {
	assert.equal(scope.documentIds, undefined);
	assert.deepEqual(
		{ ...scope, documentIds: undefined },
		{ ...authorizedScope(caller), documentIds: undefined },
	);
}

function hit(id: string, score: number): QdrantSearchHit {
	return {
		id,
		score,
		payload: {
			library_id: LIBRARY_ID,
			doc_id: "document-a",
			document_version_id: "version-a",
			generation_id: GENERATION_ID,
			tenant_id: identity.tenantId,
			workspace_id: identity.workspaceId,
			acl_scope: "workspace",
			title: "Policy",
			record_type: "chunk",
			chunk_index: id === "strong" ? 0 : 1,
			text:
				id === "strong"
					? "The leave allowance is 20 days."
					: `Weak background ${id}.`,
		},
	};
}

function createRetrieval(
	t: TestContext,
	options: {
		caller?: AuthIdentity;
		firstQueryWeak?: boolean;
		table?: boolean;
	} = {},
) {
	const caller = options.caller ?? identity;
	const calls: RetrieveInput[] = [];
	const results: RetrievalResult[] = [];
	const vectors = new Map<number, QdrantSearchHit[]>();
	let embeddings = 0;
	let storeQueries = 0;
	const weak = Array.from({ length: 6 }, (_, index) =>
		hit(`weak-${index}`, 0.1),
	);
	const table = hit("table", 0.05);
	Object.assign(table.payload, {
		record_type: "table",
		table_id: "leave-table",
		headers: ["Name", "Days"],
		rows: [
			["Alice", "20"],
			["Bob", "15"],
		],
		row_start: 0,
		row_end: 1,
		table_row_count: 2,
		text: "Name | Days\nAlice | 20\nBob | 15",
	});
	const checkStoreScope = (scope: RetrievalScope) => {
		storeQueries += 1;
		assert.deepEqual(scope, {
			tenantId: caller.tenantId,
			workspaceId: caller.workspaceId,
			libraryId: LIBRARY_ID,
			principalIds: [caller.principalId],
			groupIds: caller.groupIds,
			activeGenerationIds: [GENERATION_ID],
		});
	};
	const store: RetrievalVectorStore = {
		async search({ vector, scope }) {
			checkStoreScope(scope);
			const hits = vectors.get(vector[0]);
			assert.ok(hits);
			return hits;
		},
		async hybridSearch({ vector, scope }) {
			checkStoreScope(scope);
			const hits = vectors.get(vector[0]);
			assert.ok(hits);
			// RRF puts all weak matches before the semantic answer.
			return [...hits].reverse().map((candidate, index) => ({
				...candidate,
				score: 0.03 - index / 1_000,
			}));
		},
		async listCorpus() {
			assert.fail("Unexpected corpus fallback");
		},
	};
	const service = new DefaultRetrievalService(
		{
			async embedQuery() {
				embeddings += 1;
				vectors.set(
					embeddings,
					options.table
						? [table]
						: options.firstQueryWeak && embeddings === 1
							? weak
							: [hit("strong", 0.9), ...weak],
				);
				return [embeddings, 0];
			},
			async embedTexts() {
				assert.fail("Unexpected document embedding");
			},
		},
		store,
		null,
		{
			hybridEnabled: true,
			rerankEnabled: false,
			rerankTopK: 6,
			bm25TopK: 20,
			rrfK: 60,
		},
	);
	const retrieve = service.retrieve.bind(service);
	t.mock.method(service, "retrieve", async (input: RetrieveInput) => {
		assertScope(input.scope, caller);
		calls.push(input);
		const result = await retrieve(input);
		results.push(result);
		return result;
	});
	return { service, calls, results, storeQueries: () => storeQueries };
}

async function setup(t: TestContext) {
	const modules = await protectedModules;
	t.mock.method(globalThis, "fetch", async () =>
		assert.fail("External fetch forbidden"),
	);
	t.mock.method(Socket.prototype, "connect", () =>
		assert.fail("External socket forbidden"),
	);
	t.mock.method(
		modules[1].DrizzleActiveGenerationResolver.prototype,
		"resolve",
		async (input: Parameters<ActiveGenerationResolver["resolve"]>[0]) => {
			assert.deepEqual(input, {
				organizationId: identity.tenantId,
				workspaceId: identity.workspaceId,
				libraryId: LIBRARY_ID,
			});
			return {
				libraryId: LIBRARY_ID,
				generationIds: [GENERATION_ID],
				resolvedAt: new Date(0),
			};
		},
	);
	return modules;
}

async function createRuntime(
	t: TestContext,
	options: {
		includeTraceDetails?: boolean;
		firstQueryWeak?: boolean;
		table?: boolean;
		policy?: Partial<NativeAskPolicy>;
	} = {},
) {
	const [{ createNativeAskRuntime }] = await setup(t);
	const retrieval = createRetrieval(t, options);
	const modelCalls: string[] = [];
	const runtime = createNativeAskRuntime({
		identity,
		libraryId: LIBRARY_ID,
		includeTraceDetails: options.includeTraceDetails,
		policy: NativeAskPolicySchema.parse({
			answer_min_score: 0.4,
			citation_adjudicate_absolute_floor: THRESHOLD,
			hybrid_enabled: true,
			rerank_enabled: false,
			rerank_retry_enabled: false,
			...options.policy,
		}),
		assertAuthorized: async (citations) => {
			for (const citation of citations) {
				assert.equal(citation.doc_id, "document-a");
				assert.equal(citation.generation_id, GENERATION_ID);
			}
		},
		dependencies: {
			retrieval: retrieval.service,
			loadDocumentCatalog: async ({ scope }) => {
				assertScope({ ...scope, documentIds: undefined }, identity);
				assert.deepEqual(scope.documentIds, ["document-a"]);
				return {
					complete: true,
					documents: [
						{
							documentId: "document-a",
							generationId: GENERATION_ID,
							filename: "policy.txt",
							context: null,
						},
					],
				};
			},
			structured: new StructuredOutputAdapter(
				{} as LanguageModel,
				async (request) => {
					modelCalls.push(request.schemaName);
					if (request.schemaName === "conflict")
						return {
							resolution: "consistent",
							comparison: "No conflicting evidence.",
							conflict_evidence: [],
						};
					assert.equal(request.schemaName, "judge");
					return {
						sufficient: true,
						action: "generate",
						reason: "Covered",
						evidence_ids: ["e1"],
					};
				},
			),
			answer: new AnswerStreamAdapter({} as LanguageModel, async function* () {
				assert.fail("Wiring tests must not invoke answer generation");
				yield "";
			}),
		},
	});
	return { runtime, ...retrieval, modelCalls };
}

for (const includeTraceDetails of [false, true]) {
	test(`ordinary NativeAskRuntime passes its effective threshold with trace=${includeTraceDetails}`, async (t) => {
		const threshold = includeTraceDetails ? 0.75 : THRESHOLD;
		const fixture = await createRuntime(t, {
			includeTraceDetails,
			policy: includeTraceDetails ? { answer_min_score: threshold } : {},
		});
		const state = await fixture.runtime.invoke({
			question: "Describe the leave policy.",
		});
		assert.equal(state.query_type, "fact");
		assert.equal(state.refused, false);
		assert.equal(state.retrieval_attempts, 1);
		assert.equal(fixture.calls.length, 1);
		assert.equal(fixture.calls[0].options?.minimumEvidenceScore, threshold);
		assert.equal(
			fixture.calls[0].options?.includeTraceDetails === true,
			includeTraceDetails,
		);
		assert.deepEqual(
			fixture.results[0].citations.map(({ id }) => id),
			["strong"],
		);
		assert.equal(fixture.storeQueries(), 2);
	});
}

test("NativeAskRuntime compare passes the threshold to its main and both target subqueries", async (t) => {
	const fixture = await createRuntime(t);
	const question =
		"\u5bf9\u6bd4\u7532\u65b9\u6848\u548c\u4e59\u65b9\u6848\u7684\u4e3b\u8981\u5dee\u5f02\u6709\u54ea\u4e9b\uff1f";
	const state = await fixture.runtime.invoke({ question });
	assert.equal(state.query_type, "compare");
	assert.equal(state.refused, false);
	assert.equal(fixture.calls.length, 3);
	assert.equal(fixture.calls[0].query, question);
	assert.equal(fixture.calls[0].topK, 20);
	assert.equal(fixture.calls[1].topK, 10);
	assert.equal(fixture.calls[2].topK, 10);
	assert.match(fixture.calls[1].query, /\u7532\u65b9\u6848/u);
	assert.match(fixture.calls[2].query, /\u4e59\u65b9\u6848/u);
	for (const call of fixture.calls)
		assert.equal(call.options?.minimumEvidenceScore, THRESHOLD);
	for (const result of fixture.results)
		assert.deepEqual(
			result.citations.map(({ id }) => id),
			["strong"],
		);
	assert.equal(fixture.storeQueries(), 6);
});

test("NativeAskRuntime keeps the threshold on the no-evidence retry and recovers a strong candidate", async (t) => {
	const fixture = await createRuntime(t, { firstQueryWeak: true });
	const state = await fixture.runtime.invoke({
		question: "Describe the leave policy.",
	});
	assert.equal(state.refused, false);
	assert.equal(state.retrieval_attempts, 2);
	assert.equal(fixture.calls.length, 2);
	assert.notEqual(fixture.calls[0].query, fixture.calls[1].query);
	assert.deepEqual(
		fixture.calls.map(({ topK }) => topK),
		[6, 12],
	);
	assert.deepEqual(
		fixture.calls.map(({ options }) => options?.minimumEvidenceScore),
		[THRESHOLD, THRESHOLD],
	);
	assert.deepEqual(
		fixture.results.map(({ citations }) => citations.map(({ id }) => id)),
		[[], ["strong"]],
	);
	assert.equal(fixture.modelCalls.filter((name) => name === "judge").length, 1);
	assert.equal(fixture.storeQueries(), 4);
});

test("NativeAskRuntime precise table retrieval has no minimumEvidenceScore and counts low-score rows", async (t) => {
	const fixture = await createRuntime(t, { table: true });
	const state = await fixture.runtime.invoke({
		question: "\u8868\u683c\u4e2d\u6709\u591a\u5c11\u884c\uff1f",
	});
	assert.equal(state.query_type, "table");
	assert.equal(state.refused, false);
	assert.equal(fixture.calls.length, 1);
	assert.equal(fixture.calls[0].filters?.record_type, "table");
	assert.equal(fixture.calls[0].topK, 30);
	assert.equal(fixture.calls[0].options?.minimumEvidenceScore, undefined);
	assert.equal(fixture.results[0].citations[0].dense_score, 0.05);
	assert.equal(state.table_execution?.status, "success");
	assert.equal(state.table_execution?.operation, "count");
	assert.equal(state.table_execution?.answerValue, 2);
	assert.deepEqual(fixture.modelCalls, []);
});

test("Public Retrieve v1 does not pass an Ask threshold and retains low-score RRF candidates", async (t) => {
	const [, , { executeNativeRetrieval }, { forwardIntegrationRag }] =
		await setup(t);
	const caller: AuthIdentity = {
		...identity,
		principalId: "service:key-a",
		groupIds: [],
		role: "service",
	};
	const fixture = createRetrieval(t, { caller });
	const key: AuthenticatedServiceKey = {
		id: "key-a",
		principalId: caller.principalId,
		organizationId: caller.tenantId,
		workspaceId: caller.workspaceId,
		name: "Offline service",
		prefix: "offline",
		scopes: ["retrieve"],
		libraryIds: [LIBRARY_ID],
		createdBy: null,
		revokedAt: null,
		lastUsedAt: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
	const response = await forwardIntegrationRag({
		request: new Request("http://offline/api/v1/retrieve", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				query: "Describe the leave policy.",
				library_id: LIBRARY_ID,
				top_k: 2,
			}),
		}),
		key,
		target: "/v1/retrieve",
		requestId: "offline-threshold-wiring",
		retrieveExecutor: (input) =>
			executeNativeRetrieval({
				...input,
				refreshIdentity: async () => input.identity,
				dependencies: {
					resolver: {
						async resolve() {
							return {
								libraryId: LIBRARY_ID,
								generationIds: [GENERATION_ID],
								resolvedAt: new Date(0),
							};
						},
					},
					retrieval: fixture.service,
				},
			}),
	});
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.api_version, "v1");
	assert.equal(body.refused, false);
	assert.equal(body.citations.length, 2);
	assert.equal(fixture.calls.length, 1);
	assert.equal(
		Object.hasOwn(fixture.calls[0].options ?? {}, "minimumEvidenceScore"),
		false,
	);
	assert.ok(
		fixture.results[0].citations.every(
			({ dense_score }) => dense_score === 0.1,
		),
	);
	assert.equal(fixture.storeQueries(), 2);
});

test("NativeAskRuntime.adjudicate preserves a reranked lineage-linked figure companion while rejecting sub-floor or unlinked figures", async (t) => {
	const [{ createNativeAskRuntime }] = await setup(t);
	const anchorHit = hit("fig4-chunk", 0.72);
	anchorHit.payload.source_node_ids = ["mineru:16"];
	const linkedFigure = hit("fig4-figure", 0.7);
	Object.assign(linkedFigure.payload, {
		record_type: "figure",
		figure_id: "figure-16",
		source_node_ids: ["mineru:16"],
		text: "图4：各部门信息化预算分配结构（单位：万元）",
	});
	const subFloorFigure = hit("fig2-figure", 0.7);
	Object.assign(subFloorFigure.payload, {
		record_type: "figure",
		figure_id: "figure-9",
		source_node_ids: ["mineru:16"],
		text: "图2：用户增长趋势",
	});
	const unlinkedFigure = hit("fig1-figure", 0.7);
	Object.assign(unlinkedFigure.payload, {
		record_type: "figure",
		figure_id: "figure-4",
		source_node_ids: ["mineru:4"],
		text: "图1：营收趋势",
	});
	const store: RetrievalVectorStore = {
		async search() {
			return [anchorHit, linkedFigure, subFloorFigure, unlinkedFigure];
		},
		async hybridSearch() {
			return [anchorHit, linkedFigure, subFloorFigure, unlinkedFigure].map(
				(candidate, index) => ({ ...candidate, score: 0.03 - index / 1_000 }),
			);
		},
		async listCorpus() {
			assert.fail("Unexpected corpus fallback");
		},
	};
	const service = new DefaultRetrievalService(
		{
			async embedQuery() {
				return [1, 0];
			},
			async embedTexts() {
				assert.fail("Unexpected document embedding");
			},
		},
		store,
		{
			async rerank() {
				return [
					{ index: 0, score: 0.995 },
					{ index: 1, score: 0.308 },
					{ index: 2, score: 0.117 },
					{ index: 3, score: 0.35 },
				];
			},
		},
		{
			hybridEnabled: true,
			rerankEnabled: true,
			rerankTopK: 6,
			bm25TopK: 20,
			rrfK: 60,
		},
	);
	let judgeUserPrompt = "";
	const runtime = createNativeAskRuntime({
		identity,
		libraryId: LIBRARY_ID,
		policy: NativeAskPolicySchema.parse({
			answer_min_score: 0.4,
			citation_adjudicate_absolute_floor: 0.35,
			hybrid_enabled: true,
			rerank_enabled: true,
		}),
		dependencies: {
			retrieval: service,
			structured: new StructuredOutputAdapter(
				{} as LanguageModel,
				async (request) => {
					if (request.schemaName === "conflict") {
						return {
							resolution: "consistent",
							comparison: "No conflicting evidence.",
							conflict_evidence: [],
						};
					}
					judgeUserPrompt = String(request.messages[0]?.content ?? "");
					return {
						sufficient: true,
						action: "generate",
						reason: "Covered",
						evidence_ids: ["e1"],
					};
				},
			),
			answer: new AnswerStreamAdapter({} as LanguageModel, async function* () {
				yield "";
			}),
		},
	});
	const state = await runtime.invoke({
		question: "图4中总预算最高的部门是哪个？",
	});
	assert.equal(state.refused, false);
	assert.equal(state.retrieval_debug?.retrieved_evidence_count, 2);
	assert.match(judgeUserPrompt, /图4：各部门信息化预算分配结构/);
	assert.doesNotMatch(judgeUserPrompt, /图2：用户增长趋势|图1：营收趋势/);
	assert.deepEqual(
		state.citations?.map((citation) => citation.id),
		["fig4-chunk", "fig4-figure"],
	);
	assert.equal(
		state.citations?.some((citation) => citation.record_type === "figure"),
		true,
	);
});
