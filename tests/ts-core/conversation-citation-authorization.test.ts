import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import type { ConversationScope } from "../../src/server/conversations/types";

type ConversationHandlerModule =
	typeof import("../../src/server/http/ask/conversation-handler");

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

const handlerModule: Promise<ConversationHandlerModule> = import(
	"../../src/server/http/ask/conversation-handler"
).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL_ID = "33333333-3333-4333-8333-333333333333";
const THREAD_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_ID = "55555555-5555-4555-8555-555555555555";
const GENERATION_ID = "66666666-6666-4666-8666-666666666666";
const LIBRARY_ID = "library-a";

const identity: AuthIdentity = {
	tenantId: ORGANIZATION_ID,
	workspaceId: WORKSPACE_ID,
	workspaceName: "Workspace",
	principalId: PRINCIPAL_ID,
	groupIds: ["77777777-7777-4777-8777-777777777777"],
	organizationRole: "member",
	role: "viewer",
	email: "viewer@example.com",
	displayName: "Viewer",
	provider: "local",
	mustChangePassword: false,
};

function citation(overrides: Record<string, unknown> = {}) {
	return {
		id: "citation-1",
		library_id: LIBRARY_ID,
		doc_id: "document-a",
		document_version_id: VERSION_ID,
		generation_id: GENERATION_ID,
		tenant_id: ORGANIZATION_ID,
		workspace_id: WORKSPACE_ID,
		text: "sensitive historical body",
		...overrides,
	};
}

function storedThread() {
	const now = new Date("2026-07-30T00:00:00.000Z");
	return {
		id: THREAD_ID,
		organizationId: ORGANIZATION_ID,
		workspaceId: WORKSPACE_ID,
		principalId: PRINCIPAL_ID,
		sessionId: "session-a",
		ragLibraryId: LIBRARY_ID,
		title: "Thread",
		status: "active",
		createdAt: now,
		updatedAt: now,
		turns: [
			{
				id: "88888888-8888-4888-8888-888888888881",
				threadId: THREAD_ID,
				organizationId: ORGANIZATION_ID,
				workspaceId: WORKSPACE_ID,
				principalId: PRINCIPAL_ID,
				sequence: 1,
				role: "user",
				content: "question",
				citations: [],
				debug: null,
				status: "complete",
				usage: null,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "88888888-8888-4888-8888-888888888882",
				threadId: THREAD_ID,
				organizationId: ORGANIZATION_ID,
				workspaceId: WORKSPACE_ID,
				principalId: PRINCIPAL_ID,
				sequence: 2,
				role: "assistant",
				content: "answer",
				citations: [citation(), citation({ id: "citation-revoked" })],
				debug: null,
				status: "complete",
				usage: null,
				createdAt: now,
				updatedAt: now,
			},
		],
	};
}

class FakeRepository {
	readonly thread = storedThread();

	async getThread(scope: ConversationScope, threadId: string) {
		if (
			scope.organizationId !== ORGANIZATION_ID ||
			scope.workspaceId !== WORKSPACE_ID ||
			scope.principalId !== PRINCIPAL_ID ||
			threadId !== THREAD_ID
		) {
			return null;
		}
		return this.thread;
	}

	async listThreads() {
		return [this.thread];
	}

	async listTurns() {
		throw new Error("thread lists must not load citation bodies");
	}
}

function queryRows(rows: Record<string, unknown>[]) {
	const query = {
		from() {
			return this;
		},
		innerJoin() {
			return this;
		},
		leftJoin() {
			return this;
		},
		where() {
			return Promise.resolve(rows);
		},
	};
	return {
		select() {
			return query;
		},
	};
}

test("thread detail preserves the legacy shape but filters revoked citations", async () => {
	const { handleNativeConversationRequest } = await handlerModule;
	const calls: unknown[] = [];
	const response = await handleNativeConversationRequest({
		request: new Request(`http://local/v1/threads/${THREAD_ID}`),
		path: ["v1", "threads", THREAD_ID],
		identity,
		repository: new FakeRepository() as never,
		citationAuthorizer: {
			async filterAuthorized(input) {
				calls.push(input);
				return input.citations.filter((item) => item.id === "citation-1");
			},
		},
	});

	assert.ok(response);
	assert.equal(response.status, 200);
	const payload = await response.json();
	assert.equal(payload.turns[0].question, "question");
	assert.equal(payload.turns[0].answer, "answer");
	assert.deepEqual(
		payload.turns[0].citations.map((item: { id: string }) => item.id),
		["citation-1"],
	);
	assert.equal(calls.length, 1);
	assert.equal(
		(calls[0] as { identity: AuthIdentity }).identity.workspaceId,
		WORKSPACE_ID,
	);
});

