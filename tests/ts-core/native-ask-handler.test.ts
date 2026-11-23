import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { APICallError, type LanguageModel } from "ai";

import {
	AiConcurrencyOverloadedError,
	AiConcurrencyWaitTimeoutError,
	AnswerStreamAdapter,
	StructuredOutputAdapter,
} from "../../src/core/ai";
import type { ModelUsageCall } from "../../src/core/ai/model-usage";
import type { AskGraphInput, AskState } from "../../src/core/ask-graph";
import { AskGraphExecutionError } from "../../src/core/ask-graph";
import { CLARIFICATION_TTL_MS } from "../../src/core/ask-graph/clarification";
import {
	DefaultRetrievalService,
	type InternalCitation,
	type RetrievalResult,
} from "../../src/core/retrieval";
import { RerankDiagnosticSchema } from "../../src/core/retrieval/provider-request";
import { QdrantOperationError } from "../../src/core/retrieval/qdrant/store";
import type { ApiAskResponse } from "../../src/lib/api";
import { runWithObservabilityContext } from "../../src/lib/observability/context";
import { logger } from "../../src/lib/observability/logger";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import { MemoryProvenanceSchema } from "../../src/server/conversations/memory-provenance";
import type { SessionMemoryMessage } from "../../src/server/conversations/session-memory";
import type {
	AppendConversationExchangeInput,
	AppendConversationTurnInput,
	ConversationScope,
	ConversationTurnStatus,
} from "../../src/server/conversations/types";
import { rewriteFollowup } from "../../src/server/http/ask/followup-rewrite";
import {
	AskRunsRepository,
	type FinalizeAskRunInput,
	type StartAskRunInput,
} from "../../src/server/observability/ask-runs-repository";
import {
	renderPrometheusMetrics,
	resetPrometheusMetricsForTests,
} from "../../src/server/observability/metrics";

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

// `server-only` is a framework marker with no behavior used by this unit.
nodeModule._resolveFilename = (request, parent, isMain, options) =>
	request === "server-only"
		? inertServerOnlyModule
		: originalResolveFilename(request, parent, isMain, options);

const handlerModule = import("../../src/server/http/ask/native-handler")
	.then((module) => ({
		...module,
		handleNativeAskRequest: (
			input: Parameters<typeof module.handleNativeAskRequest>[0],
		) =>
			module.handleNativeAskRequest({
				...input,
				authorization: input.authorization ?? {
					refreshIdentity: async () => identity,
					resolveLibrary: (async () => ({ id: LIBRARY_ID })) as never,
					citationAuthorizer: {
						filterAuthorized: async ({ citations }) => citations,
					},
				},
			}),
	}))
	.finally(() => {
		nodeModule._resolveFilename = originalResolveFilename;
	});

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL_ID = "33333333-3333-4333-8333-333333333333";
const THREAD_ID = "44444444-4444-4444-8444-444444444444";
const FOREIGN_THREAD_ID = "55555555-5555-4555-8555-555555555555";
const LIBRARY_ID = "library-1";

const identity: AuthIdentity = {
	tenantId: ORGANIZATION_ID,
	workspaceId: WORKSPACE_ID,
	workspaceName: "Workspace",
	principalId: PRINCIPAL_ID,
	groupIds: ["group-1"],
	organizationRole: "member",
	role: "viewer",
	email: "viewer@example.com",
	displayName: "Viewer",
	provider: "local",
	mustChangePassword: false,
};

type StoredThread = {
	id: string;
	organizationId: string;
	workspaceId: string;
	principalId: string;
	status: "active" | "hidden";
	ragLibraryId: string | null;
	turns: Array<
		AppendConversationTurnInput & { status: ConversationTurnStatus }
	>;
};

class FakeConversationRepository {
	readonly exchanges: Array<{
		scope: ConversationScope;
		threadId: string;
		input: AppendConversationExchangeInput;
	}> = [];
	readonly debugUpdates: Array<{
		turnId: string;
		debug: Record<string, unknown>;
	}> = [];
	readonly boundaries: Array<{
		scope: ConversationScope;
		threadId: string;
		input: AppendConversationTurnInput;
	}> = [];
	private readonly records: Array<{
		id: string;
		threadId: string;
		turn: AppendConversationTurnInput;
	}> = [];

	constructor(private readonly threads: StoredThread[] = []) {}

	async getThread(scope: ConversationScope, threadId: string) {
		const thread = this.threads.find(
			(thread) =>
				thread.id === threadId &&
				thread.organizationId === scope.organizationId &&
				thread.workspaceId === scope.workspaceId &&
				thread.principalId === scope.principalId,
		);
		return thread
			? {
					...thread,
					turns: [
						...thread.turns,
						...this.records
							.filter((record) => record.threadId === threadId)
							.map(({ id, turn }) => ({
								...turn,
								id,
								status: turn.status ?? ("complete" as const),
							})),
					],
				}
			: null;
	}

	async appendTurn(
		scope: ConversationScope,
		threadId: string,
		input: AppendConversationTurnInput,
	) {
		assert.ok(await this.getThread(scope, threadId));
		this.boundaries.push({ scope, threadId, input });
		const id = `boundary-${this.boundaries.length}`;
		this.records.push({ id, threadId, turn: input });
		return { id };
	}

	async appendExchange(
		scope: ConversationScope,
		threadId: string,
		input: AppendConversationExchangeInput,
	) {
		const thread = await this.getThread(scope, threadId);
		if (thread?.status !== "active") {
			throw new Error("thread not found");
		}
		this.exchanges.push({ scope, threadId, input });
		return [input.user, input.assistant].map((turn) => {
			const id = `${turn.role}-${this.exchanges.length}`;
			this.records.push({ id, threadId, turn });
			return { id, role: turn.role };
		}) as never;
	}

	async updateTurnDebug(
		_scope: ConversationScope,
		_threadId: string,
		turnId: string,
		debug: Record<string, unknown>,
	) {
		this.debugUpdates.push({ turnId, debug });
		const record = this.records.find((record) => record.id === turnId);
		if (record) record.turn.debug = debug;
		return { id: turnId };
	}
}

class FailingConversationRepository extends FakeConversationRepository {
	async appendExchange(): Promise<never> {
		throw new Error("private persistence failure");
	}
}

class FakeSessionMemory {
	readonly appended: Array<{
		scope: ConversationScope;
		sessionId: string;
		messages: Array<{ role: "user" | "assistant"; content: string }>;
		maxTurns: number;
	}> = [];

	async load() {
		return [
			{ role: "user" as const, content: "临时上一问" },
			{ role: "assistant" as const, content: "临时上一答" },
		];
	}

	async append(
		scope: ConversationScope,
		sessionId: string,
		messages: Array<{ role: "user" | "assistant"; content: string }>,
		maxTurns: number,
	) {
		this.appended.push({ scope, sessionId, messages, maxTurns });
	}
}

class FakeRuntime {
	readonly invocations: AskGraphInput[] = [];

	constructor(
		private readonly state: AskState,
		private readonly tokens: string[] = [],
		private readonly invokeError?: Error,
	) {}

	async invoke(input: AskGraphInput): Promise<AskState> {
		this.invocations.push(input);
		if (this.invokeError) throw this.invokeError;
		return this.state;
	}

	async *streamAnswer(): AsyncGenerator<string> {
		for (const token of this.tokens) yield token;
	}
}

function activeThread(overrides: Partial<StoredThread> = {}): StoredThread {
	return {
		id: THREAD_ID,
		organizationId: ORGANIZATION_ID,
		workspaceId: WORKSPACE_ID,
		principalId: PRINCIPAL_ID,
		status: "active",
		ragLibraryId: LIBRARY_ID,
		turns: [],
		...overrides,
	};
}

function askState(overrides: Partial<AskState> = {}): AskState {
	return {
		session_id: "session-1",
		question: "违约金是多少？",
		library_id: LIBRARY_ID,
		history: [],
		rewritten_question: undefined,
		citations: [
			{
				id: "citation-1",
				index: 1,
				doc_id: "document-1",
				document_version_id: "version-1",
				generation_id: "generation-1",
				title: "合同",
				snippet: "违约金为 200 元",
				score: 0.98,
			},
		],
		answer: undefined,
		refused: false,
		refuse_reason: null,
		retrieval_attempts: 1,
		judgement: undefined,
		trace_id: "trace-1",
		query_type: "fact",
		route_reason: "direct fact lookup",
		retrieval_plan: undefined,
		table_query_plan: undefined,
		table_execution: undefined,
		upgrade: null,
		upgrade_reason: null,
		downgrade_reason: null,
		retrieval_debug: {
			retrievalMode: "hybrid",
			hybridFailed: false,
			rerankFailed: false,
		},
		...overrides,
	};
}

