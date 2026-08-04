import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	normalizePublicApiRequest,
	normalizeUpstreamError,
	PUBLIC_API_MAX_BODY_BYTES,
	PUBLIC_API_UPSTREAM_TIMEOUT_MS,
	PUBLIC_API_VERSION_BODY,
	PUBLIC_ASK_SUCCESS_KEYS,
	PUBLIC_CITATION_KEYS,
	PUBLIC_RETRIEVE_SUCCESS_KEYS,
	projectPublicApiSuccess,
	publicApiErrorPayload,
	publicSuccessKeySet,
	upstreamErrorMessage,
} from "../src/lib/server/public-api-v1-core.mjs";
import {
	checkPublicApiRateLimit,
	resetPublicApiRateLimitBuckets,
} from "../src/lib/server/public-api-v1-rate-limit.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
	readFileSync(path.join(root, "contracts/public-api-v1.openapi.json"), "utf8"),
);

test("ask contract accepts only the stable public fields", () => {
	assert.deepEqual(
		normalizePublicApiRequest("ask", {
			question: "  What is the leave policy? ",
			library_id: " lib-1 ",
			session_id: " customer-session ",
		}),
		{
			ok: true,
			payload: {
				question: "What is the leave policy?",
				library_id: "lib-1",
				session_id: "customer-session",
			},
		},
	);
	for (const field of ["ask_overrides", "thread_id", "retrieve_top_k"]) {
		const result = normalizePublicApiRequest("ask", {
			question: "q",
			library_id: "lib-1",
			[field]: {},
		});
		assert.equal(result.ok, false);
		assert.equal(result.code, "invalid_request");
		assert.deepEqual(result.details.fields, [field]);
	}
});

test("retrieve normalizes question alias and validates public filters", () => {
	assert.deepEqual(
		normalizePublicApiRequest("retrieve", {
			question: "  evidence ",
			library_id: " lib-1 ",
			top_k: 6,
			filters: {
				doc_id: " doc-1 ",
				record_type: "chunk",
			},
		}),
		{
			ok: true,
			payload: {
				query: "evidence",
				library_id: "lib-1",
				top_k: 6,
				filters: {
					record_type: "chunk",
					doc_id: "doc-1",
				},
			},
		},
	);
	assert.equal(
		normalizePublicApiRequest("retrieve", {
			query: "q",
			library_id: "lib-1",
			ask_overrides: { retrieve_top_k: 50 },
		}).ok,
		false,
	);
	assert.equal(
		normalizePublicApiRequest("retrieve", {
			query: "q",
			library_id: "lib-1",
			top_k: 51,
		}).ok,
		false,
	);
	assert.equal(
		normalizePublicApiRequest("retrieve", {
			query: "q",
			library_id: "lib-1",
			filters: { tenant_id: "other-tenant" },
		}).ok,
		false,
	);
	assert.equal(
		normalizePublicApiRequest("retrieve", {
			query: "primary",
			question: "alias",
			library_id: "lib-1",
		}).ok,
		false,
	);
	for (const nullableField of [
		{ top_k: null },
		{ filters: null },
		{ filters: { doc_id: null } },
	]) {
		assert.equal(
			normalizePublicApiRequest("retrieve", {
				query: "q",
				library_id: "lib-1",
				...nullableField,
			}).ok,
			false,
		);
	}
});

test("public error envelope and upstream mapping are stable", () => {
	assert.deepEqual(
		publicApiErrorPayload({
			code: "invalid_request",
			message: "query is required",
			requestId: "req-1",
			details: { field: "query" },
		}),
		{
			error: {
				code: "invalid_request",
				message: "query is required",
				request_id: "req-1",
				retryable: false,
				details: { field: "query" },
			},
		},
	);
	assert.deepEqual(
		normalizeUpstreamError(503, {
			detail: { error_code: "llm_upstream_unavailable" },
		}),
		{
			status: 503,
			code: "service_unavailable",
			message: "Knowledge service is temporarily unavailable",
			retryable: true,
		},
	);
	assert.deepEqual(
		normalizeUpstreamError(418, { error_code: "internal_name" }),
		{
			status: 502,
			code: "upstream_unavailable",
			message: "RAG data plane unavailable",
			retryable: true,
		},
	);
	assert.equal(
		upstreamErrorMessage(
			{ detail: { message: "model unavailable", reasons: ["secret"] } },
			"fallback",
		),
		"model unavailable",
	);
});