test("thread list does not authorize or load citation bodies", async () => {
	const { handleNativeConversationRequest } = await handlerModule;
	let authorizationCalls = 0;
	const response = await handleNativeConversationRequest({
		request: new Request("http://local/v1/threads"),
		path: ["v1", "threads"],
		identity,
		repository: new FakeRepository() as never,
		citationAuthorizer: {
			async filterAuthorized() {
				authorizationCalls += 1;
				return [];
			},
		},
		turnCounter: {
			async countAssistantTurns(_scope, threadIds) {
				return new Map(threadIds.map((threadId) => [threadId, 1]));
			},
		},
	});

	assert.ok(response);
	assert.equal(response.status, 200);
	assert.equal(authorizationCalls, 0);
	const payload = await response.json();
	assert.equal(payload[0].turn_count, 1);
});

for (const continuing of [false, true]) {
	test(`${continuing ? "continue" : "GET"} projects public debug without exposing or mutating server clarification state`, async () => {
		const { handleNativeConversationRequest } = await handlerModule;
		const pending = {
			version: 1 as const,
			question: "when does it start?",
			candidates: ["A", "B"],
			createdAt: Date.now(),
			expiresAt: Date.now() + 60_000,
		};
		const marker = {
			version: 1,
			libraryId: LIBRARY_ID,
			sourceReferences: [
				{
					doc_id: "document-a",
					document_version_id: VERSION_ID,
					generation_id: GENERATION_ID,
				},
			],
		};
		const debug = {
			pending_clarification: pending,
			memory_provenance: marker,
			retrieval_debug: {
				trace_id: "public-trace",
				total_duration_ms: 42,
				usedHybrid: true,
				pending_clarification: pending,
				memory_provenance: marker,
				retrieval_plan: { grounded_question: "private grounded question" },
				stages: [
					{
						stage: "rewrite",
						duration_ms: 7,
						ok: true,
						detail: { pending_clarification: pending },
					},
				],
			},
		};
		const base = storedThread();
		const stored = {
			...base,
			turns: [base.turns[0], { ...base.turns[1], debug }],
		};
		const before = structuredClone(stored);
		const path = [
			"v1",
			"threads",
			THREAD_ID,
			...(continuing ? ["continue"] : []),
		];
		const response = await handleNativeConversationRequest({
			request: new Request(`http://local/${path.join("/")}`, {
				method: continuing ? "POST" : "GET",
			}),
			path,
			identity,
			repository: {
				getThread: async () => stored,
				touchThread: async () => stored,
			} as never,
			citationAuthorizer: {
				filterAuthorized: async ({ citations }) =>
					citations.filter((item) => item.id === "citation-1"),
			},
		});
		assert.equal(response?.status, 200);
		const payload = await response?.json();
		assert.deepEqual(payload.turns[0].retrieval_debug, {
			trace_id: "public-trace",
			total_duration_ms: 42,
			used_hybrid: true,
			stages: [{ stage: "rewrite", duration_ms: 7, ok: true }],
		});
		assert.deepEqual(
			payload.turns[0].citations.map((item: { id: string }) => item.id),
			["citation-1"],
		);
		assert.doesNotMatch(
			JSON.stringify(payload),
			/pending_clarification|memory_provenance|private grounded question/,
		);
		assert.deepEqual(stored, before);
	});
}

