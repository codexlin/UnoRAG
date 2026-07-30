import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import type { AskGraphInput, AskState } from "../../src/core/ask-graph";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import type {
	AppendConversationExchangeInput,
	ConversationScope,
} from "../../src/server/conversations/types";

type NativeHandlerModule =
	typeof import("../../src/server/http/ask/native-handler");

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
const originalResolveFilename =
	nodeModule._resolveFilename.bind(nodeModule);
const inertServerOnlyModule = require.resolve("next/package.json");

// `server-only` is a framework marker with no behavior used by this unit.
nodeModule._resolveFilename = (request, parent, isMain, options) =>
	request === "server-only"
		? inertServerOnlyModule
		: originalResolveFilename(request, parent, isMain, options);

const handlerModule = import("../../src/server/http/ask/native-handler").finally(
	() => {
		nodeModule._resolveFilename = originalResolveFilename;
	},
);

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
		if (!thread || thread.status !== "active") {
			throw new Error("thread not found");
		}
		this.exchanges.push({ scope, threadId, input });
		return [];
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
				doc_id: "document-1",
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

test("runtime flag off returns null without invoking dependencies", async () => {
	const previous = process.env.UNORAG_ASK_RUNTIME;
	delete process.env.UNORAG_ASK_RUNTIME;
	try {
		const { handleNativeAskRequest } = await handlerModule;
		const repository = new FakeConversationRepository();
		const runtime = new FakeRuntime(askState());
		const response = await handleNativeAskRequest({
			request: request({ question: "问题", library_id: LIBRARY_ID }),
			path: ["v1", "ask"],
			identity,
			repository: repositoryInput(repository),
			runtimeFactory: runtimeFactory(runtime),
		});

		assert.equal(response, null);
		assert.equal(runtime.invocations.length, 0);
		assert.equal(repository.exchanges.length, 0);
	} finally {
		if (previous === undefined) delete process.env.UNORAG_ASK_RUNTIME;
		else process.env.UNORAG_ASK_RUNTIME = previous;
	}
});

test("invalid native ask payload returns 400", async () => {
	process.env.UNORAG_ASK_RUNTIME = "typescript";
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
	process.env.UNORAG_ASK_RUNTIME = "typescript";
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
			repository: repositoryInput(
				new FakeConversationRepository([thread]),
			),
			runtimeFactory: runtimeFactory(runtime),
		});

		assert.equal(response?.status, 404);
		assert.deepEqual(await response?.json(), { detail: "thread not found" });
		assert.equal(runtime.invocations.length, 0);
	}
});

test("sync ask returns public response and atomically appends the exchange", async () => {
	process.env.UNORAG_ASK_RUNTIME = "typescript";
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
	assert.deepEqual(runtime.invocations[0]?.history, [
		{ role: "user", content: "上一问" },
		{ role: "assistant", content: "上一答" },
	]);
	assert.equal(repository.exchanges.length, 1);
	assert.deepEqual(repository.exchanges[0], {
		scope: {
			organizationId: ORGANIZATION_ID,
			workspaceId: WORKSPACE_ID,
			principalId: PRINCIPAL_ID,
		},
		threadId: THREAD_ID,
		input: {
			user: { role: "user", content: "违约金是多少？" },
			assistant: {
				role: "assistant",
				content: "违约金为 200 元",
				citations: [
					{
						id: "citation-1",
						doc_id: "document-1",
						document_id: "document-1",
						title: "合同",
						snippet: "违约金为 200 元",
						score: 0.98,
					},
				],
				debug: {
					mode: "live",
					refused: false,
					refuse_reason: null,
					query_type: "fact",
					retrieval_plan: null,
					retrieval_debug: {
						retrievalMode: "hybrid",
						hybridFailed: false,
						rerankFailed: false,
					},
					judge: null,
					table_execution: null,
				},
			},
		},
	});
});

test("stream ask preserves SSE order and persists after all tokens", async () => {
	process.env.UNORAG_ASK_RUNTIME = "typescript";
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
	assert.match(response?.headers.get("content-type") ?? "", /text\/event-stream/);
	assert.equal(repository.exchanges.length, 0);

	const events = parseSse((await response?.text()) ?? "");
	assert.deepEqual(
		events.map(({ event }) => event),
		["meta", "citations", "token", "token", "done"],
	);
	assert.deepEqual(events[2]?.data, "违约金");
	assert.deepEqual(events[3]?.data, "为 200 元");
	assert.equal(
		(events.at(-1)?.data as Record<string, unknown>).persisted,
		true,
	);
	assert.equal(
		(events.at(-1)?.data as Record<string, unknown>).answer,
		"违约金为 200 元",
	);
	assert.equal(repository.exchanges.length, 1);
	assert.equal(
		repository.exchanges[0]?.input.assistant.content,
		"违约金为 200 元",
	);
});

test("model configuration and runtime failures return sanitized 503", async () => {
	process.env.UNORAG_ASK_RUNTIME = "typescript";
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
