import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import type {
	InternalCitation,
	RetrievalResult,
} from "../../src/core/retrieval";
import { UNORAG_QDRANT_PAYLOAD_INDEXES } from "../../src/core/retrieval/qdrant/collection-manager";
import {
	buildScopedRetrievalCacheKey,
	ScopedRetrievalCache,
} from "../../src/core/retrieval/retrieval-cache";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import type { AuthenticatedServiceKey } from "../../src/lib/server/service-keys";
import {
	askRetrievalOptions,
	NativeAskPolicySchema,
} from "../../src/server/http/ask/policy";
import type { NativeRetrievalDependencies } from "../../src/server/http/retrieval/service";
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

nodeModule._resolveFilename = (request, parent, isMain, options) =>
	request === "server-only"
		? inertServerOnlyModule
		: originalResolveFilename(request, parent, isMain, options);

const protectedModules = Promise.all([
	import("../../src/server/http/retrieval/native-handler"),
	import("../../src/lib/server/integration-rag"),
	import("../../src/server/retrieval/runtime"),
]).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});
const handlerModule = protectedModules.then(([handler]) => handler);
const integrationModule = protectedModules.then(
	([, integration]) => integration,
);
const retrievalRuntime = protectedModules.then(([, , runtime]) => runtime);

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL_ID = "33333333-3333-4333-8333-333333333333";
const GENERATION_ID = "44444444-4444-4444-8444-444444444444";
const LIBRARY_ID = "library-1";

test("native hybrid defaults to on, honors deployment and request opt-outs, and falls back to authorized dense", async (t) => {
	const {
		getTypeScriptRetrievalService,
		resetTypeScriptRetrievalServiceForTests,
	} = await retrievalRuntime;
	const environment = {
		LLM_API_KEY: "runtime-test-credential",
		LLM_BASE_URL: "https://embedding.example/v1",
		QDRANT_URL: "http://qdrant.example",
		QDRANT_COLLECTION: "runtime-test",
		EMBEDDING_DIM: "2",
		TS_RETRIEVAL_HYBRID_ENABLED: undefined,
		RETRIEVAL_CACHE_TTL_MS: "0",
	};
	const previous = Object.keys(environment).map(
		(name) => [name, process.env[name]] as const,
	);
	const setEnv = (name: string, value: string | undefined) => {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	};
	t.after(() => {
		resetTypeScriptRetrievalServiceForTests();
		for (const [name, value] of previous) setEnv(name, value);
	});
	for (const [name, value] of Object.entries(environment)) setEnv(name, value);

	const queries: { prefetch?: { filter: unknown }[]; filter: unknown }[] = [];
	const unexpected: string[] = [];
	let hybridFails = false;
	t.mock.method(
		globalThis,
		"fetch",
		async (input: string | URL, init: RequestInit) => {
			const { pathname } = new URL(input);
			switch (pathname) {
				case "/":
					return Response.json({ version: "1.19.0" });
				case "/v1/embeddings":
					return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
				case "/collections/runtime-test/exists":
					return Response.json({ result: { exists: true } });
				case "/collections/runtime-test":
					return Response.json({
						result: {
							config: {
								params: {
									vectors: { dense: { size: 2, distance: "Cosine" } },
									sparse_vectors: { lexical_v1: { modifier: "idf" } },
								},
							},
							payload_schema: Object.fromEntries(
								UNORAG_QDRANT_PAYLOAD_INDEXES.map(({ fieldName }) => [
									fieldName,
									{ data_type: "keyword" },
								]),
							),
						},
					});
				case "/collections/runtime-test/points/query": {
					const query = JSON.parse(
						String(init.body),
					) as (typeof queries)[number];
					queries.push(query);
					if (query.prefetch && hybridFails) {
						return Response.json(
							{ status: { error: "temporary failure" } },
							{ status: 503 },
						);
					}
					return Response.json({ result: { points: [] } });
				}
				default:
					unexpected.push(pathname);
					return Response.json({}, { status: 404 });
			}
		},
	);
	const input = {
		query: "working policy",
		libraryId: LIBRARY_ID,
		scope: {
			organizationId: ORGANIZATION_ID,
			workspaceId: WORKSPACE_ID,
			libraryIds: [LIBRARY_ID],
			principalIds: [PRINCIPAL_ID],
			groupIds: ["group-1"],
			activeGenerationIds: [GENERATION_ID],
		},
		topK: 2,
	};
	const policy = NativeAskPolicySchema.parse({});
	assert.equal(policy.hybrid_enabled, true);
	assert.equal(policy.rerank_enabled, false);
	const service = getTypeScriptRetrievalService();
	const hybrid = await service.retrieve(input);
	assert.equal(hybrid.debug.retrievalMode, "hybrid");
	assert.equal(hybrid.debug.usedRerank, false);

	queries.length = 0;
	hybridFails = true;
	const fallback = await service.retrieve({
		...input,
		options: askRetrievalOptions(policy, false),
	});
	assert.equal(fallback.debug.retrievalMode, "dense");
	assert.equal(fallback.debug.hybridFailed, true);
	assert.ok(queries[0].filter);
	assert.deepEqual(queries[1].filter, queries[0].filter);
	assert.deepEqual(
		queries[1].prefetch?.map(({ filter }) => filter),
		[queries[0].filter, queries[0].filter],
	);

	queries.length = 0;
	const workspaceOff = NativeAskPolicySchema.parse({
		hybrid_enabled: false,
	});
	const workspaceDense = await service.retrieve({
		...input,
		options: askRetrievalOptions(workspaceOff, true),
	});
	assert.equal(workspaceDense.debug.hybridEnabled, false);
	assert.equal(queries.length, 1);
	assert.equal(queries[0].prefetch, undefined);

	for (const disabled of ["false", "0"]) {
		queries.length = 0;
		setEnv("TS_RETRIEVAL_HYBRID_ENABLED", disabled);
		resetTypeScriptRetrievalServiceForTests();
		const dense = await getTypeScriptRetrievalService().retrieve({
			...input,
			options: askRetrievalOptions(policy, false),
		});
		assert.equal(dense.debug.hybridEnabled, false);
		assert.equal(dense.debug.retrievalMode, "dense");
		assert.equal(queries.length, 1);
		assert.equal(queries[0].prefetch, undefined);
	}
	assert.deepEqual(unexpected, []);
});

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