test("archive takes provenance only from scoped server memory, never submitted debug or edited text", async () => {
	const { handleNativeConversationRequest } = await handlerModule;
	const { authorizeArchivedHistory } = await import(
		"../../src/server/http/ask/authorized-history"
	);
	const source = {
		doc_id: "document-a",
		document_version_id: VERSION_ID,
		generation_id: GENERATION_ID,
	};
	const marker = {
		version: 1 as const,
		libraryId: LIBRARY_ID,
		sourceReferences: [source],
	};
	const modelUsage = {
		version: 1,
		calls: [
			{
				stage: "generate",
				model: "test",
				provider: "test",
				attempt: 1,
				status: "completed",
				inputTokens: 10,
				outputTokens: 2,
				totalTokens: 12,
			},
		],
	};
	let created: ReturnType<typeof storedThread> | undefined;
	const memoryReads: unknown[] = [];
	const response = await handleNativeConversationRequest({
		request: new Request("http://local/v1/threads", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				session_id: "session-a",
				library_id: LIBRARY_ID,
				turns: [
					{
						question: "question",
						answer: "answer",
						citations: [],
						retrieval_debug: {
							model_usage: { ...modelUsage, prompt: "private prompt" },
							private_response: "private body",
						},
					},
					{
						question: "question",
						answer: "edited answer",
						citations: [source],
						retrieval_debug: { memory_provenance: marker },
					},
				],
			}),
		}),
		path: ["v1", "threads"],
		identity,
		repository: {
			async createThreadWithTurns(_scope: unknown, input: { turns: object[] }) {
				const base = storedThread();
				created = {
					...base,
					turns: input.turns.map((turn, index) => ({
						...base.turns[index % 2],
						...turn,
					})),
				} as ReturnType<typeof storedThread>;
				return created;
			},
		} as never,
		memoryStore: {
			async load(...args) {
				memoryReads.push(args);
				return [
					{ role: "user", content: "question" },
					{ role: "assistant", content: "answer", provenance: marker },
				];
			},
			async append() {
				throw new Error("archive must not rewrite memory");
			},
		},
		citationAuthorizer: {
			filterAuthorized: async ({ citations }) => citations,
		},
	});
	assert.equal(response?.status, 200);
	const archivedResponse = await response?.json();
	assert.equal(
		archivedResponse.turns[0].retrieval_debug.model_usage.totalTokens,
		12,
	);
	assert.equal(
		archivedResponse.turns[0].retrieval_debug.model_usage.status,
		"reported",
	);
	assert.doesNotMatch(
		JSON.stringify(archivedResponse),
		/private prompt|private body/,
	);
	assert.deepEqual(memoryReads, [
		[
			{
				organizationId: ORGANIZATION_ID,
				workspaceId: WORKSPACE_ID,
				principalId: PRINCIPAL_ID,
			},
			"session-a",
			50,
		],
	]);
	assert.ok(created);
	const history = await authorizeArchivedHistory({
		identity,
		libraryId: LIBRARY_ID,
		turns: created.turns,
		citationAuthorizer: {
			filterAuthorized: async ({ citations }) => citations,
		},
	});
	assert.deepEqual(history.messages, []);
	const trustedPrefix = await authorizeArchivedHistory({
		identity,
		libraryId: LIBRARY_ID,
		turns: created.turns.slice(0, 2),
		citationAuthorizer: {
			filterAuthorized: async ({ citations }) => citations,
		},
	});
	assert.deepEqual(trustedPrefix.messages, [
		{ role: "user", content: "question" },
		{ role: "assistant", content: "answer" },
	]);
});

