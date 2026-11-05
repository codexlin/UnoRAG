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
import { AnswerCitationValidationError } from "../../src/core/ai/answer-citations";
import type { AskGraphInput, AskState } from "../../src/core/ask-graph";
import { AskGraphExecutionError } from "../../src/core/ask-graph";
import type {
	InternalCitation,
	RetrievalResult,
} from "../../src/core/retrieval";
import { RerankDiagnosticSchema } from "../../src/core/retrieval/provider-request";
import { QdrantOperationError } from "../../src/core/retrieval/qdrant/store";
import { runWithObservabilityContext } from "../../src/lib/observability/context";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import type {
	AppendConversationExchangeInput,
	ConversationScope,
} from "../../src/server/conversations/types";
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
	turns: Array<{
		role: "system" | "user" | "assistant" | "tool";
		status: "pending" | "complete" | "failed";
		content: string;
	}>;
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

	constructor(private readonly threads: StoredThread[] = []) {}

	async getThread(scope: ConversationScope, threadId: string) {
		return (
			this.threads.find(
				(thread) =>
					thread.id === threadId &&
					thread.organizationId === scope.organizationId &&
					thread.workspaceId === scope.workspaceId &&
					thread.principalId === scope.principalId,
			) ?? null
		);
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
		return [
			{ id: `user-${this.exchanges.length}`, role: "user" },
			{ id: `assistant-${this.exchanges.length}`, role: "assistant" },
		] as never;
	}

	async updateTurnDebug(
		_scope: ConversationScope,
		_threadId: string,
		turnId: string,
		debug: Record<string, unknown>,
	) {
		this.debugUpdates.push({ turnId, debug });
		const exchange = this.exchanges.at(-1);
		if (exchange) exchange.input.assistant.debug = debug;
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
	const runtime = new FakeRuntime(askState(), ["违约金", "为 200 元"]);

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
	for (const failure of ["timeout", "authentication"] as const) {
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
			const attempts = failure === "timeout" ? 2 : 1;
			assert.equal(calls, attempts);
			const debug = body.retrieval_debug;
			assert.equal(debug.judge_attempts, attempts);
			assert.equal(debug.judge_error_category, failure);
			assert.equal(debug.judge_timeout_ms, 5);
			assert.equal(debug.judge_max_attempts, 2);
			assert.equal(debug.judge_budget_ms, 10);
			assert.equal(debug.judge_retryable, failure === "timeout");
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
			assert.equal(stage?.detail?.judge_attempts, attempts);
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
	for (const streaming of [false, true]) {
		const repository = new FakeConversationRepository([activeThread()]);
		const runs = askRunRecorder();
		const runtime = new FakeRuntime(askState());
		runtime.streamAnswer = async function* () {
			yield "价格200元";
			throw new AnswerCitationValidationError();
		};
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