test("public ask sanitizes native authorization denials and preserves retryable failures", async (t) => {
	const { forwardIntegrationRag } = await integrationModule;
	const key: AuthenticatedServiceKey = {
		id: "service-key-ask-errors",
		organizationId: ORGANIZATION_ID,
		workspaceId: WORKSPACE_ID,
		name: "Ask integration",
		prefix: "mk_svc_ask_errors",
		scopes: ["ask"],
		libraryIds: null,
		createdBy: null,
		revokedAt: null,
		lastUsedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		principalId: "service:service-key-ask-errors",
	};
	for (const [status, publicStatus, code, message, retryable] of [
		[
			401,
			401,
			"authentication_failed",
			"invalid or revoked service key",
			false,
		],
		[
			403,
			403,
			"library_access_denied",
			"library_id not allowed for this service key",
			false,
		],
		[500, 502, "upstream_unavailable", "RAG data plane unavailable", true],
		[502, 502, "upstream_unavailable", "RAG data plane unavailable", true],
		[
			503,
			503,
			"service_unavailable",
			"Knowledge service is temporarily unavailable",
			true,
		],
		[504, 504, "upstream_timeout", "Knowledge API request timed out", true],
	] as const) {
		await t.test(`native HTTP ${status}`, async () => {
			const requestId = `public-ask-error-${status}`;
			const response = await forwardIntegrationRag({
				request: retrieveRequest({ question: "q", library_id: LIBRARY_ID }),
				key,
				target: "/v1/ask",
				requestId,
				askHandler: async () =>
					Response.json(
						{
							detail: {
								message: "foreign workspace secret",
								error_code: "internal",
							},
						},
						{ status },
					),
			});
			assert.equal(response.status, publicStatus);
			assert.equal(response.headers.get("x-request-id"), requestId);
			assert.equal(response.headers.get("x-unorag-api-version"), "1");
			assert.equal(response.headers.get("cache-control"), "no-store");
			assert.equal(
				response.headers.get("www-authenticate"),
				status === 401 ? "Bearer" : null,
			);
			assert.deepEqual(await response.json(), {
				error: { code, message, request_id: requestId, retryable },
			});
		});
	}
});

test("public ask masks a foreign library as access denied", async () => {
	const { forwardIntegrationRag } = await integrationModule;
	const key: AuthenticatedServiceKey = {
		id: "service-key-ask-foreign",
		organizationId: ORGANIZATION_ID,
		workspaceId: WORKSPACE_ID,
		name: "Ask integration",
		prefix: "mk_svc_ask_foreign",
		scopes: ["ask"],
		libraryIds: null,
		createdBy: null,
		revokedAt: null,
		lastUsedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		principalId: "service:service-key-ask-foreign",
	};
	const originalInfo = console.info;
	console.info = () => undefined;
	try {
		const response = await forwardIntegrationRag({
			request: retrieveRequest({
				question: "foreign library",
				library_id: "foreign-library",
			}),
			key,
			target: "/v1/ask",
			requestId: "public-ask-foreign",
			askHandler: async () =>
				Response.json({ detail: "library not found" }, { status: 404 }),
		});

		assert.equal(response.status, 403);
		const body = (await response.json()) as {
			error?: { code?: string; retryable?: boolean };
		};
		assert.equal(body.error?.code, "library_access_denied");
		assert.equal(body.error?.retryable, false);
	} finally {
		console.info = originalInfo;
	}
});