test("archive omission of a failed turn cannot recover the pre-boundary conversation", async () => {
	const { handleNativeConversationRequest } = await handlerModule;
	const { authorizeArchivedHistory } = await import(
		"../../src/server/http/ask/authorized-history"
	);
	const marker = {
		version: 1 as const,
		libraryId: LIBRARY_ID,
		sourceReferences: [
			{
				doc_id: "document-a",
				document_version_id: VERSION_ID,
				generation_id: GENERATION_ID,
			},
		],
	};
	let created: ReturnType<typeof storedThread> | undefined;
	const response = await handleNativeConversationRequest({
		request: new Request("http://local/v1/threads", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				session_id: "session-a",
				library_id: LIBRARY_ID,
				turns: [{ question: "question", answer: "answer" }],
			}),
		}),
		path: ["v1", "threads"],
		identity,
		repository: {
			async createThreadWithTurns(_scope: unknown, input: { turns: object[] }) {
				const base = storedThread();
				created = {
					...base,
					turns: input.turns.map((turn, index) => ({
						...base.turns[index],
						...turn,
					})),
				} as ReturnType<typeof storedThread>;
				return created;
			},
		} as never,
		memoryStore: {
			async load() {
				return [
					{ role: "user", content: "question" },
					{ role: "assistant", content: "answer", provenance: marker },
					{ role: "assistant", content: "", history_boundary: true },
				];
			},
			async append() {
				throw new Error("archive must not rewrite memory");
			},
		},
		citationAuthorizer: {
			filterAuthorized: async ({ citations }) => citations,
		},
	});
	assert.equal(response?.status, 200);
	const body = await response?.json();
	assert.equal(body.turns[0].answer, "answer");
	assert.doesNotMatch(
		JSON.stringify(body),
		/history_boundary|memory_provenance/,
	);
	assert.ok(created);
	assert.deepEqual(
		await authorizeArchivedHistory({
			identity,
			libraryId: LIBRARY_ID,
			turns: created.turns,
			citationAuthorizer: {
				filterAuthorized: async ({ citations }) => citations,
			},
		}),
		{ messages: [], sourceReferences: [] },
	);
});

test("archive recovers a pending choice only from the exact latest server exchange", async () => {
	const { handleNativeConversationRequest } = await handlerModule;
	const pending = {
		version: 1 as const,
		question: "when does it start?",
		candidates: ["A", "B"],
		createdAt: Date.now(),
		expiresAt: Date.now() + 60_000,
	};
	const marker = {
		version: 1 as const,
		libraryId: LIBRARY_ID,
		sourceReferences: [
			{
				doc_id: "document-a",
				document_version_id: VERSION_ID,
				generation_id: GENERATION_ID,
			},
		],
	};
	for (const answer of ["choose A or B", "edited choice"]) {
		let saved: Record<string, unknown> | undefined;
		const response = await handleNativeConversationRequest({
			request: new Request("http://local/v1/threads", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					session_id: "pending-session",
					library_id: LIBRARY_ID,
					turns: [
						{
							question: pending.question,
							answer,
							citations: [],
							retrieval_debug: {
								pending_clarification: { ...pending, candidates: ["forged"] },
							},
						},
					],
				}),
			}),
			path: ["v1", "threads"],
			identity,
			repository: {
				async createThreadWithTurns(
					_scope: unknown,
					input: { turns: { debug?: Record<string, unknown> }[] },
				) {
					const base = storedThread();
					const turns = input.turns.map((turn, index) => ({
						...base.turns[index % 2],
						...turn,
					}));
					saved = input.turns[1]?.debug;
					return { ...base, turns };
				},
			} as never,
			memoryStore: {
				async load() {
					return [
						{ role: "user" as const, content: pending.question },
						{
							role: "assistant" as const,
							content: "choose A or B",
							provenance: marker,
							pending_clarification: pending,
						},
					];
				},
				async append() {
					throw new Error("not expected");
				},
			},
			citationAuthorizer: {
				filterAuthorized: async ({ citations }) => citations,
			},
		});
		assert.equal(response?.status, 200);
		assert.deepEqual(
			saved?.pending_clarification,
			answer === "choose A or B" ? pending : undefined,
		);
		assert.equal(
			JSON.stringify(await response?.json()).includes("pending_clarification"),
			false,
		);
	}
});

