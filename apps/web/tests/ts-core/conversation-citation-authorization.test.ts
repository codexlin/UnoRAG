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
	process.env.UNORAG_ASK_RUNTIME = "typescript";
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
	process.env.UNORAG_ASK_RUNTIME = "typescript";
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
				citation({
					tenant_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
				}),
			],
		}),
		[],
	);
	assert.equal(queryCalls, 0);
});
