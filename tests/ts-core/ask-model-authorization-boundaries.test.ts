import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { type TestContext, test } from "node:test";
import { setImmediate } from "node:timers/promises";

import type { LanguageModel } from "ai";

import {
	AiConcurrencyGate,
	AnswerStreamAdapter,
	StructuredOutputAdapter,
} from "../../src/core/ai";
import type { AskState } from "../../src/core/ask-graph";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import type {
	SessionMemoryMessage,
	SessionMemoryStore,
} from "../../src/server/conversations/session-memory";

const require = createRequire(import.meta.url);
const nodeModule = require("node:module") as {
	_resolveFilename: (
		request: string,
		parent?: unknown,
		isMain?: boolean,
		options?: unknown,
	) => string;
};
const originalResolveFilename = nodeModule._resolveFilename.bind(nodeModule);
const inertServerOnlyModule = require.resolve("next/package.json");
nodeModule._resolveFilename = (request, parent, isMain, options) =>
	request === "server-only"
		? inertServerOnlyModule
		: originalResolveFilename(request, parent, isMain, options);
const modules = Promise.all([
	import("../../src/server/http/ask/native-handler"),
	import("../../src/server/http/ask/native-runtime"),
	import("../../src/server/http/ask/authorization-checkpoint"),
]).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

const model = {} as LanguageModel;
const identity: AuthIdentity = {
	tenantId: "organization",
	workspaceId: "workspace",
	workspaceName: "Workspace",
	principalId: "reader",
	groupIds: [],
	organizationRole: "member",
	role: "viewer",
	email: null,
	displayName: "Reader",
	provider: "local",
	mustChangePassword: false,
};

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function queuedGate() {
	const queued = deferred();
	const gate = new AiConcurrencyGate(1, (event) => {
		if (event.type === "snapshot" && event.snapshot.queued > 0) {
			queued.resolve();
		}
	});
	return { gate, queued: queued.promise };
}

function preparedState(): AskState {
	return {
		session_id: "session",
		question: "What does the source say?",
		library_id: "library",
		history: [],
		rewritten_question: undefined,
		citations: [
			{
				id: "citation",
				doc_id: "document",
				document_version_id: "version",
				generation_id: "generation",
				title: "Private source",
				body: "Private evidence must not reach a revoked provider request.",
			},
		],
		answer: undefined,
		refused: false,
		refuse_reason: null,
		retrieval_attempts: 1,
		judgement: undefined,
		retrieval_debug: {},
		trace_id: "trace",
		query_type: "fact",
		route_reason: "prepared evidence",
		retrieval_plan: undefined,
		table_query_plan: undefined,
		table_execution: undefined,
		upgrade: null,
		upgrade_reason: null,
		downgrade_reason: null,
	};
}

async function streamFixture(context: TestContext, gate?: AiConcurrencyGate) {
	const [{ handleNativeAskRequest }, { createNativeAskRuntime }] =
		await modules;
	let current: AuthIdentity | null = identity;
	let providerCalls = 0;
	let executionSignal: AbortSignal | undefined;
	const appended: SessionMemoryMessage[][] = [];
	const memoryStore: SessionMemoryStore = {
		load: async () => [],
		append: async (_scope, _sessionId, messages) => {
			appended.push(messages);
		},
	};
	const answer = new AnswerStreamAdapter(
		model,
		async function* () {
			providerCalls += 1;
			yield "Authorized answer";
		},
		{ concurrencyGate: gate },
	);
	const structured = new StructuredOutputAdapter(model, async () => {
		assert.fail("The prepared graph result must not call structured AI");
	});
	const response = await handleNativeAskRequest({
		request: new Request("http://local/v1/ask/stream", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				question: "What does the source say?",
				library_id: "library",
				session_id: "session",
			}),
		}),
		path: ["v1", "ask", "stream"],
		identity,
		memoryStore,
		repository: {} as never,
		observeMetrics: false,
		runtimeFactory: (input) => {
			executionSignal = input.signal;
			const state = preparedState();
			const runtime = createNativeAskRuntime({
				...input,
				dependencies: {
					answer,
					structured,
					retrieval: {
						retrieve: async () => {
							assert.fail("The prepared graph result must not retrieve");
						},
					},
				},
			});
			// Isolate graph preparation; runtime generation and admission stay real.
			context.mock.method(runtime, "invoke", async () => state);
			context.mock.method(
				runtime,
				"getEvidenceReferences",
				() => state.citations ?? [],
			);
			return runtime;
		},
		authorization: {
			refreshIdentity: async () => current,
			resolveLibrary: (async () => ({ id: "library" })) as never,
			citationAuthorizer: {
				filterAuthorized: async ({ citations }) => citations,
			},
		},
	});
	assert.ok(response);
	assert.equal(response.status, 200);
	return {
		response,
		appended,
		providerCalls: () => providerCalls,
		aborted: () => executionSignal?.aborted,
		revoke: () => {
			current = null;
		},
	};
}