for (const expired of [false, true]) {
	test(`archive never promotes an ${expired ? "expired" : "unexpired"} old clarification into reusable history`, async () => {
		const { handleNativeConversationRequest } = await handlerModule;
		const { authorizeArchivedHistory } = await import(
			"../../src/server/http/ask/authorized-history"
		);
		const now = Date.now();
		const pending = {
			version: 1 as const,
			question: "when does it start?",
			candidates: ["A", "B"],
			createdAt: expired ? now - 120_000 : now,
			expiresAt: expired ? now - 60_000 : now + 60_000,
		};
		const marker = {
			version: 1 as const,
			libraryId: LIBRARY_ID,
			sourceReferences: [
				{
					doc_id: "document-a",
					document_version_id: VERSION_ID,
					generation_id: GENERATION_ID,
				},
			],
		};
		let saved: {
			role: string;
			content: string;
			status: string;
			debug?: Record<string, unknown> | null;
		}[] = [];
		const response = await handleNativeConversationRequest({
			request: new Request("http://local/v1/threads", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					session_id: "pending-session",
					library_id: LIBRARY_ID,
					turns: [
						{
							question: pending.question,
							answer: "choose A or B",
							retrieval_debug: {
								pending_clarification: {
									...pending,
									createdAt: now,
									expiresAt: now + 60_000,
								},
								memory_provenance: marker,
							},
						},
					],
				}),
			}),
			path: ["v1", "threads"],
			identity,
			repository: {
				async createThreadWithTurns(
					_scope: unknown,
					input: {
						turns: {
							role: string;
							content: string;
							debug?: Record<string, unknown>;
						}[];
					},
				) {
					const base = storedThread();
					const turns = input.turns.map((turn, index) => ({
						...base.turns[index % 2],
						...turn,
					}));
					saved = turns;
					return { ...base, turns };
				},
			} as never,
			memoryStore: {
				load: async () => [
					{ role: "user", content: pending.question },
					{
						role: "assistant",
						content: "choose A or B",
						provenance: marker,
						pending_clarification: pending,
					},
					{ role: "user", content: "new question" },
					{ role: "assistant", content: "new answer", provenance: marker },
				],
				append: async () => {
					throw new Error("archive must not rewrite memory");
				},
			},
			citationAuthorizer: {
				filterAuthorized: async ({ citations }) => citations,
			},
		});
		assert.equal(response?.status, 200);
		assert.equal(saved[1]?.debug?.memory_provenance, null);
		assert.equal(saved[1]?.debug?.pending_clarification, undefined);
		const payload = await response?.json();
		assert.equal(payload.turns[0].answer, "choose A or B");
		assert.doesNotMatch(
			JSON.stringify(payload),
			/pending_clarification|memory_provenance/,
		);
		assert.deepEqual(
			await authorizeArchivedHistory({
				identity,
				libraryId: LIBRARY_ID,
				turns: saved,
				citationAuthorizer: {
					filterAuthorized: async ({ citations }) => citations,
				},
			}),
			{ messages: [], sourceReferences: [] },
		);
	});
}

test("unavailable server memory fails archiving before any database write", async () => {
	const { handleNativeConversationRequest } = await handlerModule;
	let writes = 0;
	const response = await handleNativeConversationRequest({
		request: new Request("http://local/v1/threads", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				session_id: "session-a",
				library_id: LIBRARY_ID,
				turns: [{ question: "question", answer: "answer" }],
			}),
		}),
		path: ["v1", "threads"],
		identity,
		repository: {
			async createThreadWithTurns() {
				writes++;
				throw new Error("must not write");
			},
		} as never,
		memoryStore: {
			async load() {
				throw new Error("private Redis connection details");
			},
			async append() {},
		},
		citationAuthorizer: {
			filterAuthorized: async ({ citations }) => citations,
		},
	});
	assert.equal(response?.status, 503);
	assert.deepEqual(await response?.json(), {
		detail: "conversation service unavailable",
	});
	assert.equal(writes, 0);
});

test("default authorizer accepts only the current active version and current ACL", async () => {
	const { DrizzleHistoricalCitationAuthorizer } = await handlerModule;
	const authorizer = new DrizzleHistoricalCitationAuthorizer(
		queryRows([
			{
				documentUuid: "99999999-9999-4999-8999-999999999999",
				documentId: "document-a",
				documentVersionId: VERSION_ID,
				generationId: GENERATION_ID,
				subjectType: "principal",
				subjectId: PRINCIPAL_ID,
			},
		]) as never,
	);
	const allowed = citation();
	const oldVersion = citation({
		id: "old-version",
		document_version_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	});
	const oldGeneration = citation({
		id: "old-generation",
		generation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	});
	const foreignScope = citation({
		id: "foreign-scope",
		workspace_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	});

	const result = await authorizer.filterAuthorized({
		identity,
		libraryId: LIBRARY_ID,
		citations: [allowed, oldVersion, oldGeneration, foreignScope],
	});
	assert.deepEqual(result, [allowed]);
});