function request(
	body: Record<string, unknown>,
	path: "sync" | "stream" = "sync",
): Request {
	return new Request(
		`http://local/v1/ask${path === "stream" ? "/stream" : ""}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
}

function repositoryInput(repository: FakeConversationRepository) {
	return repository as never;
}

function runtimeFactory(runtime: FakeRuntime) {
	return (() => runtime) as never;
}

function askRunRecorder() {
	const starts: StartAskRunInput[] = [];
	const finalizations: FinalizeAskRunInput[] = [];
	const repository = new AskRunsRepository({
		async start(input) {
			starts.push(input);
			return { id: "77777777-7777-4777-8777-777777777777" } as never;
		},
		async finalize(input) {
			finalizations.push(input);
			return { id: input.id, status: input.status } as never;
		},
		async deleteExpired() {
			return 0;
		},
	});
	return { repository, starts, finalizations };
}

for (const [role, include, expected, serviceKey] of [
	["admin", true, true, false],
	["editor", true, true, false],
	["owner", true, true, false],
	["admin", undefined, false, false],
	["editor", false, false, false],
	["viewer", true, false, false],
	["admin", true, false, true],
] as const) {
	test(`trace opt-in and scope for ${role}, include=${include}, service key=${serviceKey}`, async () => {
		const { handleNativeAskRequest } = await handlerModule;
		const caller = { ...identity, role };
		const runtime = new FakeRuntime(askState(), ["Answer [1]"]);
		let inspectionReads = 0;
		Object.assign(runtime, {
			getRetrievalInspections() {
				inspectionReads += 1;
				return [];
			},
		});
		const response = await handleNativeAskRequest({
			request: request({
				question: "Question",
				library_id: LIBRARY_ID,
				include_trace_details: include,
			}),
			path: ["v1", "ask"],
			identity: caller,
			repository: repositoryInput(new FakeConversationRepository()),
			...(serviceKey
				? { askRunPrincipal: { type: "service_key", id: "key" } }
				: {}),
			authorization: {
				refreshIdentity: async () => caller,
				resolveLibrary: (async () => ({ id: LIBRARY_ID })) as never,
				citationAuthorizer: {
					filterAuthorized: async ({ citations }) => citations,
				},
			},
			runtimeFactory: (input) => {
				assert.equal(input.includeTraceDetails, expected);
				return runtime as never;
			},
		});
		assert.equal(response?.status, 200);
		const body = await response?.json();
		assert.equal("retrieval_inspection" in body, expected);
		assert.equal("judge_summary" in body, expected);
		assert.equal("rewritten_question" in body, false);
		assert.equal(inspectionReads, expected ? 1 : 0);
	});
}

for (const [mode, revokeDropped] of [
	["sync", false],
	["stream", false],
	["stream", true],
] as const) {
	test(`${mode} ${revokeDropped ? "omits inspection after a dropped candidate loses access" : "sends live-only inspection for each main, subquery and retry call"}`, async (context) => {
		const { handleNativeAskRequest } = await handlerModule;
		const { createNativeAskRuntime } = await import(
			"../../src/server/http/ask/native-runtime"
		);
		const { DrizzleActiveGenerationResolver } = await import(
			"../../src/server/retrieval/active-generation-resolver"
		);
		context.mock.method(
			DrizzleActiveGenerationResolver.prototype,
			"resolve",
			async () => ({
				libraryId: LIBRARY_ID,
				generationIds: ["generation-1"],
				resolvedAt: new Date(),
			}),
		);
		const caller = { ...identity, role: "editor" };
		const runs = askRunRecorder();
		const repository = new FakeConversationRepository([activeThread()]);
		const memory = new FakeSessionMemory();
		const queries: string[] = [];
		const coarseMarker = "Private coarse preview only";
		const question = "采购合同在付款时有哪些要求，以及逾期时有哪些责任？";
		const service = new DefaultRetrievalService(
			{
				async embedQuery(query) {
					queries.push(query);
					return [queries.length];
				},
				async embedTexts() {
					throw new Error("Unexpected embedTexts");
				},
			},
			{
				async search({ vector, scope }) {
					assert.deepEqual(scope.activeGenerationIds, ["generation-1"]);
					const call = vector[0];
					return Array.from({ length: 13 }, (_, index) => ({
						id: `call-${call}-${index}`,
						score: call > 3 && index === 0 ? 0.85 : 0.1,
						payload: {
							doc_id: `document-${index}`,
							document_version_id: `version-${index}`,
							generation_id: "generation-1",
							library_id: LIBRARY_ID,
							tenant_id: ORGANIZATION_ID,
							workspace_id: WORKSPACE_ID,
							acl_scope: "workspace" as const,
							title: "Test contract",
							text:
								index === 0 && call > 3
									? "Payment is due in 30 days."
									: coarseMarker,
							record_type: "chunk" as const,
							chunk_index: index,
						},
					}));
				},
				async listCorpus() {
					return [];
				},
			},
			null,
			{
				hybridEnabled: false,
				rerankEnabled: false,
				rerankTopK: 20,
				bm25TopK: 20,
				rrfK: 60,
			},
		);
		const model = {} as LanguageModel;
		const response = await handleNativeAskRequest({
			request: request(
				{
					question,
					library_id: LIBRARY_ID,
					include_trace_details: true,
					...(mode === "sync" ? { thread_id: THREAD_ID } : {}),
				},
				mode,
			),
			path: mode === "stream" ? ["v1", "ask", "stream"] : ["v1", "ask"],
			identity: caller,
			repository: repositoryInput(repository),
			memoryStore: memory as never,
			askRunsRepository: runs.repository,
			resolveLibrary: async () => ({ id: "db-library" }),
			authorization: {
				refreshIdentity: async () => caller,
				resolveLibrary: (async () => ({ id: LIBRARY_ID })) as never,
				citationAuthorizer: {
					filterAuthorized: async ({ citations }) =>
						revokeDropped
							? citations.filter(({ doc_id }) => doc_id !== "document-12")
							: citations,
				},
			},
			runtimeFactory: (input) =>
				createNativeAskRuntime({
					...input,
					dependencies: {
						retrieval: service,
						structured: new StructuredOutputAdapter(model, async (request) => {
							if (request.schemaName === "conflict") {
								return {
									resolution: "consistent",
									comparison: "The sources agree.",
									conflict_evidence: [],
								};
							}
							assert.equal(request.schemaName, "judge");
							return {
								action: "generate",
								reason: "covered",
								sufficient: true,
								evidence_ids: ["e1"],
							};
						}),
						answer: new AnswerStreamAdapter(model, async function* () {
							yield "Payment is due in 30 days. [source:1]";
						}),
					},
				}),
		});
		assert.ok(response);
		assert.equal(response.status, 200);
		assert.match(response.headers.get("cache-control") ?? "", /no-store/);
		let body: ApiAskResponse;
		if (mode === "stream") {
			const frames = parseSse(await response.text());
			assert.equal(frames.at(-1)?.event, "done");
			assert.doesNotMatch(
				JSON.stringify(frames.slice(0, -1)),
				/retrieval_inspection|rewritten_question|Private coarse preview/,
			);
			body = frames.at(-1)?.data as ApiAskResponse;
		} else {
			body = await response.json();
		}
		assert.equal(
			body.refused,
			false,
			JSON.stringify({
				reason: body.refuse_reason,
				queries,
				debug: body.retrieval_debug,
			}),
		);
		assert.equal(queries.length, 6);
		assert.equal(runs.finalizations[0]?.status, "completed");
		if (revokeDropped) {
			assert.equal("retrieval_inspection" in body, false);
			assert.equal("rewritten_question" in body, false);
			assert.equal("judge_summary" in body, false);
			return;
		}
		assert.deepEqual(
			body.retrieval_inspection?.map(({ query }) => query),
			queries,
		);
		assert.equal(body.rewritten_question, queries[3]);
		assert.notEqual(body.rewritten_question, question);
		assert.equal(
			body.retrieval_inspection?.[0].candidates[0].outcome,
			"below_threshold",
		);
		assert.equal(
			body.retrieval_inspection?.[0].candidates[0].preview,
			coarseMarker,
		);
		assert.equal(body.retrieval_inspection?.[0].candidates[0].final_rank, null);
		assert.equal(body.retrieval_inspection?.[3].candidates[0].final_rank, 1);
		assert.deepEqual(body.judge_summary, {
			mode: "model",
			sufficient: true,
			verdict: "generate",
			conflict_status: "consistent",
			citation_validation: "passed",
		});
		assert.equal(
			mode === "sync" ? repository.exchanges.length : memory.appended.length,
			1,
		);
		if (mode === "sync") assert.equal(repository.debugUpdates.length, 1);
		const durable = JSON.stringify([
			runs.starts,
			runs.finalizations,
			repository.exchanges,
			repository.debugUpdates,
			memory.appended,
		]);
		assert.doesNotMatch(
			durable,
			/inspection|rewritten_question|rewritten_queries|retrieval_query|Private coarse preview only/,
		);
		assert.equal(
			durable.includes(JSON.stringify(body.rewritten_question)),
			false,
		);
	});
}

const judgeUsage: ModelUsageCall = {
	stage: "judge",
	model: "judge-test",
	provider: "test",
	attempt: 1,
	status: "completed",
	inputTokens: 100,
	outputTokens: 20,
	totalTokens: 120,
	cachedInputTokens: 40,
	usageStatus: "reported",
};

for (const mode of ["sync", "stream"] as const) {
	for (const anchor of [1, 2]) {
		test(`${mode} final evidence keeps the selected figure bundle when source ${anchor} is referenced`, async () => {
			const { handleNativeAskRequest } = await handlerModule;
			const repository = new FakeConversationRepository([activeThread()]);
			const runs = askRunRecorder();
			const base = askState().citations?.[0];
			assert.ok(base);
			const passage = {
				...base,
				id: "passage",
				record_type: "chunk",
				record_id: "chunk-1",
				source_node_ids: ["node-1"],
			};
			const figure = {
				...base,
				id: "figure",
				record_type: "figure",
				record_id: "figure-1",
				source_node_ids: ["node-1"],
			};
			const unrelated = {
				...figure,
				id: "foreign-figure",
				doc_id: "another-project",
			};
			const state = askState({ citations: [passage, figure, unrelated] });
			const response = await handleNativeAskRequest({
				request: request(
					{
						question: "图4中的比例？",
						library_id: LIBRARY_ID,
						thread_id: THREAD_ID,
					},
					mode,
				),
				path: mode === "stream" ? ["v1", "ask", "stream"] : ["v1", "ask"],
				identity,
				repository: repositoryInput(repository),
				askRunsRepository: runs.repository,
				resolveLibrary: async () => ({
					id: "99999999-9999-4999-8999-999999999999",
				}),
				runtimeFactory: runtimeFactory(
					new FakeRuntime(state, [`比例是54.5% [${anchor}]。`]),
				),
			});
			assert.ok(response);
			const frames = mode === "stream" ? parseSse(await response.text()) : null;
			const body = (frames ? frames.at(-1)?.data : await response.json()) as {
				citations: Array<{ id: string; index: number }>;
			};
			assert.deepEqual(
				body.citations.map(({ id, index }) => ({ id, index })),
				[
					{ id: "passage", index: 1 },
					{ id: "figure", index: 2 },
				],
			);
			assert.deepEqual(
				repository.exchanges[0]?.input.assistant.citations,
				body.citations,
			);
			assert.equal(runs.finalizations[0]?.citationCount, 2);
		});
	}

	for (const queryType of [
		"fact",
		"follow_up",
		"compare",
		"summary",
	] as const) {
		test(`${mode} ${queryType} final citations preserve joint context only where required without weakening authorization or memory dependencies`, async () => {
			const { handleNativeAskRequest } = await handlerModule;
			const repository = new FakeConversationRepository([activeThread()]);
			const runs = askRunRecorder();
			const base = askState().citations?.[0];
			assert.ok(base);
			const candidates = [1, 2, 3].map((index) => ({
				...base,
				id: `source-${index}`,
				index,
				doc_id: `doc-${index}`,
				document_version_id: `version-${index}`,
				generation_id: `generation-${index}`,
			}));
			const dependencies = [
				...candidates,
				{
					...base,
					id: "auth-only-dependency",
					doc_id: "doc-4",
					document_version_id: "version-4",
					generation_id: "generation-4",
				},
			];
			const state = askState({
				query_type: queryType,
				citations: candidates,
				retrieval_debug: { selected_evidence_count: 3 },
			});
			const authorized: string[][] = [];
			const response = await handleNativeAskRequest({
				request: request(
					{
						question: "Which project?",
						library_id: LIBRARY_ID,
						thread_id: THREAD_ID,
					},
					mode,
				),
				path: mode === "stream" ? ["v1", "ask", "stream"] : ["v1", "ask"],
				identity,
				repository: repositoryInput(repository),
				askRunsRepository: runs.repository,
				resolveLibrary: async () => ({
					id: "99999999-9999-4999-8999-999999999999",
				}),
				authorization: {
					refreshIdentity: async () => identity,
					resolveLibrary: (async () => ({ id: LIBRARY_ID })) as never,
					citationAuthorizer: {
						filterAuthorized: async ({ citations }) => {
							authorized.push(
								citations.map((citation) => String(citation.doc_id)),
							);
							return citations;
						},
					},
				},
				runtimeFactory: (() => ({
					invoke: async () => state,
					getEvidenceReferences: () => dependencies,
					async *streamAnswer() {
						yield "Answer [3].";
					},
				})) as never,
			});
			assert.ok(response);
			assert.equal(response.status, 200);
			const frames = mode === "stream" ? parseSse(await response.text()) : null;
			const body = (frames ? frames.at(-1)?.data : await response.json()) as {
				answer: string;
				persisted: boolean;
				citations: Array<{ id: string; index: number }>;
			};
			const preserveJointContext =
				queryType === "compare" || queryType === "summary";
			const expected = (
				preserveJointContext ? candidates : candidates.slice(2)
			).map(({ id, index }) => ({ id, index }));
			assert.equal(body.answer, "Answer [3].");
			assert.equal(body.persisted, true);
			assert.deepEqual(
				body.citations.map(({ id, index }) => ({ id, index })),
				expected,
			);
			if (frames) {
				assert.equal(frames.at(-1)?.event, "done");
				const early = frames.find((frame) => frame.event === "citations")?.data;
				assert.ok(Array.isArray(early));
				assert.deepEqual(
					early.map(({ id, index }) => ({ id, index })),
					candidates.map(({ id, index }) => ({ id, index })),
				);
			}
			assert.equal(runs.finalizations.length, 1);
			assert.equal(runs.finalizations[0]?.status, "completed");
			assert.equal(runs.finalizations[0]?.queryType, queryType);
			assert.equal(runs.finalizations[0]?.citationCount, expected.length);
			assert.equal(state.retrieval_debug?.selected_evidence_count, 3);
			assert.deepEqual(
				state.citations?.map(({ id, index }) => ({ id, index })),
				expected,
			);
			const saved = repository.exchanges[0]?.input.assistant;
			assert.equal(repository.exchanges.length, 1);
			assert.deepEqual(saved?.citations, body.citations);
			const provenance = MemoryProvenanceSchema.parse(
				saved?.debug?.memory_provenance,
			);
			assert.deepEqual(
				provenance.sourceReferences.map((source) => source.doc_id).sort(),
				["doc-1", "doc-2", "doc-3", "doc-4"],
			);
			assert.ok(
				authorized.some(
					(docs) =>
						docs.includes("doc-1") &&
						docs.includes("doc-2") &&
						docs.includes("doc-3") &&
						docs.includes("doc-4"),
				),
			);
			const { authorizeHistory } = await import(
				"../../src/server/http/ask/authorized-history"
			);
			const history = await authorizeHistory({
				identity,
				libraryId: LIBRARY_ID,
				citationAuthorizer: {
					filterAuthorized: async ({ citations }) =>
						citations.filter((citation) => citation.doc_id !== "doc-4"),
				},
				messages: [
					{ role: "user", content: "Question", provenance },
					{ role: "assistant", content: "Answer [3].", provenance },
				],
			});
			assert.deepEqual(history.messages, []);
		});
	}

	for (const kind of ["table", "outline"] as const) {
		test(`${mode} deterministic ${kind} sources and literal numeric brackets remain intact`, async () => {
			const { handleNativeAskRequest } = await handlerModule;
			const state = askState(
				kind === "table"
					? { table_execution: { operation: "filter" } }
					: { judgement: { judge_mode: "deterministic_document_outline" } },
			);
			const response = await handleNativeAskRequest({
				request: request({ question: "Rows?", library_id: LIBRARY_ID }, mode),
				path: mode === "stream" ? ["v1", "ask", "stream"] : ["v1", "ask"],
				identity,
				repository: repositoryInput(new FakeConversationRepository()),
				runtimeFactory: runtimeFactory(
					new FakeRuntime(state, ["item[2026] [1,2] row value."]),
				),
			});
			assert.ok(response);
			const body = (
				mode === "stream"
					? parseSse(await response.text()).at(-1)?.data
					: await response.json()
			) as { answer: string; citations: unknown[] };
			assert.equal(body.answer, "item[2026] [1,2] row value.");
			assert.equal(body.citations.length, 1);
		});
	}

	test(`${mode} model usage is shared by response, archive and operational ledger`, async () => {
		const { handleNativeAskRequest } = await handlerModule;
		const repository = new FakeConversationRepository([activeThread()]);
		const runs = askRunRecorder();
		const response = await handleNativeAskRequest({
			request: request(
				{
					question: "private question",
					library_id: LIBRARY_ID,
					thread_id: THREAD_ID,
				},
				mode,
			),
			path: mode === "stream" ? ["v1", "ask", "stream"] : ["v1", "ask"],
			identity,
			repository: repositoryInput(repository),
			askRunsRepository: runs.repository,
			resolveLibrary: async () => ({
				id: "99999999-9999-4999-8999-999999999999",
			}),
			runtimeFactory: (input) =>
				({
					async invoke() {
						input.usageRecorder?.({
							...judgeUsage,
							attempt: 1,
							status: "failed",
						});
						input.usageRecorder?.({ ...judgeUsage, attempt: 2 });
						return askState();
					},
					async *streamAnswer() {
						yield "private answer";
						input.usageRecorder?.({
							...judgeUsage,
							stage: "generate",
							inputTokens: 200,
							outputTokens: 30,
							totalTokens: 230,
						});
					},
				}) as never,
		});
		assert.ok(response);
		const body =
			mode === "sync"
				? await response.json()
				: parseSse(await response.text()).at(-1)?.data;
		const usage = (body as { retrieval_debug: { model_usage: unknown } })
			.retrieval_debug.model_usage;
		assert.deepEqual(usage, runs.finalizations[0]?.modelUsage);
		const summary = runs.finalizations[0]?.modelUsage;
		assert.equal(summary?.status, "reported");
		assert.equal(summary?.calls.length, 3);
		assert.equal(summary?.totalTokens, 470);
		assert.equal(summary?.cachedInputTokens, 120);
		const archived = repository.debugUpdates.at(-1)?.debug as
			| { retrieval_debug?: { model_usage?: unknown } }
			| undefined;
		// Both the initial conversation write and the timing update retain usage.
		assert.deepEqual(
			(
				repository.exchanges[0].input.assistant.debug as {
					retrieval_debug: { model_usage: unknown };
				}
			).retrieval_debug.model_usage,
			usage,
		);
		assert.doesNotMatch(
			JSON.stringify(usage),
			/private question|private answer/,
		);
		assert.deepEqual(archived?.retrieval_debug?.model_usage, usage);
	});
}

test("refusal retains Judge usage without inventing a generation call", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const runs = askRunRecorder();
	const response = await handleNativeAskRequest({
		request: request({ question: "private question", library_id: LIBRARY_ID }),
		path: ["v1", "ask"],
		identity,
		repository: repositoryInput(new FakeConversationRepository()),
		askRunsRepository: runs.repository,
		resolveLibrary: async () => ({
			id: "99999999-9999-4999-8999-999999999999",
		}),
		runtimeFactory: (input) =>
			({
				async invoke() {
					input.usageRecorder?.(judgeUsage);
					return askState({
						refused: true,
						refuse_reason: "insufficient_evidence",
						answer: "资料不足",
					});
				},
				async streamAnswer() {
					throw new Error("must not generate");
				},
			}) as never,
	});
	assert.equal(response?.status, 200);
	assert.equal(runs.finalizations[0]?.status, "refused");
	assert.deepEqual(
		runs.finalizations[0]?.modelUsage?.calls.map((call) => call.stage),
		["judge"],
	);
	assert.equal(runs.finalizations[0]?.modelUsage?.totalTokens, 120);
});

test("graph failures retain already incurred model usage even without a graph snapshot", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const runs = askRunRecorder();
	const response = await handleNativeAskRequest({
		request: request({ question: "private question", library_id: LIBRARY_ID }),
		path: ["v1", "ask"],
		identity,
		repository: repositoryInput(new FakeConversationRepository()),
		askRunsRepository: runs.repository,
		resolveLibrary: async () => ({
			id: "99999999-9999-4999-8999-999999999999",
		}),
		runtimeFactory: (input) =>
			({
				async invoke() {
					input.usageRecorder?.(judgeUsage);
					throw new Error("private failure");
				},
			}) as never,
	});
	assert.equal(response?.status, 503);
	assert.equal(runs.finalizations[0]?.modelUsage?.totalTokens, 120);
	assert.equal(runs.finalizations[0]?.status, "failed");
	assert.doesNotMatch(JSON.stringify(runs.finalizations), /private/);
});

test("client cancellation snapshots an in-flight model as unknown, never zero or unused", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const runs = askRunRecorder();
	const response = await handleNativeAskRequest({
		request: request(
			{ question: "private question", library_id: LIBRARY_ID },
			"stream",
		),
		path: ["v1", "ask", "stream"],
		identity,
		repository: repositoryInput(new FakeConversationRepository()),
		askRunsRepository: runs.repository,
		resolveLibrary: async () => ({
			id: "99999999-9999-4999-8999-999999999999",
		}),
		runtimeFactory: (input) =>
			({
				async invoke() {
					return askState();
				},
				async *streamAnswer() {
					input.usageRecorder?.start?.({
						stage: "generate",
						model: "test",
						provider: "test",
						attempt: 1,
					});
					yield "first token";
					if (!input.signal?.aborted)
						await new Promise<void>((resolve) =>
							input.signal?.addEventListener("abort", () => resolve(), {
								once: true,
							}),
						);
				},
			}) as never,
	});
	const reader = response?.body?.getReader();
	assert.ok(reader);
	const decoder = new TextDecoder();
	while (true) {
		const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
		assert.equal(chunk.done, false);
		if (decoder.decode(chunk.value).includes("event: token")) break;
	}
	await reader.cancel();
	assert.equal(runs.finalizations.length, 1);
	assert.equal(runs.finalizations[0]?.status, "cancelled");
	assert.equal(runs.finalizations[0]?.modelUsage?.status, "unavailable");
	assert.equal(runs.finalizations[0]?.modelUsage?.totalTokens, null);
	assert.equal(
		runs.finalizations[0]?.modelUsage?.calls[0]?.status,
		"cancelled",
	);
});

function parseSse(text: string): Array<{ event: string; data: unknown }> {
	return text
		.trim()
		.split("\n\n")
		.map((frame) => {
			const [eventLine, dataLine] = frame.split("\n");
			return {
				event: eventLine?.replace("event: ", "") ?? "",
				data: JSON.parse(dataLine?.replace("data: ", "") ?? "null"),
			};
		});
}

test("unrelated path returns null without invoking dependencies", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const repository = new FakeConversationRepository();
	const runtime = new FakeRuntime(askState());
	const response = await handleNativeAskRequest({
		request: request({ question: "问题", library_id: LIBRARY_ID }),
		path: ["v1", "retrieve"],
		identity,
		repository: repositoryInput(repository),
		runtimeFactory: runtimeFactory(runtime),
	});

	assert.equal(response, null);
	assert.equal(runtime.invocations.length, 0);
	assert.equal(repository.exchanges.length, 0);
});

test("invalid native ask payload returns 400", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const repository = new FakeConversationRepository();
	const runtime = new FakeRuntime(askState());

	for (const body of [
		{ library_id: LIBRARY_ID },
		{ question: "", library_id: LIBRARY_ID },
		{ question: "问题", library_id: LIBRARY_ID, tenant_id: ORGANIZATION_ID },
	]) {
		const response = await handleNativeAskRequest({
			request: request(body),
			path: ["v1", "ask"],
			identity,
			repository: repositoryInput(repository),
			runtimeFactory: runtimeFactory(runtime),
		});
		assert.equal(response?.status, 400);
		assert.deepEqual(await response?.json(), {
			detail: "invalid ask request",
		});
	}
	assert.equal(runtime.invocations.length, 0);
});

test("foreign, hidden, or wrong-library thread returns 404", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const cases = [
		activeThread({
			id: FOREIGN_THREAD_ID,
			workspaceId: "66666666-6666-4666-8666-666666666666",
		}),
		activeThread({ id: FOREIGN_THREAD_ID, status: "hidden" }),
		activeThread({ id: FOREIGN_THREAD_ID, ragLibraryId: "library-2" }),
	];

	for (const thread of cases) {
		const runtime = new FakeRuntime(askState());
		const response = await handleNativeAskRequest({
			request: request({
				question: "问题",
				library_id: LIBRARY_ID,
				thread_id: FOREIGN_THREAD_ID,
			}),
			path: ["v1", "ask"],
			identity,
			repository: repositoryInput(new FakeConversationRepository([thread])),
			runtimeFactory: runtimeFactory(runtime),
		});

		assert.equal(response?.status, 404);
		assert.deepEqual(await response?.json(), { detail: "thread not found" });
		assert.equal(runtime.invocations.length, 0);
	}
});

test("library outside the authorized retrieval scope returns 404", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const { NativeAskRequestError } = await import(
		"../../src/server/http/ask/native-runtime"
	);
	const response = await handleNativeAskRequest({
		request: request({ question: "问题", library_id: LIBRARY_ID }),
		path: ["v1", "ask"],
		identity,
		repository: repositoryInput(new FakeConversationRepository()),
		runtimeFactory: (() => {
			throw new NativeAskRequestError(404, "library not found");
		}) as never,
	});

	assert.equal(response?.status, 404);
	assert.deepEqual(await response?.json(), { detail: "library not found" });
});

test("sync ask returns public response and atomically appends the exchange", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const repository = new FakeConversationRepository([
		activeThread({
			turns: [
				{ role: "user", status: "complete", content: "上一问" },
				{ role: "assistant", status: "complete", content: "上一答" },
				{ role: "assistant", status: "failed", content: "失败内容" },
				{ role: "tool", status: "complete", content: "工具内容" },
			],
		}),
	]);
	const runtime = new FakeRuntime(
		askState({
			judgement: {
				sufficient: true,
				action: "generate",
				reason: "evidence_conflict",
				conflict_evidence: [
					{ evidence_id: "citation-1", quote: "private-conflict-excerpt" },
				],
			},
		}),
		["违约金", "为 200 元"],
	);

	const response = await handleNativeAskRequest({
		request: request({
			question: "违约金是多少？",
			library_id: LIBRARY_ID,
			session_id: "session-request",
			thread_id: THREAD_ID,
		}),
		path: ["v1", "ask"],
		identity,
		repository: repositoryInput(repository),
		runtimeFactory: runtimeFactory(runtime),
	});

	assert.equal(response?.status, 200);
	const body = (await response?.json()) as Record<string, unknown>;
	assert.equal(body.answer, "违约金为 200 元");
	assert.equal(body.session_id, "session-request");
	assert.equal(body.thread_id, THREAD_ID);
	assert.equal(body.persisted, true);
	assert.equal(body.retrieval_mode, "hybrid");
	assert.equal(JSON.stringify(body).includes(ORGANIZATION_ID), false);
	assert.equal(
		JSON.stringify(body).includes("private-conflict-excerpt"),
		false,
	);
	const retrievalDebug = body.retrieval_debug as Record<string, unknown>;
	const stages = retrievalDebug.stages as Array<{
		stage: string;
		duration_ms: number;
		ok: boolean;
	}>;
	assert.deepEqual(
		stages.map((stage) => stage.stage),
		["generate", "persist"],
	);
	assert.equal(
		stages.every((stage) => stage.duration_ms >= 0),
		true,
	);
	assert.equal(
		stages.every((stage) => stage.ok),
		true,
	);
	assert.equal(typeof retrievalDebug.total_duration_ms, "number");
	assert.equal(JSON.stringify(retrievalDebug).includes("违约金是多少"), false);
	assert.equal(
		JSON.stringify(retrievalDebug).includes("违约金为 200 元"),
		false,
	);
	assert.deepEqual(runtime.invocations[0]?.history, []);
	assert.equal(repository.exchanges.length, 1);
	assert.deepEqual(repository.exchanges[0]?.scope, {
		organizationId: ORGANIZATION_ID,
		workspaceId: WORKSPACE_ID,
		principalId: PRINCIPAL_ID,
	});
	assert.equal(repository.exchanges[0]?.threadId, THREAD_ID);
	assert.deepEqual(repository.exchanges[0]?.input.user, {
		role: "user",
		content: "违约金是多少？",
	});
	assert.equal(
		repository.exchanges[0]?.input.assistant.content,
		"违约金为 200 元",
	);
	assert.deepEqual(repository.exchanges[0]?.input.assistant.citations, [
		{
			id: "citation-1",
			index: 1,
			doc_id: "document-1",
			document_id: "document-1",
			document_version_id: "version-1",
			title: "合同",
			snippet: "违约金为 200 元",
			score: 0.98,
		},
	]);
	const archivedDebug = repository.exchanges[0]?.input.assistant
		.debug as Record<string, unknown>;
	assert.equal(archivedDebug.mode, "live");
	assert.equal(
		JSON.stringify(archivedDebug).includes("private-conflict-excerpt"),
		false,
	);
	assert.equal(archivedDebug.refused, false);
	assert.equal(archivedDebug.query_type, "fact");
	const archivedRetrievalDebug = archivedDebug.retrieval_debug as Record<
		string,
		unknown
	>;
	assert.deepEqual(
		(
			archivedRetrievalDebug.stages as Array<{ stage: string; ok: boolean }>
		).map((stage) => stage.stage),
		["generate", "persist"],
	);
	assert.equal(typeof archivedRetrievalDebug.total_duration_ms, "number");
	assert.equal(repository.debugUpdates.length, 1);
});

for (const mode of ["sync", "stream"] as const) {
	for (const failure of [
		"timeout",
		"authentication",
		"evidence_validation",
		"unknown",
	] as const) {
		test(`${mode} judge ${failure} fails closed with truthful diagnostics and run ledger`, async (context) => {
			resetPrometheusMetricsForTests();
			const { handleNativeAskRequest } = await handlerModule;
			const { NativeAskRuntime } = await import(
				"../../src/server/http/ask/native-runtime"
			);
			const runs = askRunRecorder();
			let generated = false;
			let calls = 0;
			const model = {} as LanguageModel;
			const structured = new StructuredOutputAdapter(
				model,
				async (input) => {
					calls += 1;
					if (failure === "evidence_validation")
						return {
							sufficient: true,
							action: "generate",
							reason: "private rationale",
							evidence_ids: ["missing-alias"],
						};
					if (failure === "unknown") throw new Error("private sk-secret");
					if (failure === "authentication")
						throw new APICallError({
							message: "private upstream sk-secret",
							url: "https://private.invalid",
							requestBodyValues: { question: "private" },
							statusCode: 401,
							isRetryable: false,
						});
					return new Promise((_, reject) =>
						input.abortSignal?.addEventListener(
							"abort",
							() => reject(input.abortSignal?.reason),
							{ once: true },
						),
					);
				},
				{ timeoutMs: 5, maxAttempts: 2 },
			);
			const response = await handleNativeAskRequest({
				request: request(
					{ question: "违约金是多少？", library_id: LIBRARY_ID },
					mode === "stream" ? "stream" : undefined,
				),
				path: mode === "stream" ? ["v1", "ask", "stream"] : ["v1", "ask"],
				identity,
				repository: repositoryInput(new FakeConversationRepository()),
				askRunsRepository: runs.repository,
				observeMetrics: mode !== "stream",
				resolveLibrary: async () => ({
					id: "99999999-9999-4999-8999-999999999999",
				}),
				runtimeFactory: (input) => {
					const runtime = new NativeAskRuntime(
						input.identity,
						input.libraryId,
						input.signal,
						input.policy,
						{
							structured,
							retrieval: {
								retrieve: async () => {
									throw new Error("test retrieval must be injected");
								},
							},
							answer: new AnswerStreamAdapter(model, async function* () {
								generated = true;
								yield "must not generate";
							}),
						},
						input.assertAuthorized,
					);
					context.mock.method(
						runtime as unknown as { retrieve: () => Promise<RetrievalResult> },
						"retrieve",
						async () => ({
							citations: askState().citations as unknown as InternalCitation[],
							debug: {},
						}),
					);
					return runtime;
				},
			});
			assert.equal(response?.status, 200);
			assert.ok(response);
			const body =
				mode === "stream"
					? (parseSse(await response.text()).at(-1)?.data as Record<
							string,
							unknown
						>)
					: await response.json();
			assert.equal(body.refused, true);
			assert.equal(body.refuse_reason, "judge_unavailable");
			assert.match(body.answer, /证据校验服务暂不可用/);
			assert.doesNotMatch(body.answer, /没有找到|证据不足/);
			assert.deepEqual(body.citations, []);
			assert.equal(generated, false);
			const attempts = failure === "timeout" || failure === "unknown" ? 2 : 1;
			assert.equal(calls, attempts);
			const debug = body.retrieval_debug;
			assert.equal(debug.judge_error_category, failure);
			if (failure === "evidence_validation") {
				assert.equal(debug.judge_failure_source, "evidence_validation");
				assert.equal(debug.judge_validation_code, "selected_ids_unknown");
				assert.equal(debug.judge_sufficiency_attempts, 1);
				assert.equal(debug.judge_attempts, undefined);
				assert.equal(debug.judge_timeout_ms, undefined);
				assert.equal(debug.judge_status_code, undefined);
				assert.equal(debug.judge_retryable, undefined);
			} else {
				assert.equal(debug.judge_failure_source, "structured_request");
				assert.equal(debug.judge_attempts, attempts);
				assert.equal(debug.judge_timeout_ms, 5);
				assert.equal(debug.judge_max_attempts, 2);
				assert.equal(debug.judge_budget_ms, 10);
				assert.equal(debug.judge_retryable, failure !== "authentication");
			}
			assert.equal(
				debug.stages.find((stage: { stage: string }) => stage.stage === "judge")
					?.ok,
				false,
			);
			assert.doesNotMatch(JSON.stringify(debug), /private|sk-secret|违约金/);
			assert.equal(runs.finalizations.length, 1);
			assert.equal(runs.finalizations[0]?.status, "failed");
			assert.equal(runs.finalizations[0]?.errorCode, "judge_unavailable");
			const stage = runs.finalizations[0]?.stages?.find(
				(stage) => stage.stage === "judge",
			);
			assert.equal(stage?.outcome, "failed");
			assert.equal(stage?.errorCode, "judge_unavailable");
			assert.equal(stage?.detail?.judge_error_category, failure);
			assert.equal(
				stage?.detail?.judge_attempts,
				failure === "evidence_validation" ? undefined : attempts,
			);
			if (failure === "evidence_validation") {
				assert.equal(
					stage?.detail?.judge_validation_code,
					"selected_ids_unknown",
				);
				assert.equal(stage?.detail?.judge_sufficiency_attempts, 1);
			}
			const metrics = renderPrometheusMetrics();
			if (mode !== "stream") {
				assert.match(
					metrics,
					/unorag_web_requests_total\{operation="ask",outcome="server_error"\} 1/,
				);
			} else {
				assert.doesNotMatch(
					metrics,
					/unorag_web_requests_total\{operation="ask"/,
				);
			}
			assert.match(
				metrics,
				/unorag_ask_stage_duration_seconds_count\{stage="judge",outcome="failed"\} 1/,
			);
			assert.doesNotMatch(
				metrics,
				/unorag_ask_completions_total\{[^\n]*\} [1-9]/,
			);
		});
	}
}

test("rerank degradation is persisted on its own retrieval attempt, not copied from the final attempt", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const runs = askRunRecorder();
	const diagnostic = RerankDiagnosticSchema.parse({
		...Object.fromEntries(
			Object.keys(RerankDiagnosticSchema.shape).map((key) => [key, 0]),
		),
		category: "timeout",
		statusCode: null,
		attempts: 1,
		durationMs: 10_000,
		timeoutMs: 10_000,
		maxAttempts: 3,
		resultCount: null,
	});
	const recovered = { ...diagnostic, category: "success", durationMs: 120 };
	const runtime = new FakeRuntime(
		askState({
			retrieval_debug: {
				rerankDiagnostic: recovered,
				stages: [
					{
						stage: "retrieve",
						duration_ms: 10_100,
						ok: true,
						detail: {
							rerankDiagnostic: {
								...diagnostic,
								body: "private provider body",
							},
						},
					},
					{
						stage: "retrieve",
						duration_ms: 300,
						ok: true,
						detail: { rerankDiagnostic: recovered },
					},
				],
			},
		}),
		["答案"],
	);
	await handleNativeAskRequest({
		request: request({ question: "问题", library_id: LIBRARY_ID }),
		path: ["v1", "ask"],
		identity,
		repository: repositoryInput(new FakeConversationRepository()),
		runtimeFactory: runtimeFactory(runtime),
		askRunsRepository: runs.repository,
		resolveLibrary: async () => ({
			id: "99999999-9999-4999-8999-999999999999",
		}),
	});
	const stages = runs.finalizations[0]?.stages?.filter(
		(stage) => stage.stage === "retrieve",
	);
	assert.equal(stages?.[0]?.detail?.rerank_category, "timeout");
	assert.equal(stages?.[1]?.detail?.rerank_category, "success");
	assert.equal(stages?.[0]?.outcome, "completed");
	assert.doesNotMatch(JSON.stringify(runs.finalizations), /private provider/);
});

test("Ask run uses the response request ID and reaches a privacy-safe terminal state", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const runs = askRunRecorder();
	const requestId = "88888888-8888-4888-8888-888888888888";
	const otelTraceId = "a".repeat(32);
	const runtime = new FakeRuntime(askState(), ["答案"]);

	const response = await runWithObservabilityContext({ otelTraceId }, () =>
		handleNativeAskRequest({
			request: request({ question: "敏感问题", library_id: LIBRARY_ID }),
			path: ["v1", "ask"],
			identity,
			repository: repositoryInput(new FakeConversationRepository()),
			runtimeFactory: runtimeFactory(runtime),
			requestId,
			askRunsRepository: runs.repository,
			resolveLibrary: async () => ({
				id: "99999999-9999-4999-8999-999999999999",
			}),
		}),
	);

	assert.equal(response?.status, 200);
	const body = (await response?.json()) as Record<string, unknown>;
	assert.equal(body.trace_id, requestId);
	assert.equal(runtime.invocations[0]?.trace_id, requestId);
	assert.equal(runs.starts.length, 1);
	assert.equal(runs.starts[0]?.requestId, requestId);
	assert.equal(runs.starts[0]?.otelTraceId, otelTraceId);
	assert.deepEqual(runs.starts[0]?.principal, {
		type: "user",
		id: PRINCIPAL_ID,
		threadId: null,
	});
	assert.equal(runs.finalizations.length, 1);
	assert.equal(runs.finalizations[0]?.status, "completed");
	assert.equal(runs.finalizations[0]?.queryType, "fact");
	assert.equal(runs.finalizations[0]?.retrievalMode, "hybrid");
	assert.equal(runs.finalizations[0]?.citationCount, 1);
	assert.deepEqual(
		runs.finalizations[0]?.stages?.map((stage) => stage.stage),
		["generate", "persist"],
	);
	assert.equal("question" in (runs.starts[0] ?? {}), false);
	assert.equal("answer" in (runs.finalizations[0] ?? {}), false);
});

test("Ask run keeps service-key principal identity instead of attaching a user thread", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const runs = askRunRecorder();
	const principal = { type: "service_key" as const, id: "service-key-1" };
	const response = await handleNativeAskRequest({
		request: request({ question: "Question", library_id: LIBRARY_ID }),
		path: ["v1", "ask"],
		identity,
		repository: repositoryInput(new FakeConversationRepository()),
		runtimeFactory: runtimeFactory(new FakeRuntime(askState(), ["Answer"])),
		askRunsRepository: runs.repository,
		askRunPrincipal: principal,
		resolveLibrary: async () => ({ id: LIBRARY_ID }),
	});
	assert.equal(response?.status, 200);
	assert.deepEqual(runs.starts[0]?.principal, principal);
	assert.equal(runs.finalizations.length, 1);
});

for (const failedOperation of ["resolve", "start", "finalize"] as const) {
	test(`Ask diagnostics ${failedOperation} failure does not fail a valid answer`, async () => {
		const { handleNativeAskRequest } = await handlerModule;
		const operations: string[] = [];
		const runs = new AskRunsRepository({
			async start() {
				operations.push("start");
				if (failedOperation === "start")
					throw new Error("private database details");
				return { id: "77777777-7777-4777-8777-777777777777" } as never;
			},
			async finalize(input) {
				operations.push("finalize");
				if (failedOperation === "finalize")
					throw new Error("private database details");
				return { id: input.id, status: input.status } as never;
			},
			async deleteExpired() {
				return 0;
			},
		});
		const response = await handleNativeAskRequest({
			request: request({ question: "Question", library_id: LIBRARY_ID }),
			path: ["v1", "ask"],
			identity,
			repository: repositoryInput(new FakeConversationRepository()),
			runtimeFactory: runtimeFactory(new FakeRuntime(askState(), ["Answer"])),
			askRunsRepository: runs,
			resolveLibrary: async () => {
				operations.push("resolve");
				if (failedOperation === "resolve")
					throw new Error("private database details");
				return { id: LIBRARY_ID };
			},
		});
		assert.equal(response?.status, 200);
		const body = await response?.json();
		assert.equal(body.answer, "Answer");
		assert.doesNotMatch(JSON.stringify(body), /private database details/);
		assert.deepEqual(
			operations,
			failedOperation === "resolve"
				? ["resolve"]
				: failedOperation === "start"
					? ["resolve", "start"]
					: ["resolve", "start", "finalize"],
		);
	});
}

test("Ask run records refusal and runtime failure without changing HTTP behavior", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const refusedRuns = askRunRecorder();
	const refused = await handleNativeAskRequest({
		request: request({ question: "无法回答", library_id: LIBRARY_ID }),
		path: ["v1", "ask"],
		identity,
		repository: repositoryInput(new FakeConversationRepository()),
		runtimeFactory: runtimeFactory(
			new FakeRuntime(
				askState({
					refused: true,
					refuse_reason: "insufficient_evidence",
					answer: "证据不足",
					citations: [],
				}),
			),
		),
		askRunsRepository: refusedRuns.repository,
		resolveLibrary: async () => ({
			id: "99999999-9999-4999-8999-999999999999",
		}),
	});
	assert.equal(refused?.status, 200);
	assert.equal(refusedRuns.finalizations[0]?.status, "refused");
	assert.equal(
		refusedRuns.finalizations[0]?.status === "refused" &&
			refusedRuns.finalizations[0].refuseReason,
		"insufficient_evidence",
	);

	const failedRuns = askRunRecorder();
	const failed = await handleNativeAskRequest({
		request: request({ question: "触发失败", library_id: LIBRARY_ID }),
		path: ["v1", "ask"],
		identity,
		repository: repositoryInput(new FakeConversationRepository()),
		runtimeFactory: runtimeFactory(
			new FakeRuntime(askState(), [], new Error("private provider failure")),
		),
		askRunsRepository: failedRuns.repository,
		resolveLibrary: async () => ({
			id: "99999999-9999-4999-8999-999999999999",
		}),
	});
	assert.equal(failed?.status, 503);
	assert.equal(failedRuns.finalizations[0]?.status, "failed");
	assert.equal(failedRuns.finalizations[0]?.errorCode, "Error");
});

test("Qdrant transport failure records a stable dependency diagnosis with a sanitized response", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const runs = askRunRecorder();
	const response = await handleNativeAskRequest({
		request: request({ question: "触发故障", library_id: LIBRARY_ID }),
		path: ["v1", "ask"],
		identity,
		repository: repositoryInput(new FakeConversationRepository()),
		runtimeFactory: runtimeFactory(
			new FakeRuntime(
				askState(),
				[],
				new QdrantOperationError(
					"query",
					new TypeError("private provider endpoint"),
				),
			),
		),
		askRunsRepository: runs.repository,
		resolveLibrary: async () => ({
			id: "99999999-9999-4999-8999-999999999999",
		}),
	});
	assert.equal(response?.status, 503);
	assert.deepEqual(await response?.json(), {
		detail: "Ask service unavailable",
	});
	assert.equal(
		response?.headers.get("x-request-id"),
		runs.starts[0]?.requestId,
	);
	assert.equal(runs.finalizations[0]?.status, "failed");
	assert.equal(runs.finalizations[0]?.errorCode, "qdrant_error");
	assert.equal(
		runs.finalizations[0]?.stages?.[0]?.detail?.qdrant_operation,
		"query",
	);
	assert.equal(
		runs.finalizations[0]?.stages?.[0]?.detail?.qdrant_category,
		"transport",
	);
	assert.doesNotMatch(
		JSON.stringify(runs.finalizations),
		/private provider endpoint/,
	);
});

test("graph diagnostic wrapping preserves access revocation response semantics", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const { AskAccessRevokedError } = await import(
		"../../src/server/http/ask/authorization-checkpoint"
	);
	const runs = askRunRecorder();
	const response = await handleNativeAskRequest({
		request: request({ question: "private question", library_id: LIBRARY_ID }),
		path: ["v1", "ask"],
		identity,
		repository: repositoryInput(new FakeConversationRepository()),
		askRunsRepository: runs.repository,
		resolveLibrary: async () => ({
			id: "99999999-9999-4999-8999-999999999999",
		}),
		runtimeFactory: runtimeFactory(
			new FakeRuntime(
				askState(),
				[],
				new AskGraphExecutionError(new AskAccessRevokedError(), askState(), {
					stages: [{ stage: "retrieve", duration_ms: 1, ok: false }],
				}),
			),
		),
	});
	assert.equal(response?.status, 403);
	assert.ok(response);
	assert.equal((await response.json()).code, "ask_access_changed");
	assert.equal(
		response?.headers.get("x-request-id"),
		runs.starts[0]?.requestId,
	);
	assert.equal(runs.finalizations[0]?.errorCode, "ask_access_changed");
});

for (const mode of ["sync", "stream"] as const) {
	test(`${mode} graph retrieval failure keeps node timings and one stable request ID`, async (context) => {
		const { handleNativeAskRequest } = await handlerModule;
		const { NativeAskRuntime } = await import(
			"../../src/server/http/ask/native-runtime"
		);
		const runs = askRunRecorder();
		const model = {} as LanguageModel;
		const repository = new FakeConversationRepository();
		let generated = false;
		const response = await handleNativeAskRequest({
			request: request(
				{ question: "private question", library_id: LIBRARY_ID },
				mode === "stream" ? "stream" : undefined,
			),
			path: mode === "stream" ? ["v1", "ask", "stream"] : ["v1", "ask"],
			identity,
			repository: repositoryInput(repository),
			askRunsRepository: runs.repository,
			resolveLibrary: async () => ({
				id: "99999999-9999-4999-8999-999999999999",
			}),
			runtimeFactory: (input) => {
				const runtime = new NativeAskRuntime(
					input.identity,
					input.libraryId,
					input.signal,
					input.policy,
					{
						structured: new StructuredOutputAdapter(model, async () => {
							throw new Error("must not invoke model");
						}),
						retrieval: {
							retrieve: async () => {
								throw new QdrantOperationError(
									"query",
									Object.assign(new Error("private connection body"), {
										code: "ECONNRESET",
									}),
									{ durationMs: 2, timeoutMs: 5000 },
								);
							},
						},
						answer: new AnswerStreamAdapter(model, async function* () {
							generated = true;
							yield "must not generate";
						}),
					},
					input.assertAuthorized,
				);
				context.mock.method(
					runtime as unknown as { retrieve: () => Promise<RetrievalResult> },
					"retrieve",
					async () => {
						throw new QdrantOperationError(
							"query",
							Object.assign(new Error("private connection body"), {
								code: "ECONNRESET",
							}),
							{ durationMs: 2, timeoutMs: 5000 },
						);
					},
				);
				return runtime;
			},
		});
		assert.equal(response?.status, 503);
		assert.equal(
			response?.headers.get("x-request-id"),
			runs.starts[0]?.requestId,
		);
		assert.equal(runs.finalizations[0]?.requestId, runs.starts[0]?.requestId);
		assert.equal(runs.finalizations[0]?.queryType, "fact");
		assert.equal(runs.finalizations[0]?.retrievalMode, null);
		assert.equal(runs.finalizations[0]?.errorCode, "qdrant_error");
		assert.deepEqual(
			runs.finalizations[0]?.stages?.map((stage) => [
				stage.stage,
				stage.outcome,
			]),
			[
				["route", "completed"],
				["plan", "completed"],
				["rewrite", "completed"],
				["retrieve", "failed"],
			],
		);
		assert.equal(
			runs.finalizations[0]?.stages?.at(-1)?.detail?.qdrant_transportCode,
			"ECONNRESET",
		);
		assert.equal(repository.exchanges.length, 0);
		assert.equal(generated, false);
		assert.doesNotMatch(
			JSON.stringify(runs.finalizations) +
				JSON.stringify(await response?.json()),
			/private/,
		);
	});
}

test("stream ask preserves SSE order and persists after all tokens", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const repository = new FakeConversationRepository([activeThread()]);
	const runtime = new FakeRuntime(askState(), ["违约金", "为 200 元"]);

	const response = await handleNativeAskRequest({
		request: request(
			{
				question: "违约金是多少？",
				library_id: LIBRARY_ID,
				thread_id: THREAD_ID,
			},
			"stream",
		),
		path: ["v1", "ask", "stream"],
		identity,
		repository: repositoryInput(repository),
		runtimeFactory: runtimeFactory(runtime),
	});

	assert.equal(response?.status, 200);
	assert.match(
		response?.headers.get("content-type") ?? "",
		/text\/event-stream/,
	);
	assert.equal(repository.exchanges.length, 0);

	const events = parseSse((await response?.text()) ?? "");
	assert.deepEqual(
		events.map(({ event }) => event),
		["meta", "citations", "token", "token", "done"],
	);
	assert.deepEqual(events[2]?.data, "违约金");
	assert.deepEqual(events[3]?.data, "为 200 元");
	const done = events.at(-1)?.data as Record<string, unknown> | undefined;
	assert.equal(done?.persisted, true);
	assert.equal(done?.answer, "违约金为 200 元");
	const doneDebug = done?.retrieval_debug as Record<string, unknown>;
	assert.deepEqual(
		(
			doneDebug.stages as Array<{
				stage: string;
				ok: boolean;
			}>
		).map((stage) => [stage.stage, stage.ok]),
		[
			["generate", true],
			["persist", true],
		],
	);
	assert.equal(typeof doneDebug.total_duration_ms, "number");
	assert.equal(JSON.stringify(doneDebug).includes("违约金是多少"), false);
	assert.equal(JSON.stringify(doneDebug).includes("违约金为 200 元"), false);
	assert.equal(repository.exchanges.length, 1);
	assert.equal(
		repository.exchanges[0]?.input.assistant.content,
		"违约金为 200 元",
	);
});

test("invalid answer citations fail the run without persisting a successful exchange", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	for (const queryType of [
		"fact",
		"follow_up",
		"compare",
		"summary",
	] as const) {
		for (const streaming of [false, true]) {
			const repository = new FakeConversationRepository([activeThread()]);
			const runs = askRunRecorder();
			const runtime = new FakeRuntime(askState({ query_type: queryType }));
			const answer = new AnswerStreamAdapter(
				{} as LanguageModel,
				async function* () {
					yield "价格200元";
					yield " [source:2].";
				},
			);
			runtime.streamAnswer = () =>
				answer.stream(
					{ question: "价格是多少？", context: "[source:1] 价格200元" },
					{ allowedCitationIndices: [1] },
				);
			const response = await handleNativeAskRequest({
				request: request(
					{
						question: "价格是多少？",
						library_id: LIBRARY_ID,
						thread_id: THREAD_ID,
					},
					streaming ? "stream" : undefined,
				),
				path: streaming ? ["v1", "ask", "stream"] : ["v1", "ask"],
				identity,
				repository: repositoryInput(repository),
				runtimeFactory: runtimeFactory(runtime),
				askRunsRepository: runs.repository,
				resolveLibrary: async () => ({
					id: "99999999-9999-4999-8999-999999999999",
				}),
			});
			const body = await response?.text();
			if (streaming) {
				assert.match(body ?? "", /event: error/);
				assert.doesNotMatch(body ?? "", /event: done/);
			} else assert.equal(response?.status, 503);
			assert.equal(repository.exchanges.length, 0);
			assert.equal(runs.finalizations[0]?.status, "failed");
			assert.equal(runs.finalizations[0]?.errorCode, "answer_citation_invalid");
			assert.ok(
				runs.finalizations[0]?.stages?.some(
					(stage) =>
						stage.detail?.citation_category === "unknown_source" &&
						stage.detail?.citation_allowedSourceCount === 1,
				),
			);
		}
	}
});

test("stream aborted before token iteration finalizes the Ask run as cancelled", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const runs = askRunRecorder();
	const controller = new AbortController();
	controller.abort();
	const abortedRequest = new Request("http://local/v1/ask/stream", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ question: "取消请求", library_id: LIBRARY_ID }),
		signal: controller.signal,
	});
	const response = await handleNativeAskRequest({
		request: abortedRequest,
		path: ["v1", "ask", "stream"],
		identity,
		repository: repositoryInput(new FakeConversationRepository()),
		runtimeFactory: runtimeFactory(new FakeRuntime(askState(), ["不应生成"])),
		askRunsRepository: runs.repository,
		resolveLibrary: async () => ({
			id: "99999999-9999-4999-8999-999999999999",
		}),
	});

	assert.equal(response?.status, 200);
	const events = parseSse((await response?.text()) ?? "");
	assert.equal(events.at(-1)?.event, "error");
	assert.equal(runs.finalizations.length, 1);
	assert.equal(runs.finalizations[0]?.status, "cancelled");
	assert.equal(runs.finalizations[0]?.errorCode, "request_aborted");
	assert.equal(runs.finalizations[0]?.stages?.at(-1)?.outcome, "cancelled");
});

test("persist stage reports a sanitized failure without failing the answer", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const runtime = new FakeRuntime(askState(), ["可用回答"]);
	const runs = askRunRecorder();
	const response = await handleNativeAskRequest({
		request: request({
			question: "测试持久化",
			library_id: LIBRARY_ID,
			thread_id: THREAD_ID,
		}),
		path: ["v1", "ask"],
		identity,
		repository: repositoryInput(
			new FailingConversationRepository([activeThread()]),
		),
		runtimeFactory: runtimeFactory(runtime),
		askRunsRepository: runs.repository,
		resolveLibrary: async () => ({
			id: "99999999-9999-4999-8999-999999999999",
		}),
	});

	assert.equal(response?.status, 200);
	const body = (await response?.json()) as Record<string, unknown>;
	assert.equal(body.persisted, false);
	assert.equal(body.persist_error, "conversation persistence failed");
	const debug = body.retrieval_debug as Record<string, unknown>;
	assert.deepEqual(
		(debug.stages as Array<{ stage: string; ok: boolean }>).map((stage) => [
			stage.stage,
			stage.ok,
		]),
		[
			["generate", true],
			["persist", false],
		],
	);
	assert.equal(JSON.stringify(debug).includes("测试持久化"), false);
	assert.equal(JSON.stringify(debug).includes("可用回答"), false);
	assert.equal(runs.finalizations.length, 1);
	const persistStage = runs.finalizations[0]?.stages?.find(
		(stage) => stage.stage === "persist",
	);
	assert.equal(persistStage?.outcome, "failed");
	assert.equal(persistStage?.errorCode, "conversation_persist_failed");
});

test("clarification state is persisted server-side without entering the public diagnostics", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const now = Date.now();
	const pending = {
		version: 1 as const,
		question: "它什么时候生效？",
		candidates: ["方案 A", "方案 B"],
		createdAt: now,
		expiresAt: now + CLARIFICATION_TTL_MS,
	};
	const state = askState({
		refused: true,
		answer: "请选择 A 或 B",
		retrieval_debug: { pending_clarification: pending },
	});
	const memory = new FakeSessionMemory();
	const response = await handleNativeAskRequest({
		request: request({
			question: pending.question,
			library_id: LIBRARY_ID,
			session_id: "pending-choice",
		}),
		path: ["v1", "ask"],
		identity,
		repository: repositoryInput(new FakeConversationRepository()),
		memoryStore: memory as never,
		runtimeFactory: (() => new FakeRuntime(state)) as never,
	});
	assert.equal(response?.status, 200);
	assert.equal(
		JSON.stringify(await response?.json()).includes("pending_clarification"),
		false,
	);
	assert.deepEqual(
		(memory.appended[0]?.messages[1] as Record<string, unknown> | undefined)
			?.pending_clarification,
		pending,
	);
});

test("temporary session memory is scoped, bounded, and receives policy settings", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const memory = new FakeSessionMemory();
	const runtime = new FakeRuntime(askState(), ["临时回答"]);
	let observedPolicy: Record<string, unknown> | undefined;

	const response = await handleNativeAskRequest({
		request: request({
			question: "临时追问",
			library_id: LIBRARY_ID,
			session_id: "temporary-session",
			ask_overrides: {
				retrieve_top_k: 4,
				answer_min_score: 0.5,
				hybrid_enabled: true,
				rerank_enabled: true,
				citation_adjudicate_enabled: true,
				citation_adjudicate_absolute_floor: 0.45,
				session_memory_enabled: true,
				session_memory_max_turns: 3,
			},
		}),
		path: ["v1", "ask"],
		identity,
		repository: repositoryInput(new FakeConversationRepository()),
		memoryStore: memory as never,
		runtimeFactory: ((input: { policy: Record<string, unknown> }) => {
			observedPolicy = input.policy;
			return runtime;
		}) as never,
	});

	assert.equal(response?.status, 200);
	assert.deepEqual(runtime.invocations[0]?.history, []);
	assert.equal(observedPolicy?.retrieve_top_k, 4);
	assert.equal(observedPolicy?.hybrid_enabled, true);
	assert.deepEqual(memory.appended, [
		{
			scope: {
				organizationId: ORGANIZATION_ID,
				workspaceId: WORKSPACE_ID,
				principalId: PRINCIPAL_ID,
			},
			sessionId: "temporary-session",
			messages: [
				{ role: "user", content: "临时追问" },
				{
					role: "assistant",
					content: "临时回答",
					provenance: {
						version: 1,
						libraryId: LIBRARY_ID,
						sourceReferences: [
							{
								doc_id: "document-1",
								document_version_id: "version-1",
								generation_id: "generation-1",
							},
						],
					},
				},
			],
			maxTurns: 3,
		},
	]);
});

test("model configuration and runtime failures return sanitized 503", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	const failures = [
		() => {
			throw new Error("missing secret model key");
		},
		() =>
			new FakeRuntime(
				askState(),
				[],
				new Error("private runtime provider failure"),
			),
	];

	for (const createRuntime of failures) {
		const response = await handleNativeAskRequest({
			request: request({ question: "问题", library_id: LIBRARY_ID }),
			path: ["v1", "ask"],
			identity,
			repository: repositoryInput(new FakeConversationRepository()),
			runtimeFactory: (() => createRuntime()) as never,
		});

		assert.equal(response?.status, 503);
		const body = await response?.json();
		assert.deepEqual(body, { detail: "Ask service unavailable" });
		assert.equal(JSON.stringify(body).includes("secret"), false);
		assert.equal(JSON.stringify(body).includes("private"), false);
	}
});

test("LLM pressure failures return stable retryable 503 outcomes", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	for (const [error, code] of [
		[new AiConcurrencyOverloadedError(), "llm_overloaded"],
		[new AiConcurrencyWaitTimeoutError(30_000), "llm_queue_timeout"],
	] as const) {
		const response = await handleNativeAskRequest({
			request: request({ question: "问题", library_id: LIBRARY_ID }),
			path: ["v1", "ask"],
			identity,
			repository: repositoryInput(new FakeConversationRepository()),
			runtimeFactory: runtimeFactory(new FakeRuntime(askState(), [], error)),
		});

		assert.equal(response?.status, 503);
		assert.equal(response?.headers.get("retry-after"), "1");
		assert.deepEqual(await response?.json(), {
			detail: "AI provider is busy",
			code,
		});
	}
});

for (const mode of ["sync", "stream"] as const) {
	for (const revoked of ["session", "candidate-only"] as const) {
		test(`${mode} finalize hook ${revoked} revoke is checked at the delivery boundary`, async (t) => {
			const { handleNativeAskRequest } = await handlerModule;
			const caller = { ...identity, role: "editor" };
			const repository = new FakeConversationRepository([activeThread()]);
			const privatePreview =
				"private candidate revoked in finalize must not leave";
			const runId = "77777777-7777-4777-8777-777777777777";
			let ledgerStatus: FinalizeAskRunInput["status"] | "running" = "running";
			let finalizeReturned = false;
			let checksAfterFinalize = 0;
			const finalizations: FinalizeAskRunInput[] = [];
			const warnings: unknown[] = [];
			t.mock.method(logger, "warn", (event: unknown) => {
				warnings.push(event);
			});
			const runs = new AskRunsRepository({
				async start() {
					return { id: runId } as never;
				},
				async finalize(input) {
					finalizations.push(input);
					// Match the real repository: an already-terminal run cannot be finalized again.
					if (ledgerStatus !== "running") return null;
					ledgerStatus = input.status;
					await Promise.resolve();
					finalizeReturned = true;
					return { id: runId, status: input.status } as never;
				},
				async deleteExpired() {
					return 0;
				},
			});
			const runtime = Object.assign(
				new FakeRuntime(askState(), ["Answer [1]"]),
				{
					getRetrievalInspections: () => [
						{
							references: [
								{
									doc_id: "dropped",
									document_version_id: "dropped-v",
									generation_id: "dropped-g",
								},
							],
							inspection: {
								query: "question",
								candidates: [{ id: "dropped", preview: privatePreview }],
							},
						},
					],
				},
			);
			const response = await handleNativeAskRequest({
				request: request(
					{
						question: "question",
						library_id: LIBRARY_ID,
						thread_id: THREAD_ID,
						include_trace_details: true,
					},
					mode,
				),
				path: mode === "stream" ? ["v1", "ask", "stream"] : ["v1", "ask"],
				identity: caller,
				repository: repositoryInput(repository),
				askRunsRepository: runs,
				resolveLibrary: async () => ({ id: "db-library" }),
				runtimeFactory: runtimeFactory(runtime),
				authorization: {
					refreshIdentity: async () => {
						if (finalizeReturned) checksAfterFinalize += 1;
						return finalizeReturned && revoked === "session" ? null : caller;
					},
					resolveLibrary: (async () => ({ id: LIBRARY_ID })) as never,
					citationAuthorizer: {
						filterAuthorized: async ({ citations }) =>
							finalizeReturned && revoked === "candidate-only"
								? citations.filter((citation) => citation.doc_id !== "dropped")
								: citations,
					},
				},
			});
			assert.ok(response);
			const text = await response.text();
			assert.equal(text.includes(privatePreview), false);
			assert.equal(text.includes('"retrieval_inspection"'), false);
			if (revoked === "session") {
				if (mode === "sync") {
					assert.equal(response.status, 403);
					const body = JSON.parse(text);
					assert.equal(body.code, "ask_access_changed");
					assert.equal("answer" in body, false);
				} else {
					const frames = parseSse(text);
					const last = frames.at(-1);
					assert.ok(last);
					assert.equal(last.event, "error");
					assert.equal(
						(last.data as { code: string }).code,
						"ask_access_changed",
					);
					assert.equal(
						frames.some((frame) => frame.event === "done"),
						false,
					);
				}
				assert.equal(repository.boundaries.length, 1);
				assert.deepEqual(warnings, [
					{
						event: "ask.delivery.authorization_failed_after_finalize",
						run_id: runId,
						finalize_status_attempted: "completed",
						error_code: "ask_access_changed",
						ledger_reclassified: false,
					},
				]);
			} else {
				assert.equal(response.status, 200);
				if (mode === "sync")
					assert.equal(JSON.parse(text).answer, "Answer [1]");
				else {
					const frames = parseSse(text);
					const last = frames.at(-1);
					assert.ok(last);
					assert.equal(last.event, "done");
					assert.equal((last.data as { answer: string }).answer, "Answer [1]");
				}
				assert.equal(repository.boundaries.length, 0);
				assert.deepEqual(warnings, []);
			}
			assert.equal(repository.exchanges.length, 1);
			assert.equal(finalizeReturned, true);
			assert.ok(checksAfterFinalize > 0);
			assert.equal(ledgerStatus, "completed");
			assert.deepEqual(
				finalizations.map(({ status }) => status),
				["completed"],
			);
		});
	}
	for (const revoked of ["session", "library", "answer"] as const) {
		test(`${mode} final trace check cannot hide ${revoked} revocation`, async () => {
			const { handleNativeAskRequest } = await handlerModule;
			const caller = { ...identity, role: "editor" };
			const repository = new FakeConversationRepository([activeThread()]);
			const runs = askRunRecorder();
			let finalCheck = false;
			const runtime = Object.assign(
				new FakeRuntime(askState(), ["Private answer [1]"]),
				{
					getRetrievalInspections() {
						finalCheck = true;
						return [];
					},
				},
			);
			const response = await handleNativeAskRequest({
				request: request(
					{
						question: "question",
						library_id: LIBRARY_ID,
						thread_id: THREAD_ID,
						include_trace_details: true,
					},
					mode,
				),
				path: mode === "stream" ? ["v1", "ask", "stream"] : ["v1", "ask"],
				identity: caller,
				repository: repositoryInput(repository),
				askRunsRepository: runs.repository,
				resolveLibrary: async () => ({ id: "db-library" }),
				runtimeFactory: runtimeFactory(runtime),
				authorization: {
					refreshIdentity: async () =>
						finalCheck && revoked === "session" ? null : caller,
					resolveLibrary: (async () =>
						finalCheck && revoked === "library"
							? null
							: { id: LIBRARY_ID }) as never,
					citationAuthorizer: {
						filterAuthorized: async ({ citations }) =>
							finalCheck && revoked === "answer" ? [] : citations,
					},
				},
			});
			assert.ok(response);
			if (mode === "sync") {
				assert.equal(response.status, 403);
				const body = await response.json();
				assert.equal(body.code, "ask_access_changed");
				assert.equal("answer" in body, false);
			} else {
				const frames = parseSse(await response.text());
				const last = frames.at(-1);
				assert.ok(last);
				assert.equal(last.event, "error");
				assert.equal(
					(last.data as { code: string }).code,
					"ask_access_changed",
				);
				assert.equal(
					frames.some((frame) => frame.event === "done"),
					false,
				);
			}
			assert.equal(finalCheck, true);
			assert.equal(repository.exchanges.length, 0);
			assert.equal(runs.finalizations.at(-1)?.status, "failed");
		});
	}
	test(`${mode} dropped candidate revoked during persistence never reaches final trace`, async () => {
		const { handleNativeAskRequest } = await handlerModule;
		const caller = { ...identity, role: "editor" };
		const repository = new FakeConversationRepository([activeThread()]);
		const append = repository.appendExchange.bind(repository);
		let revoked = false;
		repository.appendExchange = async (...args) => {
			const result = await append(...args);
			revoked = true;
			return result;
		};
		const privatePreview = "revoked candidate preview must not leave";
		const runtime = Object.assign(new FakeRuntime(askState(), ["Answer [1]"]), {
			getRetrievalInspections: () => [
				{
					references: [
						{
							doc_id: "dropped",
							document_version_id: "dropped-v",
							generation_id: "dropped-g",
						},
					],
					inspection: {
						query: "question",
						candidates: [{ id: "dropped", preview: privatePreview }],
					},
				},
			],
		});
		const response = await handleNativeAskRequest({
			request: request(
				{
					question: "question",
					library_id: LIBRARY_ID,
					thread_id: THREAD_ID,
					include_trace_details: true,
				},
				mode,
			),
			path: mode === "stream" ? ["v1", "ask", "stream"] : ["v1", "ask"],
			identity: caller,
			repository: repositoryInput(repository),
			runtimeFactory: runtimeFactory(runtime),
			authorization: {
				refreshIdentity: async () => caller,
				resolveLibrary: (async () => ({ id: LIBRARY_ID })) as never,
				citationAuthorizer: {
					filterAuthorized: async ({ citations }) =>
						revoked
							? citations.filter((c) => c.doc_id !== "dropped")
							: citations,
				},
			},
		});
		assert.ok(response);
		assert.equal(response.status, 200);
		const body = await response.text();
		assert.ok(body.includes("Answer [1]"));
		assert.equal(body.includes(privatePreview), false);
		assert.equal(body.includes('"retrieval_inspection"'), false);
		if (mode === "stream") assert.ok(body.includes("event: done"));
	});
	test(`${mode} revocation during persistence blocks completion and writes a history boundary`, async () => {
		const { handleNativeAskRequest } = await handlerModule;
		const repository = new FakeConversationRepository([activeThread()]);
		const appendExchange = repository.appendExchange.bind(repository);
		let authorized = true;
		repository.appendExchange = async (...args) => {
			const result = await appendExchange(...args);
			authorized = false;
			return result;
		};
		const response = await handleNativeAskRequest({
			request: request(
				{ question: "question", library_id: LIBRARY_ID, thread_id: THREAD_ID },
				mode,
			),
			path: mode === "stream" ? ["v1", "ask", "stream"] : ["v1", "ask"],
			identity,
			repository: repositoryInput(repository),
			runtimeFactory: runtimeFactory(
				new FakeRuntime(askState(), ["Private answer [1]"]),
			),
			authorization: {
				refreshIdentity: async () => (authorized ? identity : null),
				resolveLibrary: (async () => ({ id: LIBRARY_ID })) as never,
				citationAuthorizer: {
					filterAuthorized: async ({ citations }) => citations,
				},
			},
		});
		assert.ok(response);
		if (mode === "sync") {
			assert.equal(response.status, 403);
			assert.equal((await response.json()).code, "ask_access_changed");
		} else {
			const frames = parseSse(await response.text());
			assert.equal(frames.at(-1)?.event, "error");
			assert.equal(
				frames.some((frame) => frame.event === "done"),
				false,
			);
		}
		assert.equal(repository.exchanges.length, 1);
		assert.equal(repository.boundaries.length, 1);
	});
	test(`${mode} archive persists only allowed retrieval plan metadata`, async () => {
		const { handleNativeAskRequest } = await handlerModule;
		const repository = new FakeConversationRepository([activeThread()]);
		const marker = "private rewritten question should remain live-only";
		const response = await handleNativeAskRequest({
			request: request(
				{ question: "question", library_id: LIBRARY_ID, thread_id: THREAD_ID },
				mode,
			),
			path: mode === "stream" ? ["v1", "ask", "stream"] : ["v1", "ask"],
			identity,
			repository: repositoryInput(repository),
			runtimeFactory: runtimeFactory(
				new FakeRuntime(
					askState({
						retrieval_plan: {
							query_type: "fact",
							path: "fast",
							route: "short",
							filters: { record_type: "text", doc_id: "document-1" },
							grounded_question: marker,
							rewritten_queries: [marker],
							reason: marker,
							future_content_field: { text: marker },
						},
					}),
					["Answer [1]"],
				),
			),
		});
		assert.ok(response);
		assert.equal(response.status, 200);
		await response.text();
		assert.equal(repository.exchanges.length, 1);
		const plan = repository.exchanges[0].input.assistant.debug?.retrieval_plan;
		assert.equal((plan as Record<string, unknown>).query_type, "fact");
		assert.equal((plan as Record<string, unknown>).path, "fast");
		assert.doesNotMatch(
			JSON.stringify(repository.exchanges),
			new RegExp(marker),
		);
		assert.doesNotMatch(
			JSON.stringify(repository.debugUpdates),
			new RegExp(marker),
		);
	});
}

test("revocation after retrieval prevents generation and persistence", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	let allowed = true;
	let generated = false;
	let executionSignal: AbortSignal | undefined;
	const repository = new FakeConversationRepository([activeThread()]);
	const runtime = new FakeRuntime(askState());
	runtime.invoke = async () => {
		allowed = false;
		return askState();
	};
	runtime.streamAnswer = async function* () {
		generated = true;
		yield "must not be generated";
	};
	const response = await handleNativeAskRequest({
		request: request({
			question: "question",
			library_id: LIBRARY_ID,
			thread_id: THREAD_ID,
		}),
		path: ["v1", "ask"],
		identity,
		repository: repositoryInput(repository),
		runtimeFactory: ((input: { signal: AbortSignal }) => {
			executionSignal = input.signal;
			return runtime;
		}) as never,
		authorization: {
			refreshIdentity: async () => identity,
			resolveLibrary: (async () => ({ id: LIBRARY_ID })) as never,
			citationAuthorizer: {
				filterAuthorized: async ({ citations }) => (allowed ? citations : []),
			},
		},
	});
	assert.equal(response?.status, 403);
	assert.ok(response);
	assert.equal((await response.json()).code, "ask_access_changed");
	assert.equal(generated, false);
	assert.equal(executionSignal?.aborted, true);
	assert.equal(repository.exchanges.length, 0);
});

test("a revoked stream emits an access error before exposing citations", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	let refreshes = 0;
	const repository = new FakeConversationRepository([activeThread()]);
	const response = await handleNativeAskRequest({
		request: request(
			{ question: "question", library_id: LIBRARY_ID },
			"stream",
		),
		path: ["v1", "ask", "stream"],
		identity,
		repository: repositoryInput(repository),
		runtimeFactory: runtimeFactory(
			new FakeRuntime(askState(), ["private answer"]),
		),
		authorization: {
			refreshIdentity: async () => (++refreshes <= 2 ? identity : null),
			resolveLibrary: (async () => ({ id: LIBRARY_ID })) as never,
			citationAuthorizer: {
				filterAuthorized: async ({ citations }) => citations,
			},
		},
	});
	assert.equal(response?.status, 200);
	assert.ok(response);
	const events = parseSse(await response.text());
	assert.deepEqual(
		events.map((event) => event.event),
		["error"],
	);
	assert.equal((events[0].data as { code: string }).code, "ask_access_changed");
	assert.equal(repository.exchanges.length, 0);
});

test("revocation while generating blocks sync delivery and memory persistence", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	let current: AuthIdentity | null = identity;
	const repository = new FakeConversationRepository([activeThread()]);
	const runtime = new FakeRuntime(askState());
	runtime.streamAnswer = async function* () {
		yield "partial answer";
		current = null;
		yield "late answer";
	};
	const response = await handleNativeAskRequest({
		request: request({
			question: "question",
			library_id: LIBRARY_ID,
			thread_id: THREAD_ID,
		}),
		path: ["v1", "ask"],
		identity,
		repository: repositoryInput(repository),
		runtimeFactory: runtimeFactory(runtime),
		authorization: {
			refreshIdentity: async () => current,
			resolveLibrary: (async () => ({ id: LIBRARY_ID })) as never,
			citationAuthorizer: {
				filterAuthorized: async ({ citations }) => citations,
			},
		},
	});
	assert.equal(response?.status, 403);
	assert.ok(response);
	assert.equal((await response.json()).code, "ask_access_changed");
	assert.equal(repository.exchanges.length, 0);
});

test("cancelling the response aborts upstream execution before returning the iterator", async () => {
	const { handleNativeAskRequest } = await handlerModule;
	let executionSignal: AbortSignal | undefined;
	const repository = new FakeConversationRepository([activeThread()]);
	const response = await handleNativeAskRequest({
		request: request(
			{ question: "question", library_id: LIBRARY_ID },
			"stream",
		),
		path: ["v1", "ask", "stream"],
		identity,
		repository: repositoryInput(repository),
		runtimeFactory: ((input: { signal: AbortSignal }) => {
			executionSignal = input.signal;
			return new FakeRuntime(askState(), ["answer"]);
		}) as never,
	});
	assert.ok(response?.body);
	const reader = response.body.getReader();
	await reader.read();
	await reader.cancel();
	assert.equal(executionSignal?.aborted, true);
	assert.equal(repository.exchanges.length, 0);
});

class StoredSessionMemory {
	readonly windows = new Map<string, SessionMemoryMessage[]>();
	readonly boundaries: string[] = [];

	key(scope: ConversationScope, sessionId: string) {
		return JSON.stringify([
			scope.organizationId,
			scope.workspaceId,
			scope.principalId,
			sessionId,
		]);
	}

	async load(scope: ConversationScope, sessionId: string, maxTurns: number) {
		return (this.windows.get(this.key(scope, sessionId)) ?? []).slice(
			-maxTurns * 2,
		);
	}

	async append(
		scope: ConversationScope,
		sessionId: string,
		messages: SessionMemoryMessage[],
		maxTurns: number,
	) {
		const key = this.key(scope, sessionId);
		if (messages.length === 1) this.boundaries.push(key);
		this.windows.set(
			key,
			[...(this.windows.get(key) ?? []), ...messages].slice(-maxTurns * 2),
		);
	}
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function historyFixture(archived: boolean) {
	const repository = new FakeConversationRepository([
		activeThread(),
		activeThread({ id: FOREIGN_THREAD_ID }),
	]);
	const memory = new StoredSessionMemory();
	const run = async (
		runtime: FakeRuntime,
		options: {
			question?: string;
			stream?: boolean;
			otherSession?: boolean;
			signal?: AbortSignal;
		} = {},
	) => {
		const { handleNativeAskRequest } = await handlerModule;
		const req = request(
			{
				question: options.question ?? "方案 A的报价是多少？",
				library_id: LIBRARY_ID,
				session_id: options.otherSession ? "new-session" : "old-session",
				...(archived
					? { thread_id: options.otherSession ? FOREIGN_THREAD_ID : THREAD_ID }
					: {}),
			},
			options.stream ? "stream" : "sync",
		);
		const response = await handleNativeAskRequest({
			request: options.signal
				? new Request(req, { signal: options.signal })
				: req,
			path: options.stream ? ["v1", "ask", "stream"] : ["v1", "ask"],
			identity,
			repository: repositoryInput(repository),
			memoryStore: memory,
			runtimeFactory: runtimeFactory(runtime),
		});
		assert.ok(response);
		return response;
	};
	const seed = () => run(new FakeRuntime(askState(), ["方案 A报价300元"]));
	const boundaryCount = () =>
		archived ? repository.boundaries.length : memory.boundaries.length;
	const assertNoHistory = async () => {
		const runtime = new FakeRuntime(askState());
		runtime.invoke = async (input) => {
			assert.deepEqual(input.history, []);
			const rewritten = await rewriteFollowup(
				input.question ?? "",
				input.history ?? [],
				async () => {
					throw new Error("untrusted history reached the resolver");
				},
			);
			assert.ok(rewritten.clarification);
			return askState({
				refused: true,
				answer: rewritten.clarification,
				citations: [],
			});
		};
		const response = await run(runtime, {
			question: "它的生效日期是什么时候？",
		});
		assert.equal(response.status, 200);
		assert.doesNotMatch(
			JSON.stringify(await response.json()),
			/方案 A|pending_clarification|memory_provenance/,
		);
	};
	return { repository, memory, run, seed, boundaryCount, assertNoHistory };
}

for (const archived of [false, true]) {
	const storage = archived ? "archived" : "temporary";
	for (const stream of [false, true]) {
		test(`${storage} ${stream ? "SSE" : "JSON"} preserves an expired clarification across rewrite-to-persistence`, async (t) => {
			const fixture = historyFixture(archived);
			const now = Date.now();
			t.mock.timers.enable({ apis: ["Date"], now });
			const pending = {
				version: 1 as const,
				question: "它什么时候生效？",
				candidates: ["方案 A", "方案 B"],
				createdAt: now,
				expiresAt: now + CLARIFICATION_TTL_MS,
			};
			await fixture.run(
				new FakeRuntime(
					askState({
						refused: true,
						answer: "请选择方案 A或方案 B",
						retrieval_debug: { pending_clarification: pending },
					}),
				),
				{ question: pending.question },
			);
			const runtime = new FakeRuntime(askState());
			runtime.invoke = async (input) => {
				const rewritten = await rewriteFollowup(
					input.question ?? "",
					input.history ?? [],
					async () => {
						throw new Error("invalid selection must not call the resolver");
					},
				);
				assert.deepEqual(rewritten.pendingClarification, pending);
				t.mock.timers.tick(CLARIFICATION_TTL_MS);
				return askState({
					refused: true,
					citations: [],
					answer: rewritten.clarification,
					retrieval_debug: {
						pending_clarification: rewritten.pendingClarification,
					},
				});
			};
			const response = await fixture.run(runtime, { question: "C", stream });
			assert.equal(response.status, 200);
			assert.doesNotMatch(
				await response.text(),
				/pending_clarification|memory_provenance|grounded_question/,
			);
			const saved = archived
				? fixture.repository.exchanges.at(-1)?.input.assistant.debug
						?.pending_clarification
				: [...fixture.memory.windows.values()][0]?.at(-1)
						?.pending_clarification;
			assert.deepEqual(saved, pending);
			await fixture.assertNoHistory();
		});
	}

	for (const failure of [
		"invoke",
		"sync generation",
		"stream generation",
		"cancel",
		"cancel generation",
		"request abort",
		"request abort stream",
	] as const) {
		test(`${storage} ${failure} records exactly one boundary before the next follow-up`, async () => {
			const fixture = historyFixture(archived);
			await fixture.seed();
			const controller = new AbortController();
			const started = deferred();
			const release = deferred();
			const runtime = new FakeRuntime(askState());
			if (failure === "invoke") {
				runtime.invoke = async () => {
					throw new Error("private provider failure");
				};
			} else if (failure.startsWith("request abort")) {
				runtime.invoke = async () => {
					controller.abort();
					return askState();
				};
			} else if (failure === "cancel generation") {
				runtime.streamAnswer = async function* () {
					yield "partial private answer";
					started.resolve();
					await release.promise;
					yield "late private answer";
				};
			} else if (failure !== "cancel") {
				runtime.streamAnswer = async function* () {
					yield "partial private answer";
					throw new Error("private provider failure");
				};
			}
			const stream =
				failure === "stream generation" ||
				failure.startsWith("cancel") ||
				failure === "request abort stream";
			const response = await fixture.run(runtime, {
				question: "方案 B的报价是多少？",
				stream,
				signal: controller.signal,
			});
			if (failure.startsWith("cancel")) {
				assert.ok(response.body);
				const reader = response.body.getReader();
				await reader.read();
				if (failure === "cancel generation") {
					await reader.read();
					await reader.read();
					await started.promise;
				}
				const cancelled = reader.cancel();
				release.resolve();
				await cancelled;
			} else if (stream) {
				const events = parseSse(await response.text());
				const last = events.at(-1);
				assert.ok(last);
				assert.equal(last.event, "error");
				assert.equal(
					(last.data as { code: string }).code,
					failure === "request abort stream" ? "aborted" : "stream_failed",
				);
				assert.ok(!events.some((event) => event.event === "done"));
			} else {
				assert.equal(response.status, 503);
				assert.deepEqual(await response.json(), {
					detail: "Ask service unavailable",
				});
			}
			assert.equal(fixture.boundaryCount(), 1);
			if (archived) {
				assert.deepEqual(fixture.repository.boundaries[0].input, {
					role: "system",
					content: "",
					status:
						failure.startsWith("cancel") || failure.startsWith("request abort")
							? "cancelled"
							: "failed",
				});
			} else {
				assert.deepEqual([...fixture.memory.windows.values()][0]?.at(-1), {
					role: "assistant",
					content: "",
					history_boundary: true,
				});
			}
			await fixture.assertNoHistory();
		});
	}

	test(`${storage} late cancellation waits for in-flight persistence and cannot restore history`, async (t) => {
		const fixture = historyFixture(archived);
		await fixture.seed();
		const started = deferred(),
			release = deferred();
		if (archived) {
			const append = fixture.repository.appendExchange.bind(fixture.repository);
			t.mock.method(
				fixture.repository,
				"appendExchange",
				async (...args: Parameters<typeof append>) => {
					started.resolve();
					await release.promise;
					return append(...args);
				},
			);
		} else {
			const append = fixture.memory.append.bind(fixture.memory);
			t.mock.method(
				fixture.memory,
				"append",
				async (...args: Parameters<typeof append>) => {
					if (args[2].length > 1) {
						started.resolve();
						await release.promise;
					}
					return append(...args);
				},
			);
		}
		const response = await fixture.run(
			new FakeRuntime(askState(), ["late answer"]),
			{ stream: true },
		);
		assert.ok(response.body);
		const reader = response.body.getReader();
		await reader.read();
		await reader.read();
		await reader.read();
		await started.promise;
		const cancelled = reader.cancel();
		release.resolve();
		await cancelled;
		assert.equal(fixture.boundaryCount(), 1);
		await fixture.assertNoHistory();
	});

	test(`${storage} delayed failure cannot clear a newer independent session`, async () => {
		const fixture = historyFixture(archived);
		await fixture.seed();
		const started = deferred(),
			release = deferred();
		const old = new FakeRuntime(askState());
		old.invoke = async () => {
			started.resolve();
			await release.promise;
			throw new Error("late old failure");
		};
		const oldResponse = fixture.run(old, { question: "方案 B的报价是多少？" });
		await started.promise;
		await fixture.run(new FakeRuntime(askState(), ["new answer"]), {
			question: "方案 C的报价是多少？",
			otherSession: true,
		});
		release.resolve();
		assert.equal((await oldResponse).status, 503);
		const next = new FakeRuntime(askState(), ["follow-up"]);
		await fixture.run(next, {
			question: "它什么时候生效？",
			otherSession: true,
		});
		assert.deepEqual(next.invocations[0].history, [
			{ role: "user", content: "方案 C的报价是多少？" },
			{ role: "assistant", content: "new answer" },
		]);
		await fixture.assertNoHistory();
	});

	test(`${storage} boundary storage errors preserve the original failure and log metadata only`, async (t) => {
		const fixture = historyFixture(archived);
		await fixture.seed();
		const warnings: unknown[] = [];
		t.mock.method(logger, "warn", (value: unknown) => {
			warnings.push(value);
		});
		if (archived) {
			t.mock.method(fixture.repository, "appendTurn", async () => {
				throw new Error("private PG failure");
			});
		} else {
			t.mock.method(fixture.memory, "append", async () => {
				throw new Error("private Redis failure");
			});
		}
		const response = await fixture.run(
			new FakeRuntime(askState(), [], new AiConcurrencyOverloadedError()),
		);
		assert.equal(response.status, 503);
		assert.equal(response.headers.get("retry-after"), "1");
		assert.deepEqual(await response.json(), {
			detail: "AI provider is busy",
			code: "llm_overloaded",
		});
		assert.equal(fixture.boundaryCount(), 0);
		assert.deepEqual(warnings, [
			{ event: "ask.history_boundary.persist_failed" },
		]);
	});

	test(`${storage} a failed answer write reports persistence failure and leaves a boundary`, async (t) => {
		const fixture = historyFixture(archived);
		await fixture.seed();
		if (archived) {
			t.mock.method(fixture.repository, "appendExchange", async () => {
				throw new Error("private PG failure");
			});
		} else {
			const append = fixture.memory.append.bind(fixture.memory);
			t.mock.method(
				fixture.memory,
				"append",
				async (...args: Parameters<typeof append>) => {
					if (args[2].length > 1) throw new Error("private Redis failure");
					return append(...args);
				},
			);
		}
		const response = await fixture.run(
			new FakeRuntime(askState(), ["answer not saved"]),
		);
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(body.persisted, false);
		assert.equal(
			body.persist_error,
			archived
				? "conversation persistence failed"
				: "session memory persistence failed",
		);
		assert.equal(fixture.boundaryCount(), 1);
		await fixture.assertNoHistory();
	});

	test(`${storage} technical judge refusal cannot become reusable history`, async () => {
		const fixture = historyFixture(archived);
		await fixture.seed();
		const response = await fixture.run(
			new FakeRuntime(
				askState({
					refused: true,
					refuse_reason: "judge_unavailable",
					answer: "service unavailable",
					retrieval_debug: { judge_mode: "model_error" },
				}),
			),
			{ question: "方案 B的报价是多少？" },
		);
		assert.equal(response.status, 200);
		assert.equal((await response.json()).refuse_reason, "judge_unavailable");
		await fixture.assertNoHistory();
	});
}

test("archive debug refresh cannot drop a clarification that expires after its first write", async (t) => {
	const fixture = historyFixture(true);
	const now = Date.now();
	t.mock.timers.enable({ apis: ["Date"], now });
	const pending = {
		version: 1 as const,
		question: "它什么时候生效？",
		candidates: ["方案 A", "方案 B"],
		createdAt: now,
		expiresAt: now + CLARIFICATION_TTL_MS,
	};
	const append = fixture.repository.appendExchange.bind(fixture.repository);
	t.mock.method(
		fixture.repository,
		"appendExchange",
		async (...args: Parameters<typeof append>) => {
			const result = await append(...args);
			t.mock.timers.tick(CLARIFICATION_TTL_MS);
			return result;
		},
	);
	const response = await fixture.run(
		new FakeRuntime(
			askState({
				refused: true,
				answer: "请选择方案 A或方案 B",
				retrieval_debug: { pending_clarification: pending },
			}),
		),
		{ question: pending.question },
	);
	assert.equal(response.status, 200);
	assert.deepEqual(
		fixture.repository.debugUpdates[0].debug.pending_clarification,
		pending,
	);
	await fixture.assertNoHistory();
});
