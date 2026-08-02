import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import type {
	InternalCitation,
	RetrievalResult,
} from "../../src/core/retrieval";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import type { AuthenticatedServiceKey } from "../../src/lib/server/service-keys";
import type { NativeRetrievalDependencies } from "../../src/server/http/retrieval/service";

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

const handlerModule = import("../../src/server/http/retrieval/native-handler");
const integrationModule = import(
	"../../src/lib/server/integration-rag"
).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL_ID = "33333333-3333-4333-8333-333333333333";
const GENERATION_ID = "44444444-4444-4444-8444-444444444444";
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

function citation(): InternalCitation {
	return {
		id: "point-1",
		index: 1,
		title: "Leave policy",
		page: "2",
		page_start: 2,
		page_end: 2,
		section_path: "Benefits / Leave",
		preamble: "Employee handbook",
		table_id: null,
		headers: [],
		rows: [],
		row_start: null,
		row_end: null,
		table_row_count: null,
		snippet: "Annual leave is ten days.",
		score: 0.91,
		dense_score: 0.91,
		bm25_score: null,
		rrf_score: null,
		used_rerank: false,
		used_hybrid: false,
		text: "Annual leave is ten days.",
		body: "Annual leave is ten days.",
		library_id: LIBRARY_ID,
		doc_id: "document-1",
		chunk_index: 3,
		filename: "handbook.pdf",
		document_version_id: "version-1",
		generation_id: GENERATION_ID,
		tenant_id: ORGANIZATION_ID,
		workspace_id: WORKSPACE_ID,
		record_type: "chunk",
		record_id: "record-1",
		source_chunk_ids: [],
		source_node_ids: [],
	};
}

function retrievalResult(citations = [citation()]): RetrievalResult {
	return {
		citations,
		debug: {
			usedHybrid: false,
			hybridEnabled: true,
			hybridFailed: false,
			hybridError: null,
			usedRerank: false,
			rerankFailed: false,
			retrievalMode: "dense",
			denseHitCount: citations.length,
			activeGenerationCount: 1,
		},
	};
}

function dependencies(input?: {
	scopeMissing?: boolean;
	retrievalError?: Error;
	onRetrieve?: (value: Record<string, unknown>) => void;
}): NativeRetrievalDependencies {
	return {
		resolver: {
			async resolve(scope) {
				assert.deepEqual(scope, {
					organizationId: ORGANIZATION_ID,
					workspaceId: WORKSPACE_ID,
					libraryId: LIBRARY_ID,
				});
				return input?.scopeMissing
					? null
					: {
							libraryId: LIBRARY_ID,
							generationIds: [GENERATION_ID],
							resolvedAt: new Date(),
						};
			},
		},
		retrieval: {
			async retrieve(value) {
				input?.onRetrieve?.(value as unknown as Record<string, unknown>);
				if (input?.retrievalError) throw input.retrievalError;
				return retrievalResult();
			},
		},
	};
}

function retrieveRequest(
	body: Record<string, unknown>,
	method = "POST",
): Request {
	return new Request("http://local/v1/retrieve", {
		method,
		headers: { "content-type": "application/json" },
		body: method === "POST" ? JSON.stringify(body) : undefined,
	});
}