test("default authorizer fails closed after ACL revocation", async () => {
	const { DrizzleHistoricalCitationAuthorizer } = await handlerModule;
	const authorizer = new DrizzleHistoricalCitationAuthorizer(
		queryRows([
			{
				documentUuid: "99999999-9999-4999-8999-999999999999",
				documentId: "document-a",
				documentVersionId: VERSION_ID,
				generationId: GENERATION_ID,
				subjectType: "principal",
				subjectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			},
		]) as never,
	);
	assert.deepEqual(
		await authorizer.filterAuthorized({
			identity,
			libraryId: LIBRARY_ID,
			citations: [citation()],
		}),
		[],
	);
});

test("default authorizer keeps workspace-visible citations with no ACL rows", async () => {
	const { DrizzleHistoricalCitationAuthorizer } = await handlerModule;
	const authorizer = new DrizzleHistoricalCitationAuthorizer(
		queryRows([
			{
				documentUuid: "99999999-9999-4999-8999-999999999999",
				documentId: "document-a",
				documentVersionId: VERSION_ID,
				generationId: GENERATION_ID,
				subjectType: null,
				subjectId: null,
			},
		]) as never,
	);
	const allowed = citation();
	assert.deepEqual(
		await authorizer.filterAuthorized({
			identity,
			libraryId: LIBRARY_ID,
			citations: [allowed],
		}),
		[allowed],
	);
});

test("scope-mismatched citations are rejected before querying storage", async () => {
	const { DrizzleHistoricalCitationAuthorizer } = await handlerModule;
	let queryCalls = 0;
	const authorizer = new DrizzleHistoricalCitationAuthorizer({
		select() {
			queryCalls += 1;
			throw new Error("must not query");
		},
	} as never);

	assert.deepEqual(
		await authorizer.filterAuthorized({
			identity,
			libraryId: LIBRARY_ID,
			citations: [
				citation({ document_version_id: "not-a-uuid" }),
				citation({
					tenant_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
				}),
			],
		}),
		[],
	);
	assert.equal(queryCalls, 0);
});