function frameNames(body: string): string[] {
	return [...body.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
}

test("real runtime rechecks after SSE frames were buffered before starting the provider", {
	timeout: 5_000,
}, async (context) => {
	let now = 0;
	context.mock.method(performance, "now", () => now);
	const fixture = await streamFixture(context);
	await setImmediate();
	assert.equal(fixture.providerCalls(), 0);
	now = 2_000;
	fixture.revoke();
	const body = await fixture.response.text();
	assert.deepEqual(frameNames(body), ["meta", "citations", "error"]);
	assert.match(body, /"code":"ask_access_changed"/);
	assert.equal(fixture.providerCalls(), 0);
	assert.equal(fixture.aborted(), true);
	assert.deepEqual(fixture.appended, []);
});

test("real runtime rechecks again after answer concurrency admission", {
	timeout: 5_000,
}, async (context) => {
	const { gate, queued } = queuedGate();
	const held = await gate.acquire();
	context.after(() => held.release());
	const fixture = await streamFixture(context, gate);
	const bodyPromise = fixture.response.text();
	await queued;
	assert.equal(fixture.providerCalls(), 0);
	assert.deepEqual(gate.snapshot(), { active: 1, queued: 1, limit: 1 });
	fixture.revoke();
	held.release();
	const body = await bodyPromise;
	assert.deepEqual(frameNames(body), ["meta", "citations", "error"]);
	const [, dataLine] = body.trim().split("\n\n").at(-1)?.split("\n") ?? [];
	assert.ok(dataLine?.startsWith("data: "));
	const terminalError = JSON.parse(dataLine.slice(6));
	assert.equal(terminalError.code, "ask_access_changed");
	assert.equal(terminalError.truncated, true);
	assert.equal(fixture.providerCalls(), 0);
	assert.equal(fixture.aborted(), true);
	assert.deepEqual(fixture.appended, []);
	assert.deepEqual(gate.snapshot(), { active: 0, queued: 0, limit: 1 });
});

test("an authorized queued answer still generates, persists, and releases its permit", {
	timeout: 5_000,
}, async (context) => {
	const { gate, queued } = queuedGate();
	const held = await gate.acquire();
	context.after(() => held.release());
	const fixture = await streamFixture(context, gate);
	const bodyPromise = fixture.response.text();
	await queued;
	assert.equal(fixture.providerCalls(), 0);
	held.release();
	const body = await bodyPromise;
	assert.deepEqual(frameNames(body), ["meta", "citations", "token", "done"]);
	assert.equal(fixture.providerCalls(), 1);
	assert.equal(fixture.aborted(), false);
	assert.equal(fixture.appended.length, 1);
	assert.equal(fixture.appended[0][1].content, "Authorized answer");
	assert.ok(fixture.appended[0][1].provenance);
	assert.deepEqual(gate.snapshot(), { active: 0, queued: 0, limit: 1 });
});

test("answer beforeRequest runs after admission and denial releases the permit", {
	timeout: 5_000,
}, async (context) => {
	const [, , { AskAccessRevokedError }] = await modules;
	const { gate, queued } = queuedGate();
	const held = await gate.acquire();
	context.after(() => held.release());
	let allowed = true;
	let checks = 0;
	let providerCalls = 0;
	const reason = new AskAccessRevokedError();
	const controller = new AbortController();
	const adapter = new AnswerStreamAdapter(
		model,
		async function* () {
			providerCalls += 1;
			yield "must not be requested";
		},
		{ concurrencyGate: gate },
	);
	const pending = assert.rejects(
		adapter
			.stream(
				{ question: "question", context: "private context" },
				{
					abortSignal: controller.signal,
					beforeRequest: async () => {
						checks += 1;
						assert.equal(gate.snapshot().active, 1);
						if (!allowed) {
							controller.abort(reason);
							throw reason;
						}
					},
				},
			)
			.next(),
		(error) => error === reason,
	);
	await queued;
	assert.equal(checks, 0);
	allowed = false;
	held.release();
	await pending;
	assert.equal(controller.signal.reason, reason);
	assert.equal(checks, 1);
	assert.equal(providerCalls, 0);
	assert.deepEqual(gate.snapshot(), { active: 0, queued: 0, limit: 1 });
});

const structuredCalls = {
	route: (adapter: StructuredOutputAdapter, options: RequestOptions) =>
		adapter.route({ question: "question" }, options),
	rewrite: (adapter: StructuredOutputAdapter, options: RequestOptions) =>
		adapter.rewrite(
			{ question: "question", fallbackSemanticQuery: "question" },
			options,
		),
	judge: (adapter: StructuredOutputAdapter, options: RequestOptions) =>
		adapter.judge(
			{ question: "question", citations: [], attempts: 0 },
			options,
		),
	planTable: (adapter: StructuredOutputAdapter, options: RequestOptions) =>
		adapter.planTable({ question: "question", tables: [] }, options),
};
type RequestOptions = { beforeRequest: () => Promise<void> };

for (const [kind, invoke] of Object.entries(structuredCalls)) {
	test(`structured ${kind} checks after admission and does not retry a denied checkpoint`, {
		timeout: 5_000,
	}, async (context) => {
		const [, , { AskAccessRevokedError }] = await modules;
		const { gate, queued } = queuedGate();
		const held = await gate.acquire();
		context.after(() => held.release());
		let allowed = true;
		let checks = 0;
		let providerCalls = 0;
		const reason = new AskAccessRevokedError();
		const adapter = new StructuredOutputAdapter(
			model,
			async () => {
				providerCalls += 1;
				throw new Error("Provider must not be called after revocation");
			},
			{ concurrencyGate: gate, maxAttempts: 3 },
		);
		const pending = assert.rejects(
			invoke(adapter, {
				beforeRequest: async () => {
					checks += 1;
					assert.equal(gate.snapshot().active, 1);
					if (!allowed) throw reason;
				},
			}),
			(error) => error === reason,
		);
		await queued;
		assert.equal(checks, 0);
		allowed = false;
		held.release();
		await pending;
		assert.equal(checks, 1);
		assert.equal(providerCalls, 0);
		assert.deepEqual(gate.snapshot(), { active: 0, queued: 0, limit: 1 });
	});
}

test("structured retries recheck authorization before each provider attempt", async () => {
	const [, , { AskAccessRevokedError }] = await modules;
	const gate = new AiConcurrencyGate(1);
	const reason = new AskAccessRevokedError();
	let allowed = true;
	let checks = 0;
	let providerCalls = 0;
	const adapter = new StructuredOutputAdapter(
		model,
		async () => {
			providerCalls += 1;
			allowed = false;
			throw new TypeError("transient provider failure");
		},
		{ concurrencyGate: gate, maxAttempts: 3 },
	);
	await assert.rejects(
		adapter.route(
			{ question: "question" },
			{
				beforeRequest: async () => {
					checks += 1;
					if (!allowed) throw reason;
				},
			},
		),
		(error) => error === reason,
	);
	assert.equal(checks, 2);
	assert.equal(providerCalls, 1);
	assert.deepEqual(gate.snapshot(), { active: 0, queued: 0, limit: 1 });
});