test("workspace native retrieve derives scope and returns a sanitized compatible response", async () => {
	const { handleNativeRetrievalRequest } = await handlerModule;
	let observed: Record<string, unknown> | undefined;
	const response = await handleNativeRetrievalRequest({
		request: retrieveRequest({
			query: " annual leave ",
			library_id: LIBRARY_ID,
			top_k: 3,
			filters: { doc_id: "document-1" },
			ask_overrides: {
				hybrid_enabled: true,
				rerank_enabled: false,
			},
		}),
		path: ["v1", "retrieve"],
		identity,
		requestId: "request-1",
		dependencies: dependencies({
			onRetrieve(value) {
				observed = value;
			},
		}),
	});

	assert.equal(response?.status, 200);
	assert.equal(response?.headers.get("x-request-id"), "request-1");
	assert.ok(observed?.signal instanceof AbortSignal);
	const { signal: _signal, ...observedWithoutSignal } = observed ?? {};
	assert.deepEqual(observedWithoutSignal, {
		query: "annual leave",
		libraryId: LIBRARY_ID,
		scope: {
			organizationId: ORGANIZATION_ID,
			workspaceId: WORKSPACE_ID,
			principalIds: [PRINCIPAL_ID],
			groupIds: ["group-1"],
			libraryIds: [LIBRARY_ID],
			documentIds: undefined,
			activeGenerationIds: [GENERATION_ID],
		},
		topK: 3,
		filters: { doc_id: "document-1" },
		options: { hybridEnabled: true, rerankEnabled: false },
	});
	const body = (await response?.json()) as Record<string, unknown>;
	const citations = body.citations as Array<Record<string, unknown>>;
	assert.equal(body.query, "annual leave");
	assert.equal(body.retrieval_mode, "dense");
	assert.equal(citations[0]?.document_id, "document-1");
	assert.equal(citations[0]?.doc_id, "document-1");
	assert.equal("tenant_id" in (citations[0] ?? {}), false);
	assert.equal("workspace_id" in (citations[0] ?? {}), false);
	assert.equal("generation_id" in (citations[0] ?? {}), false);
	assert.deepEqual(body.retrieval_debug, {
		trace_id: "request-1",
		used_hybrid: false,
		hybrid_enabled: true,
		hybrid_failed: false,
		rerank_failed: false,
		retrieval_mode: "dense",
		dense_hit_count: 1,
		active_generation_count: 1,
	});
});

test("native retrieve fails closed before vector search for invalid or missing scope", async () => {
	const { handleNativeRetrievalRequest } = await handlerModule;
	let calls = 0;
	const invalid = await handleNativeRetrievalRequest({
		request: retrieveRequest({
			query: "secret",
			library_id: LIBRARY_ID,
			tenant_id: "other-tenant",
		}),
		path: ["v1", "retrieve"],
		identity,
		dependencies: dependencies({
			onRetrieve() {
				calls += 1;
			},
		}),
	});
	assert.equal(invalid?.status, 400);

	const missing = await handleNativeRetrievalRequest({
		request: retrieveRequest({
			query: "secret",
			library_id: LIBRARY_ID,
		}),
		path: ["v1", "retrieve"],
		identity,
		dependencies: dependencies({ scopeMissing: true }),
	});
	assert.equal(missing?.status, 404);
	assert.equal(calls, 0);
});

test("native retrieve sanitizes dependency failures and handles its HTTP boundary", async () => {
	const { handleNativeRetrievalRequest } = await handlerModule;
	const originalError = console.error;
	console.error = () => undefined;
	try {
		const failed = await handleNativeRetrievalRequest({
			request: retrieveRequest({
				query: "secret",
				library_id: LIBRARY_ID,
			}),
			path: ["v1", "retrieve"],
			identity,
			dependencies: dependencies({
				retrievalError: new Error("provider key leaked"),
			}),
		});
		assert.equal(failed?.status, 503);
		assert.equal(
			(await failed?.text())?.includes("provider key leaked"),
			false,
		);
	} finally {
		console.error = originalError;
	}

	const method = await handleNativeRetrievalRequest({
		request: retrieveRequest({}, "GET"),
		path: ["v1", "retrieve"],
		identity,
		dependencies: dependencies(),
	});
	assert.equal(method?.status, 405);
	const unrelated = await handleNativeRetrievalRequest({
		request: retrieveRequest({}),
		path: ["v1", "ask"],
		identity,
		dependencies: dependencies(),
	});
	assert.equal(unrelated, null);
});