test("thread list endpoint supports server-side search, library filter, keyset cursor, and paginated envelope", async () => {
	const {
		decodeThreadCursor,
		encodeThreadCursor,
		handleNativeConversationRequest,
	} = await handlerModule;
	const baseThread = storedThread();
	const secondThread = {
		...baseThread,
		id: "44444444-4444-4444-8444-444444444445",
		title: "Second archived policy",
		updatedAt: new Date("2026-07-29T00:00:00.000Z"),
		createdAt: new Date("2026-07-29T00:00:00.000Z"),
	};
	const thirdThread = {
		...baseThread,
		id: "44444444-4444-4444-8444-444444444446",
		title: "Third archived policy",
		updatedAt: new Date("2026-07-28T00:00:00.000Z"),
		createdAt: new Date("2026-07-28T00:00:00.000Z"),
	};

	const observedInputs: Array<Record<string, unknown>> = [];
	const repository = {
		async getThread() {
			return null;
		},
		async listThreads(
			_scope: ConversationScope,
			input: Record<string, unknown>,
		) {
			observedInputs.push(input);
			return [baseThread, secondThread, thirdThread].slice(
				0,
				Number(input.limit ?? 50),
			);
		},
		async countThreads() {
			return 3;
		},
	};
	const turnCounter = {
		async countAssistantTurns() {
			return new Map([
				[baseThread.id, 2],
				[secondThread.id, 1],
			]);
		},
	};
	const citationAuthorizer = {
		async filterAuthorized() {
			throw new Error("thread list must not authorize citations");
		},
	};

	// Paginated request fetches limit + 1, returns next_cursor & has_more.
	const response = await handleNativeConversationRequest({
		request: new Request(
			"http://local/v1/threads?paginated=1&limit=2&q=policy&library_id=__unlinked__",
			{ method: "GET" },
		),
		path: ["v1", "threads"],
		identity,
		repository: repository as never,
		citationAuthorizer,
		turnCounter,
	});
	assert.equal(response?.status, 200);
	const page = (await response?.json()) as {
		items: Array<{ id: string; turn_count: number }>;
		has_more: boolean;
		next_cursor: string | null;
		total: number | null;
	};
	assert.equal(page.has_more, true);
	assert.equal(page.total, 3);
	assert.deepEqual(
		page.items.map((item) => item.id),
		[baseThread.id, secondThread.id],
	);
	assert.ok(page.next_cursor);
	const decoded = decodeThreadCursor(page.next_cursor);
	assert.equal(decoded.id, secondThread.id);
	assert.equal(decoded.updatedAt, secondThread.updatedAt.toISOString());
	assert.deepEqual(observedInputs[0], {
		limit: 3,
		query: "policy",
		libraryId: null,
		cursor: undefined,
	});

	// Cursor preserves full PostgreSQL 6-digit microsecond precision end-to-end.
	const microsecondCursor = encodeThreadCursor({
		...secondThread,
		cursorUpdatedAt: "2026-07-29T00:00:00.123456Z",
		cursorCreatedAt: "2026-07-29T00:00:00.654321Z",
	});
	assert.deepEqual(decodeThreadCursor(microsecondCursor), {
		updatedAt: "2026-07-29T00:00:00.123456Z",
		createdAt: "2026-07-29T00:00:00.654321Z",
		id: secondThread.id,
	});

	// Max page size (limit=200) peeks 201 rows so has_more is true when 201 exist.
	const bulkThreads = Array.from({ length: 201 }, (_, index) => ({
		...baseThread,
		id: `44444444-4444-4444-8444-${String(index + 1).padStart(12, "0")}`,
	}));
	let maxPageObservedLimit = 0;
	const maxPageResponse = await handleNativeConversationRequest({
		request: new Request("http://local/v1/threads?paginated=1&limit=200", {
			method: "GET",
		}),
		path: ["v1", "threads"],
		identity,
		repository: {
			...repository,
			async listThreads(
				_scope: ConversationScope,
				input: Record<string, unknown>,
			) {
				maxPageObservedLimit = Number(input.limit ?? 0);
				return bulkThreads.slice(0, maxPageObservedLimit);
			},
			async countThreads() {
				return 201;
			},
		} as never,
		citationAuthorizer,
		turnCounter: {
			async countAssistantTurns() {
				return new Map();
			},
		},
	});
	assert.equal(maxPageResponse?.status, 200);
	assert.equal(maxPageObservedLimit, 201);
	const maxPageBody = (await maxPageResponse?.json()) as {
		items: Array<{ id: string }>;
		has_more: boolean;
		next_cursor: string | null;
		total: number | null;
	};
	assert.equal(maxPageBody.items.length, 200);
	assert.equal(maxPageBody.total, 201);
	assert.equal(maxPageBody.has_more, true);
	assert.ok(maxPageBody.next_cursor);

	// Round-trip cursor works and malformed cursor fails closed with 400.
	const validCursor = encodeThreadCursor(secondThread);
	const secondPage = await handleNativeConversationRequest({
		request: new Request(
			`http://local/v1/threads?paginated=1&limit=2&cursor=${encodeURIComponent(validCursor)}`,
			{ method: "GET" },
		),
		path: ["v1", "threads"],
		identity,
		repository: repository as never,
		citationAuthorizer,
		turnCounter,
	});
	assert.equal(secondPage?.status, 200);
	assert.equal(
		(observedInputs[1]?.cursor as { id?: string } | undefined)?.id,
		secondThread.id,
	);

	const invalidCursor = await handleNativeConversationRequest({
		request: new Request(
			"http://local/v1/threads?paginated=1&cursor=not-valid-base64-json",
			{ method: "GET" },
		),
		path: ["v1", "threads"],
		identity,
		repository: repository as never,
		citationAuthorizer,
		turnCounter,
	});
	assert.equal(invalidCursor?.status, 400);

	// Legacy unpaginated request keeps plain array response shape.
	const legacy = await handleNativeConversationRequest({
		request: new Request("http://local/v1/threads?limit=2", { method: "GET" }),
		path: ["v1", "threads"],
		identity,
		repository: repository as never,
		citationAuthorizer,
		turnCounter,
	});
	assert.equal(legacy?.status, 200);
	assert.equal(Array.isArray(await legacy?.json()), true);
});