test("success projection exposes stable citations and strips internal debug", () => {
	const projected = projectPublicApiSuccess(
		"ask",
		{
			session_id: "session-1",
			question: "q",
			answer: "a",
			refused: false,
			refuse_reason: null,
			retrieval_mode: "hybrid",
			retrieval_debug: { tenant_id: "tenant-secret" },
			citations: [
				{
					id: "c1",
					index: 1,
					title: "Policy",
					snippet: "Evidence",
					score: 0.9,
					doc_id: "doc-1",
					filename: "policy.pdf",
					page: "p.2",
					text: "full internal chunk",
					body: "full internal body",
					tenant_id: "tenant-secret",
					generation_id: "generation-internal",
					figure_id: "doc-1:figure:1",
				},
			],
		},
		"11111111-1111-4111-8111-111111111111",
	);
	assert.equal(projected.api_version, PUBLIC_API_VERSION_BODY);
	assert.equal(projected.trace_id, "11111111-1111-4111-8111-111111111111");
	assert.equal(projected.citations[0].document_id, "doc-1");
	assert.equal(projected.citations[0].figure_id, "doc-1:figure:1");
	assert.deepEqual(
		Object.keys(projected).sort(),
		[...PUBLIC_ASK_SUCCESS_KEYS].sort(),
	);
	assert.deepEqual(
		Object.keys(projected.citations[0]).sort(),
		[...PUBLIC_CITATION_KEYS].sort(),
	);
	assert.equal("retrieval_debug" in projected, false);
	assert.equal("text" in projected.citations[0], false);
	assert.equal("body" in projected.citations[0], false);
	assert.equal("tenant_id" in projected.citations[0], false);
	assert.equal("generation_id" in projected.citations[0], false);

	const retrieveProjected = projectPublicApiSuccess(
		"retrieve",
		{
			query: "q",
			library_id: "lib-1",
			refused: true,
			refuse_reason: "no_matching_evidence",
			retrieval_mode: "dense",
			citations: [],
		},
		"22222222-2222-4222-8222-222222222222",
	);
	assert.equal(retrieveProjected.api_version, "v1");
	assert.deepEqual(
		Object.keys(retrieveProjected).sort(),
		[...PUBLIC_RETRIEVE_SUCCESS_KEYS].sort(),
	);
	assert.equal(publicSuccessKeySet("retrieve"), PUBLIC_RETRIEVE_SUCCESS_KEYS);
	assert.equal(publicSuccessKeySet("ask"), PUBLIC_ASK_SUCCESS_KEYS);
});

test("OpenAPI artifact matches the enforced v1 surface", () => {
	assert.equal(contract.openapi, "3.1.0");
	assert.equal(contract.info.version, "1.0.0");
	assert.ok(contract.paths["/api/v1/ask"]);
	assert.ok(contract.paths["/api/v1/retrieve"]);
	assert.equal(
		contract.components.schemas.AskRequest.additionalProperties,
		false,
	);
	assert.equal(
		contract.components.schemas.RetrieveRequest.additionalProperties,
		false,
	);
	assert.ok(contract.components.schemas.RetrieveRequest.oneOf);
	assert.equal(
		contract.components.schemas.ResponseBase.properties.api_version.const,
		"v1",
	);
	assert.ok(
		contract.components.schemas.ResponseBase.required.includes("api_version"),
	);
	assert.deepEqual(contract.components.schemas.ErrorCode.enum, [
		"invalid_request",
		"authentication_required",
		"authentication_failed",
		"insufficient_scope",
		"library_access_denied",
		"payload_too_large",
		"unsupported_media_type",
		"rate_limit_exceeded",
		"upstream_unavailable",
		"invalid_upstream_response",
		"service_unavailable",
		"policy_unavailable",
		"authentication_backend_unavailable",
		"gateway_misconfigured",
		"upstream_timeout",
	]);
	assert.equal(
		contract.components.responses.PayloadTooLarge.description.includes(
			String(PUBLIC_API_MAX_BODY_BYTES),
		),
		true,
	);
	assert.equal(PUBLIC_API_UPSTREAM_TIMEOUT_MS, 60_000);
	assert.equal(JSON.stringify(contract).includes("retrieval_debug"), false);
	assert.equal(JSON.stringify(contract).includes("ask_overrides"), false);
});

test("optional process-local rate limit returns frozen 429 shape inputs", () => {
	resetPublicApiRateLimitBuckets();
	const previous = process.env.UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE;
	process.env.UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE = "2";
	try {
		assert.equal(checkPublicApiRateLimit("key-a").ok, true);
		assert.equal(checkPublicApiRateLimit("key-a").ok, true);
		const limited = checkPublicApiRateLimit("key-a");
		assert.equal(limited.ok, false);
		assert.ok(limited.retryAfterSeconds >= 1);
		assert.equal(checkPublicApiRateLimit("key-b").ok, true);
	} finally {
		if (previous === undefined) {
			delete process.env.UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE;
		} else {
			process.env.UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE = previous;
		}
		resetPublicApiRateLimitBuckets();
	}
});

test("gateway enforces request IDs, limits, timeout, audit, and response projection", () => {
	const integration = readFileSync(
		path.join(root, "src/lib/server/integration-rag.ts"),
		"utf8",
	);
	assert.match(integration, /readBodyWithLimit/);
	assert.match(integration, /PUBLIC_API_MAX_BODY_BYTES/);
	assert.match(integration, /PUBLIC_API_UPSTREAM_TIMEOUT_MS/);
	assert.match(integration, /projectPublicApiSuccess/);
	assert.match(integration, /requestId:\s*input\.requestId/);
	assert.match(integration, /checkPublicApiRateLimit/);
	assert.match(integration, /knowledge\.api\.usage/);
	assert.match(integration, /knowledge\.retrieve/);
	assert.match(integration, /knowledge\.ask/);
	assert.match(integration, /handleNativeAskRequest/);
	assert.doesNotMatch(integration, /RAG_API_URL|createInternalRagHeaders/);
});