test("public retrieve keeps the v1 projection and never calls FastAPI", async () => {
	const { forwardIntegrationRag } = await integrationModule;
	const key: AuthenticatedServiceKey = {
		id: "service-key-1",
		organizationId: ORGANIZATION_ID,
		workspaceId: WORKSPACE_ID,
		name: "Integration",
		prefix: "mk_svc_test",
		scopes: ["retrieve"],
		libraryIds: [LIBRARY_ID],
		createdBy: null,
		revokedAt: null,
		lastUsedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		principalId: "service:service-key-1",
	};
	let fetchCalls = 0;
	const originalFetch = globalThis.fetch;
	const originalInfo = console.info;
	globalThis.fetch = (async () => {
		fetchCalls += 1;
		throw new Error("FastAPI must not be called");
	}) as typeof fetch;
	console.info = () => undefined;
	try {
		let executorIdentity: AuthIdentity | undefined;
		const response = await forwardIntegrationRag({
			request: retrieveRequest({
				question: " annual leave ",
				library_id: LIBRARY_ID,
				top_k: 2,
			}),
			key,
			target: "/v1/retrieve",
			requestId: "public-request-1",
			retrieveExecutor: async (input) => {
				executorIdentity = input.identity;
				return {
					query: String((input.payload as Record<string, unknown>).query),
					library_id: LIBRARY_ID,
					citations: [citation()],
					refused: false,
					refuse_reason: null,
					retrieval_mode: "dense",
					retrieval_debug: { internal: true },
				};
			},
		});

		assert.equal(response.status, 200);
		assert.equal(fetchCalls, 0);
		assert.equal(executorIdentity?.tenantId, ORGANIZATION_ID);
		assert.equal(executorIdentity?.workspaceId, WORKSPACE_ID);
		assert.equal(executorIdentity?.principalId, "service:service-key-1");
		assert.equal(response.headers.get("x-request-id"), "public-request-1");
		assert.equal(response.headers.get("x-unorag-api-version"), "1");
		const body = (await response.json()) as Record<string, unknown>;
		const citations = body.citations as Array<Record<string, unknown>>;
		assert.deepEqual(Object.keys(body).sort(), [
			"api_version",
			"citations",
			"library_id",
			"query",
			"refuse_reason",
			"refused",
			"retrieval_mode",
			"trace_id",
		]);
		assert.equal(body.api_version, "v1");
		assert.equal(body.trace_id, "public-request-1");
		assert.equal("retrieval_debug" in body, false);
		assert.equal(citations[0]?.document_id, "document-1");
		assert.equal("text" in (citations[0] ?? {}), false);
		assert.equal("tenant_id" in (citations[0] ?? {}), false);
	} finally {
		globalThis.fetch = originalFetch;
		console.info = originalInfo;
	}
});

test("public ask keeps the v1 projection and never calls FastAPI", async () => {
	const { forwardIntegrationRag } = await integrationModule;
	const key: AuthenticatedServiceKey = {
		id: "service-key-ask",
		organizationId: ORGANIZATION_ID,
		workspaceId: WORKSPACE_ID,
		name: "Ask integration",
		prefix: "mk_svc_ask",
		scopes: ["ask"],
		libraryIds: [LIBRARY_ID],
		createdBy: null,
		revokedAt: null,
		lastUsedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		principalId: "service:service-key-ask",
	};
	let fetchCalls = 0;
	let handlerIdentity: AuthIdentity | undefined;
	const originalFetch = globalThis.fetch;
	const originalInfo = console.info;
	globalThis.fetch = (async () => {
		fetchCalls += 1;
		throw new Error("FastAPI must not be called");
	}) as typeof fetch;
	console.info = () => undefined;
	try {
		const response = await forwardIntegrationRag({
			request: retrieveRequest({
				question: "违约金是多少？",
				library_id: LIBRARY_ID,
				session_id: "public-session",
			}),
			key,
			target: "/v1/ask",
			requestId: "public-ask-request-1",
			askHandler: async (input) => {
				handlerIdentity = input.identity;
				return Response.json({
					session_id: "public-session",
					question: "违约金是多少？",
					answer: "违约金为 200 元",
					refused: false,
					refuse_reason: null,
					retrieval_mode: "dense",
					retrieval_debug: { tenant_id: ORGANIZATION_ID },
					citations: [citation()],
				});
			},
		});

		assert.equal(response.status, 200);
		assert.equal(fetchCalls, 0);
		assert.equal(handlerIdentity?.tenantId, ORGANIZATION_ID);
		assert.equal(handlerIdentity?.workspaceId, WORKSPACE_ID);
		assert.equal(handlerIdentity?.principalId, "service:service-key-ask");
		assert.equal(response.headers.get("x-request-id"), "public-ask-request-1");
		const body = (await response.json()) as Record<string, unknown>;
		assert.equal(body.answer, "违约金为 200 元");
		assert.equal(body.trace_id, "public-ask-request-1");
		assert.equal("retrieval_debug" in body, false);
	} finally {
		globalThis.fetch = originalFetch;
		console.info = originalInfo;
	}
});