test("public Ask counts Judge unavailability as a service error, not a knowledge refusal", async () => {
	const { forwardIntegrationRag } = await integrationModule;
	resetPrometheusMetricsForTests();
	const key: AuthenticatedServiceKey = {
		id: "service-key-judge",
		organizationId: ORGANIZATION_ID,
		workspaceId: WORKSPACE_ID,
		name: "Ask integration",
		prefix: "test_key",
		scopes: ["ask"],
		libraryIds: [LIBRARY_ID],
		createdBy: null,
		revokedAt: null,
		lastUsedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		principalId: "service:service-key-judge",
	};
	const originalInfo = console.info;
	console.info = () => undefined;
	try {
		const response = await forwardIntegrationRag({
			request: retrieveRequest({ question: "问题", library_id: LIBRARY_ID }),
			key,
			target: "/v1/ask",
			requestId: "public-judge-failure",
			askHandler: async () =>
				Response.json({
					session_id: "test",
					question: "问题",
					answer: "证据校验服务暂不可用",
					refused: true,
					refuse_reason: "judge_unavailable",
					citations: [],
				}),
		});
		assert.equal(response.status, 200);
		assert.equal((await response.json()).refuse_reason, "judge_unavailable");
		const metrics = renderPrometheusMetrics();
		assert.match(
			metrics,
			/unorag_web_requests_total\{operation="ask",outcome="server_error"\} 1/,
		);
		assert.doesNotMatch(
			metrics,
			/unorag_web_requests_total\{operation="ask",outcome="refused"/,
		);
	} finally {
		console.info = originalInfo;
	}
});

test("retrieval cache key changes when aclRevision changes on identical active generations", () => {
	const baseInput = {
		query: "annual leave policy",
		libraryId: LIBRARY_ID,
		scope: {
			organizationId: ORGANIZATION_ID,
			workspaceId: WORKSPACE_ID,
			libraryIds: [LIBRARY_ID],
			principalIds: [PRINCIPAL_ID],
			groupIds: ["group-1"],
			activeGenerationIds: [GENERATION_ID],
			aclRevision: "rev-before-revocation",
		},
		topK: 5,
		filters: {},
		options: {
			hybridEnabled: true,
			rerankEnabled: false,
			rerankTopK: 10,
			bm25TopK: 10,
			rrfK: 60,
		},
	};
	const cache = new ScopedRetrievalCache({ ttlMs: 30_000, maxEntries: 16 });
	const beforeKey = buildScopedRetrievalCacheKey(baseInput);
	const afterKey = buildScopedRetrievalCacheKey({
		...baseInput,
		scope: {
			...baseInput.scope,
			aclRevision: "rev-after-revocation",
		},
	});
	assert.notEqual(beforeKey, afterKey);
	cache.set(beforeKey, retrievalResult());
	assert.ok(cache.get(beforeKey));
	assert.equal(cache.get(afterKey), null);
});

test("native retrieve enforces final delivery identity, library, and active citation authorization", async () => {
	const { handleNativeRetrievalRequest } = await handlerModule;
	const kept = citation();
	const revoked: InternalCitation = {
		...citation(),
		id: "point-revoked",
		index: 2,
		doc_id: "document-revoked",
		title: "Restricted memo",
		snippet: "Top secret revoked memo",
		text: "Top secret revoked memo",
		body: "Top secret revoked memo",
	};

	const baseDeps = (): NativeRetrievalDependencies => ({
		resolver: {
			async resolve() {
				return {
					libraryId: LIBRARY_ID,
					generationIds: [GENERATION_ID],
					aclRevision: "rev-1",
					resolvedAt: new Date(),
				};
			},
		},
		retrieval: {
			async retrieve() {
				return retrievalResult([revoked, kept]);
			},
		},
		resolveLibrary: (async () => ({
			id: "lib-row-1",
		})) as unknown as NonNullable<
			NativeRetrievalDependencies["resolveLibrary"]
		>,
	});

	// 1. Batch citation re-authorization filters out revoked citations and re-indexes survivors.
	let observedVersionPolicy: string | undefined;
	const partial = await handleNativeRetrievalRequest({
		request: retrieveRequest({ query: "leave", library_id: LIBRARY_ID }),
		path: ["v1", "retrieve"],
		identity,
		requestId: "req-partial",
		refreshIdentity: async () => identity,
		dependencies: {
			...baseDeps(),
			citationAuthorizer: {
				async filterAuthorized(input) {
					observedVersionPolicy = input.versionPolicy;
					return input.citations.filter((c) => c.doc_id === "document-1");
				},
			},
		},
	});
	assert.equal(partial?.status, 200);
	assert.equal(observedVersionPolicy, "active");
	const partialBody = (await partial?.json()) as {
		refused: boolean;
		refuse_reason: string | null;
		citations: Array<Record<string, unknown>>;
	};
	assert.equal(partialBody.refused, false);
	assert.equal(partialBody.citations.length, 1);
	assert.equal(partialBody.citations[0]?.doc_id, "document-1");
	assert.equal(partialBody.citations[0]?.index, 1);

	// 2. When all citations are revoked before delivery, returns empty refused response.
	const allRevoked = await handleNativeRetrievalRequest({
		request: retrieveRequest({ query: "leave", library_id: LIBRARY_ID }),
		path: ["v1", "retrieve"],
		identity,
		requestId: "req-all-revoked",
		refreshIdentity: async () => identity,
		dependencies: {
			...baseDeps(),
			citationAuthorizer: {
				async filterAuthorized() {
					return [];
				},
			},
		},
	});
	assert.equal(allRevoked?.status, 200);
	const allRevokedBody = (await allRevoked?.json()) as {
		refused: boolean;
		refuse_reason: string | null;
		citations: Array<Record<string, unknown>>;
	};
	assert.equal(allRevokedBody.refused, true);
	assert.equal(allRevokedBody.refuse_reason, "no_matching_evidence");
	assert.deepEqual(allRevokedBody.citations, []);

	// 3. Mutated group membership or revoked session fails closed with 401.
	const revokedGroup = await handleNativeRetrievalRequest({
		request: retrieveRequest({ query: "leave", library_id: LIBRARY_ID }),
		path: ["v1", "retrieve"],
		identity,
		requestId: "req-group-changed",
		refreshIdentity: async () => ({ ...identity, groupIds: [] }),
		dependencies: baseDeps(),
	});
	assert.equal(revokedGroup?.status, 401);

	const revokedSession = await handleNativeRetrievalRequest({
		request: retrieveRequest({ query: "leave", library_id: LIBRARY_ID }),
		path: ["v1", "retrieve"],
		identity,
		requestId: "req-session-revoked",
		refreshIdentity: async () => null,
		dependencies: baseDeps(),
	});
	assert.equal(revokedSession?.status, 401);

	// 4. Library deleted mid-request fails closed with 404.
	const deletedLibrary = await handleNativeRetrievalRequest({
		request: retrieveRequest({ query: "leave", library_id: LIBRARY_ID }),
		path: ["v1", "retrieve"],
		identity,
		requestId: "req-lib-deleted",
		refreshIdentity: async () => identity,
		dependencies: {
			...baseDeps(),
			resolveLibrary: (async () => null) as unknown as NonNullable<
				NativeRetrievalDependencies["resolveLibrary"]
			>,
		},
	});
	assert.equal(deletedLibrary?.status, 404);

	// 5. Public retrieve passes refreshIdentity and maps mid-request revocation to 401.
	const { forwardIntegrationRag } = await integrationModule;
	const serviceKey: AuthenticatedServiceKey = {
		id: "service-key-revoked",
		organizationId: ORGANIZATION_ID,
		workspaceId: WORKSPACE_ID,
		name: "Integration",
		prefix: "mk_svc_rev",
		scopes: ["retrieve"],
		libraryIds: [LIBRARY_ID],
		createdBy: null,
		revokedAt: null,
		lastUsedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		principalId: "service:service-key-revoked",
	};
	let sawRefreshIdentity = false;
	const originalInfo = console.info;
	console.info = () => undefined;
	try {
		const { executeNativeRetrieval } = await import(
			"../../src/server/http/retrieval/service"
		);
		const revokedPublic = await forwardIntegrationRag({
			request: retrieveRequest({ query: "leave", library_id: LIBRARY_ID }),
			key: serviceKey,
			target: "/v1/retrieve",
			requestId: "public-revoked-1",
			retrieveExecutor: async (input) => {
				sawRefreshIdentity = typeof input.refreshIdentity === "function";
				return executeNativeRetrieval({
					...input,
					refreshIdentity: async () => null,
					dependencies: baseDeps(),
				});
			},
		});
		assert.equal(sawRefreshIdentity, true);
		assert.equal(revokedPublic.status, 401);
		assert.equal(revokedPublic.headers.get("www-authenticate"), "Bearer");
		const revokedPublicBody = (await revokedPublic.json()) as {
			error?: { code?: string };
		};
		assert.equal(revokedPublicBody.error?.code, "authentication_failed");
	} finally {
		console.info = originalInfo;
	}
});
