import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import type { AuthorizedScope } from "../../src/core/contracts";
import {
	normalizeRerankResults,
	OpenAICompatibleRerankProvider,
	type RerankProvider,
} from "../../src/core/retrieval/rerank/provider";
import { ScopedRetrievalCache } from "../../src/core/retrieval/retrieval-cache";
import { DefaultRetrievalService } from "../../src/core/retrieval/retrieval-service";
import {
	OrganizationModelPatchSchema,
	type OrganizationModelSettingsView,
} from "../../src/lib/model-settings";
import { probeModelConnection } from "../../src/lib/server/model-connection-probe";
import {
	decryptModelApiKey,
	encryptModelApiKey,
	maskApiKeyHint,
} from "../../src/lib/server/model-settings-crypto";
import {
	assertResolvedModelEndpointSafe,
	assertSafeModelEndpointUrl,
	UnsafeModelEndpointError,
} from "../../src/lib/server/model-settings-url";
import { canManageOrganizationModels } from "../../src/lib/server/organization-permissions.mjs";
import { createOrganizationModelSettingsHandlers } from "../../src/server/http/organization-model-settings";

// `server-only` is a Next.js build boundary marker with no runtime behavior in unit tests.
const origLoad = (
	Module as unknown as {
		_load: (request: string, parent: unknown, isMain: boolean) => unknown;
	}
)._load;
(
	Module as unknown as {
		_load: (request: string, parent: unknown, isMain: boolean) => unknown;
	}
)._load = function patchedLoad(request, parent, isMain) {
	if (request === "server-only") return {};
	return origLoad.call(this, request, parent, isMain);
};

const TEST_ENV: NodeJS.ProcessEnv = {
	NODE_ENV: "test",
	UNORAG_SESSION_SECRET: "test-session-secret-0000000000000000",
};

test("model API key envelope encryption binds organization and slot via AAD and masks hints", () => {
	const raw = "test-model-token-00000000abcd";
	const encrypted = encryptModelApiKey(
		raw,
		{ organizationId: "org-1", slot: "chat" },
		TEST_ENV,
	);
	assert.ok(encrypted.startsWith("v1:"));
	assert.doesNotMatch(encrypted, /test-model-token|00000000abcd/);
	assert.equal(
		decryptModelApiKey(
			encrypted,
			{ organizationId: "org-1", slot: "chat" },
			TEST_ENV,
		),
		raw,
	);

	// Wrong organization or wrong slot must fail GCM AAD authentication.
	assert.throws(() =>
		decryptModelApiKey(
			encrypted,
			{ organizationId: "org-2", slot: "chat" },
			TEST_ENV,
		),
	);
	assert.throws(() =>
		decryptModelApiKey(
			encrypted,
			{ organizationId: "org-1", slot: "rerank" },
			TEST_ENV,
		),
	);

	// Tampered ciphertext must fail authentication.
	const parts = encrypted.split(":");
	parts[3] = `${parts[3].slice(0, -2)}AA`;
	assert.throws(() =>
		decryptModelApiKey(
			parts.join(":"),
			{ organizationId: "org-1", slot: "chat" },
			TEST_ENV,
		),
	);

	assert.equal(maskApiKeyHint(raw), "••••abcd");
	assert.equal(maskApiKeyHint("short"), "••••");
});

test("model endpoint URL guard allows private GPU/LAN hosts and blocks metadata/credential SSRF", () => {
	for (const allowed of [
		"https://api.openai.com/v1/",
		"http://host.docker.internal:8000/v1",
		"http://10.0.1.50:8002/v1/rerank",
		"http://127.0.0.1:11434/v1",
		"http://vllm:8000/v1",
	]) {
		assert.equal(
			assertSafeModelEndpointUrl(allowed),
			allowed.replace(/\/+$/, ""),
		);
	}

	for (const blocked of [
		"http://169.254.169.254/latest/meta-data",
		"http://100.100.100.200/latest/meta-data",
		"http://metadata.google.internal/computeMetadata/v1",
		"http://metadata.tencentyun.com/latest/meta-data",
		"http://0.0.0.0:8000/v1",
		"http://0.1.2.3:8000/v1",
		"http://[::]:8000/v1",
		"http://[fd00:ec2::254]/latest",
		"http://[fe80::1]/v1",
		"http://[fe90::1]/v1",
		"http://[febf::1]/v1",
		"http://[::ffff:169.254.169.254]/latest/meta-data",
		"http://[::ffff:100.100.100.200]/latest/meta-data",
		"http://[::ffff:0.0.0.0]:8000/v1",
		"http://[64:ff9b::169.254.169.254]/latest",
		"https://api.openai.com/v1?foo=bar",
		"https://api.openai.com/v1?",
		"http://qdrant:6333/collections/unorag_chunks/points/delete#",
		"https://user:pass@api.openai.com/v1",
		"file:///etc/passwd",
		"ftp://example.com/v1",
	]) {
		assert.throws(
			() => assertSafeModelEndpointUrl(blocked),
			UnsafeModelEndpointError,
			`expected blocked URL: ${blocked}`,
		);
	}
});

test("assertResolvedModelEndpointSafe blocks hostnames whose DNS resolves to metadata IPs", async () => {
	await assert.rejects(
		() =>
			assertResolvedModelEndpointSafe(
				"http://rebind.attacker.example/v1",
				async () => [{ address: "169.254.169.254" }],
			),
		UnsafeModelEndpointError,
	);
	await assert.rejects(
		() =>
			assertResolvedModelEndpointSafe(
				"http://rebind6.attacker.example/v1",
				async () => [{ address: "::ffff:100.100.100.200" }],
			),
		UnsafeModelEndpointError,
	);
	await assert.doesNotReject(() =>
		assertResolvedModelEndpointSafe(
			"http://vllm.internal:8000/v1",
			async () => [{ address: "10.0.1.50" }],
		),
	);
});

test("model API key crypto fails closed on short dedicated key and supports zero-downtime key rotation", () => {
	const shortEnv: NodeJS.ProcessEnv = {
		...TEST_ENV,
		MODEL_SETTINGS_ENCRYPTION_KEY: "too-short-key",
	};
	assert.throws(
		() =>
			encryptModelApiKey(
				"test-short-token",
				{ organizationId: "org-1", slot: "chat" },
				shortEnv,
			),
		/at least 32 characters/,
	);

	const oldKey = "old-encryption-key-".padEnd(40, "0");
	const newKey = "new-encryption-key-".padEnd(40, "1");
	const encryptedWithOld = encryptModelApiKey(
		"test-rotate-token",
		{ organizationId: "org-1", slot: "chat" },
		{ ...TEST_ENV, MODEL_SETTINGS_ENCRYPTION_KEY: oldKey },
	);
	const rotatedEnv: NodeJS.ProcessEnv = {
		...TEST_ENV,
		MODEL_SETTINGS_ENCRYPTION_KEY: newKey,
		MODEL_SETTINGS_ENCRYPTION_KEY_PREVIOUS: oldKey,
	};
	assert.equal(
		decryptModelApiKey(
			encryptedWithOld,
			{ organizationId: "org-1", slot: "chat" },
			rotatedEnv,
		),
		"test-rotate-token",
	);
});

test("probeModelConnection verifies Chat json_schema support and recommends disabling when unsupported", async () => {
	// Case 1: supports json_schema + usage
	const supported = await probeModelConnection({
		slot: "chat",
		baseUrl: "https://gateway.example/v1",
		apiKey: "test-probe-token",
		model: "qwen-plus",
		fetch: async () =>
			Response.json({
				choices: [{ message: { content: '{"ok":true}' } }],
				usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
			}),
	});
	assert.equal(supported.ok, true);
	assert.equal(supported.checks.connectivity, true);
	assert.equal(supported.checks.structured_outputs, true);
	assert.equal(supported.checks.include_usage, true);
	assert.deepEqual(supported.suggestions, {});

	// Case 2: basic chat succeeds without usage, json_schema rejected with HTTP 400
	let calls = 0;
	const legacy = await probeModelConnection({
		slot: "chat",
		baseUrl: "http://host.docker.internal:11434/v1",
		apiKey: "local-no-auth",
		model: "qwen2.5:7b",
		fetch: async (_url, init) => {
			calls += 1;
			const body = JSON.parse(String(init?.body ?? "{}"));
			if (body.response_format) {
				return new Response("json_schema not supported", { status: 400 });
			}
			return Response.json({
				choices: [{ message: { content: "ok" } }],
			});
		},
	});
	assert.equal(calls, 2);
	assert.equal(legacy.ok, true);
	assert.equal(legacy.checks.structured_outputs, false);
	assert.equal(legacy.checks.include_usage, false);
	assert.deepEqual(legacy.suggestions, {
		supports_structured_outputs: false,
		include_usage: false,
	});
});

test("probeModelConnection auto-discovers singular /rerank when base URL returns 404 on /reranks", async () => {
	const seen: string[] = [];
	const result = await probeModelConnection({
		slot: "rerank",
		baseUrl: "http://host.docker.internal:8002/v1",
		apiKey: "local-no-auth",
		model: "Qwen/Qwen3-Reranker-8B",
		fetch: async (url) => {
			const target = String(url);
			seen.push(target);
			if (target.endsWith("/reranks")) {
				return new Response("not found", { status: 404 });
			}
			return Response.json({
				results: [{ index: 0, relevance_score: 0.96 }],
			});
		},
	});
	assert.deepEqual(seen, [
		"http://host.docker.internal:8002/v1/reranks",
		"http://host.docker.internal:8002/v1/rerank",
	]);
	assert.equal(result.ok, true);
	assert.equal(
		result.resolved_endpoint,
		"http://host.docker.internal:8002/v1/rerank",
	);
	assert.equal(result.checks.rerank_format, "results");
	assert.deepEqual(result.suggestions, {
		base_url: "http://host.docker.internal:8002/v1/rerank",
	});

	// Voyage data[] format on explicit /rerank URL sends top_k (not top_n)
	let voyageBody: Record<string, unknown> = {};
	const voyage = await probeModelConnection({
		slot: "rerank",
		baseUrl: "https://api.voyageai.com/v1/rerank",
		apiKey: "test-voyage-token",
		model: "rerank-2.5",
		fetch: async (_url, init) => {
			voyageBody = JSON.parse(String(init?.body ?? "{}"));
			return Response.json({
				data: [{ index: 0, relevance_score: 0.89 }],
			});
		},
	});
	assert.equal(voyage.ok, true);
	assert.equal(voyage.checks.rerank_format, "data");
	assert.equal(voyageBody.top_k, 1);
	assert.equal("top_n" in voyageBody, false);
	assert.deepEqual(voyage.suggestions, {});

	// When /reranks returns 404 and /rerank returns 401, surface the actionable /rerank auth error
	const authFailure = await probeModelConnection({
		slot: "rerank",
		baseUrl: "http://host.docker.internal:8002/v1",
		apiKey: "bad-key",
		model: "Qwen/Qwen3-Reranker-8B",
		fetch: async (url) => {
			if (String(url).endsWith("/reranks")) {
				return new Response("not found", { status: 404 });
			}
			return new Response("unauthorized", { status: 401 });
		},
	});
	assert.equal(authFailure.ok, false);
	assert.equal(authFailure.category, "auth_error");
	assert.equal(authFailure.status_code, 401);
	assert.equal(
		authFailure.resolved_endpoint,
		"http://host.docker.internal:8002/v1/rerank",
	);

	// Oversized response body (> 256 KB) is capped cleanly as invalid_response
	const oversized = await probeModelConnection({
		slot: "chat",
		baseUrl: "https://gateway.example/v1",
		apiKey: "test-probe-token",
		model: "qwen-plus",
		fetch: async () =>
			new Response("x".repeat(300 * 1024), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	});
	assert.equal(oversized.ok, false);
	assert.equal(oversized.category, "invalid_response");
});

test("rerank provider sorts raw logits before clamping and sends top_k for Voyage", async () => {
	const ranked = normalizeRerankResults(
		[
			{ index: 0, score: 2.1 },
			{ index: 1, score: 8.7 },
			{ index: 2, score: -1.5 },
		],
		3,
	);
	assert.deepEqual(
		ranked.map((r) => r.index),
		[1, 0, 2],
	);
	assert.deepEqual(
		ranked.map((r) => r.score),
		[1, 1, 0],
	);

	let sentPayload: Record<string, unknown> = {};
	let sentRedirect: RequestRedirect | undefined;
	const provider = new OpenAICompatibleRerankProvider({
		apiKey: "test-voyage-token",
		baseUrl: "https://api.voyageai.com/v1/rerank",
		model: "rerank-2.5",
		fetch: async (_url, init) => {
			sentPayload = JSON.parse(String(init?.body ?? "{}"));
			sentRedirect = init?.redirect;
			return Response.json({
				data: [{ index: 0, relevance_score: 0.91 }],
			});
		},
	});
	const res = await provider.rerank({
		query: "q",
		documents: ["doc a"],
		topN: 1,
	});
	assert.equal(res[0]?.index, 0);
	assert.equal(sentPayload.top_k, 1);
	assert.equal("top_n" in sentPayload, false);
	assert.equal(sentRedirect, "error");
});

test("probeModelConnection sends multimodal 1x1 PNG for VLM and never leaks upstream bodies or keys", async () => {
	let receivedBody: Record<string, unknown> = {};
	const vlm = await probeModelConnection({
		slot: "vlm",
		baseUrl: "https://vlm.example/v1",
		apiKey: "test-vlm-token",
		model: "qwen-vl-plus",
		fetch: async (_url, init) => {
			receivedBody = JSON.parse(String(init?.body ?? "{}"));
			return Response.json({
				choices: [{ message: { content: "ok" } }],
			});
		},
	});
	assert.equal(vlm.ok, true);
	assert.equal(vlm.checks.vision, true);
	assert.match(JSON.stringify(receivedBody), /data:image\/png;base64,/);

	const unauthorized = await probeModelConnection({
		slot: "chat",
		baseUrl: "https://gateway.example/v1",
		apiKey: "test-auth-token-0000",
		model: "qwen-plus",
		fetch: async () =>
			new Response("raw provider error test-auth-token-0000", {
				status: 401,
			}),
	});
	assert.equal(unauthorized.ok, false);
	assert.equal(unauthorized.category, "auth_error");
	assert.equal(unauthorized.status_code, 401);
	assert.doesNotMatch(
		JSON.stringify(unauthorized),
		/test-auth-token-0000|raw provider error/,
	);
});

test("organization model settings HTTP handlers enforce owner-only RBAC, same-origin, optimistic version, and lock mode", async () => {
	assert.equal(
		canManageOrganizationModels({ organizationRole: "owner" }),
		true,
	);
	assert.equal(
		canManageOrganizationModels({ organizationRole: "admin" }),
		false,
	);
	assert.equal(
		canManageOrganizationModels({ organizationRole: "member" }),
		false,
	);

	let role = "admin";
	let locked = false;
	const dummyView: OrganizationModelSettingsView = {
		locked: false,
		rerank_allowed: true,
		policy_version: 2,
		updated_at: "2026-11-25T15:00:00.000Z",
		updated_by: "user-1",
		has_overrides: true,
		slots: {
			chat: {
				source: "database",
				base_url: "https://api.example/v1",
				model: "qwen-max",
				provider_name: "openai-compatible",
				supports_structured_outputs: true,
				include_usage: true,
				has_stored_api_key: true,
				has_effective_api_key: true,
				api_key_hint: "••••abcd",
				env_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
				env_model: "qwen-plus",
			},
			judge: {
				source: "inherited",
				inherit_chat: true,
				base_url: "https://api.example/v1",
				model: "qwen-max",
				provider_name: "openai-compatible",
				supports_structured_outputs: true,
				has_stored_api_key: false,
				has_effective_api_key: true,
				api_key_hint: null,
				env_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
				env_model: "qwen-plus",
			},
			rerank: {
				source: "env",
				configured: true,
				base_url: "https://dashscope.aliyuncs.com/compatible-api/v1",
				model: "qwen3-rerank",
				has_stored_api_key: false,
				has_effective_api_key: true,
				api_key_hint: null,
				env_base_url: "https://dashscope.aliyuncs.com/compatible-api/v1",
				env_model: "qwen3-rerank",
			},
			vlm: {
				source: "disabled",
				enabled: false,
				base_url: null,
				model: null,
				provider_name: "openai-compatible",
				has_stored_api_key: false,
				has_effective_api_key: false,
				api_key_hint: null,
				env_enabled: false,
				env_base_url: null,
				env_model: null,
			},
		},
		embedding: {
			locked: true,
			model: "text-embedding-v3",
			dimensions: 1024,
			collection: "unorag_chunks",
			base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		},
	};

	let rateLimited = false;
	const handlers = createOrganizationModelSettingsHandlers({
		resolveIdentity: async () =>
			role === "none"
				? null
				: {
						tenantId: "org-1",
						workspaceId: "ws-1",
						principalId: "user-1",
						organizationRole: role,
					},
		read: async () => ({ ...dummyView, locked }),
		patch: async ({ expectedPolicyVersion }) => {
			if (locked) {
				return {
					ok: false,
					status: 403,
					code: "deployment_locked",
					detail: "locked",
				};
			}
			if (expectedPolicyVersion === 1) {
				return {
					ok: false,
					status: 409,
					code: "version_conflict",
					detail: "conflict",
				};
			}
			return { ok: true, view: dummyView };
		},
		testConnection: async ({ request }) => ({
			ok: true,
			result: {
				ok: true,
				slot: request.slot,
				duration_ms: 42,
				status_code: 200,
				category: "ok",
				resolved_endpoint: "https://api.example/v1/chat/completions",
				checks: {
					connectivity: true,
					structured_outputs: true,
					include_usage: true,
					rerank_format: null,
					vision: null,
				},
				suggestions: {},
				detail: "ok",
			},
		}),
		checkProbeRateLimit: async () =>
			rateLimited
				? { ok: false, retryAfterSeconds: 45 }
				: { ok: true, remaining: 19 },
	});

	// Unauthenticated -> 401
	role = "none";
	assert.equal(
		(
			await handlers.GET(
				new Request("https://console.example/api/organization/model-settings"),
			)
		).status,
		401,
	);

	// Non-owner (admin / member) -> 403 on GET, PATCH, and POST_TEST
	for (const deniedRole of ["admin", "member"]) {
		role = deniedRole;
		assert.equal(
			(
				await handlers.GET(
					new Request(
						"https://console.example/api/organization/model-settings",
					),
				)
			).status,
			403,
		);
		assert.equal(
			(
				await handlers.PATCH(
					new Request(
						"https://console.example/api/organization/model-settings",
						{
							method: "PATCH",
							headers: { origin: "https://console.example" },
							body: JSON.stringify({ models: { chat: { model: "qwen-max" } } }),
						},
					),
				)
			).status,
			403,
		);
		assert.equal(
			(
				await handlers.POST_TEST(
					new Request(
						"https://console.example/api/organization/model-settings/test",
						{
							method: "POST",
							headers: { origin: "https://console.example" },
							body: JSON.stringify({ slot: "chat" }),
						},
					),
				)
			).status,
			403,
		);
	}

	// Owner succeeds on same-origin GET / PATCH / POST_TEST
	role = "owner";
	const getRes = await handlers.GET(
		new Request("https://console.example/api/organization/model-settings"),
	);
	assert.equal(getRes.status, 200);
	assert.equal(getRes.headers.get("cache-control"), "private, no-store");

	// Cross-origin PATCH rejected with 403
	assert.equal(
		(
			await handlers.PATCH(
				new Request("https://console.example/api/organization/model-settings", {
					method: "PATCH",
					headers: { origin: "https://evil.example" },
					body: JSON.stringify({ models: { chat: { model: "qwen-max" } } }),
				}),
			)
		).status,
		403,
	);

	// Non-JSON content-type rejected with 415
	assert.equal(
		(
			await handlers.PATCH(
				new Request("https://console.example/api/organization/model-settings", {
					method: "PATCH",
					headers: {
						origin: "https://console.example",
						"content-type": "text/plain",
					},
					body: JSON.stringify({ models: { chat: { model: "qwen-max" } } }),
				}),
			)
		).status,
		415,
	);

	// Oversized JSON body rejected with 413
	assert.equal(
		(
			await handlers.PATCH(
				new Request("https://console.example/api/organization/model-settings", {
					method: "PATCH",
					headers: {
						origin: "https://console.example",
						"content-type": "application/json",
					},
					body: JSON.stringify({ padding: "a".repeat(70 * 1024) }),
				}),
			)
		).status,
		413,
	);

	// Stale policy_version returns 409 version_conflict
	const conflictRes = await handlers.PATCH(
		new Request("https://console.example/api/organization/model-settings", {
			method: "PATCH",
			headers: {
				origin: "https://console.example",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				models: { chat: { model: "qwen-max" } },
				policy_version: 1,
			}),
		}),
	);
	assert.equal(conflictRes.status, 409);

	// Locked mode returns 403 deployment_locked
	locked = true;
	const lockedRes = await handlers.PATCH(
		new Request("https://console.example/api/organization/model-settings", {
			method: "PATCH",
			headers: {
				origin: "https://console.example",
				"content-type": "application/json",
			},
			body: JSON.stringify({ models: { chat: { model: "qwen-max" } } }),
		}),
	);
	assert.equal(lockedRes.status, 403);
	const lockedJson = (await lockedRes.json()) as { code?: string };
	assert.equal(lockedJson.code, "deployment_locked");

	// Owner probe succeeds
	locked = false;
	const probeRes = await handlers.POST_TEST(
		new Request(
			"https://console.example/api/organization/model-settings/test",
			{
				method: "POST",
				headers: {
					origin: "https://console.example",
					"content-type": "application/json",
				},
				body: JSON.stringify({ slot: "chat" }),
			},
		),
	);
	assert.equal(probeRes.status, 200);

	// Rate-limited probe returns 429 with retry-after
	rateLimited = true;
	const rateRes = await handlers.POST_TEST(
		new Request(
			"https://console.example/api/organization/model-settings/test",
			{
				method: "POST",
				headers: {
					origin: "https://console.example",
					"content-type": "application/json",
				},
				body: JSON.stringify({ slot: "chat" }),
			},
		),
	);
	assert.equal(rateRes.status, 429);
	assert.equal(rateRes.headers.get("retry-after"), "45");
});

test("DefaultRetrievalService hot-swaps rerankerOverride, isolates cache by rerankCacheTag, and clears cache", async () => {
	const scope: AuthorizedScope = {
		organizationId: "org-1",
		workspaceId: "ws-1",
		principalIds: ["user-1"],
		groupIds: [],
		libraryIds: ["lib-1"],
		activeGenerationIds: ["gen-1"],
	};
	const hits = [
		{
			id: "a",
			score: 0.7,
			payload: {
				tenant_id: "org-1",
				workspace_id: "ws-1",
				library_id: "lib-1",
				doc_id: "doc-1",
				document_version_id: "ver-1",
				generation_id: "gen-1",
				lifecycle_visibility: "active" as const,
				acl_scope: "workspace" as const,
				acl_principals: [],
				acl_groups: [],
				record_type: "chunk" as const,
				record_id: "rec-a",
				chunk_index: 0,
				title: "Doc",
				text: "Alpha passage",
				body: "Alpha passage",
				page: null,
				page_start: null,
				page_end: null,
				section_path: null,
				heading_text: null,
				preamble: null,
				table_id: null,
				figure_id: null,
				headers: [],
				rows: [],
				row_start: null,
				row_end: null,
				table_row_count: null,
				filename: "doc.txt",
				source_chunk_ids: [],
				source_node_ids: [],
			},
		},
		{
			id: "b",
			score: 0.65,
			payload: {
				tenant_id: "org-1",
				workspace_id: "ws-1",
				library_id: "lib-1",
				doc_id: "doc-1",
				document_version_id: "ver-1",
				generation_id: "gen-1",
				lifecycle_visibility: "active" as const,
				acl_scope: "workspace" as const,
				acl_principals: [],
				acl_groups: [],
				record_type: "chunk" as const,
				record_id: "rec-b",
				chunk_index: 1,
				title: "Doc",
				text: "Beta passage",
				body: "Beta passage",
				page: null,
				page_start: null,
				page_end: null,
				section_path: null,
				heading_text: null,
				preamble: null,
				table_id: null,
				figure_id: null,
				headers: [],
				rows: [],
				row_start: null,
				row_end: null,
				table_row_count: null,
				filename: "doc.txt",
				source_chunk_ids: [],
				source_node_ids: [],
			},
		},
	];
	let envCalls = 0;
	let overrideCalls = 0;
	const envReranker: RerankProvider = {
		async rerank() {
			envCalls += 1;
			return [
				{ index: 0, score: 0.9 },
				{ index: 1, score: 0.5 },
			];
		},
	};
	const overrideReranker: RerankProvider = {
		async rerank() {
			overrideCalls += 1;
			return [
				{ index: 1, score: 0.95 },
				{ index: 0, score: 0.4 },
			];
		},
	};
	const cache = new ScopedRetrievalCache({ ttlMs: 60_000, maxEntries: 16 });
	const service = new DefaultRetrievalService(
		{
			async embedQuery() {
				return [1, 0];
			},
			async embedTexts() {
				return [[1, 0]];
			},
		},
		{
			async search() {
				return hits;
			},
			async listCorpus() {
				return [];
			},
		},
		envReranker,
		{
			hybridEnabled: false,
			rerankEnabled: true,
			rerankAllowed: true,
			rerankTopK: 6,
			bm25TopK: 20,
			rrfK: 60,
			cache,
		},
	);

	const first = await service.retrieve({
		query: "beta",
		libraryId: "lib-1",
		scope,
		topK: 2,
		options: { rerankEnabled: true },
	});
	assert.equal(envCalls, 1);
	assert.equal(first.citations[0]?.id, "a");

	// Dynamic override with its own cache tag must NOT hit the stale env-reranker cache entry.
	const second = await service.retrieve({
		query: "beta",
		libraryId: "lib-1",
		scope,
		topK: 2,
		options: {
			rerankEnabled: true,
			rerankerOverride: overrideReranker,
			rerankCacheTag: "org:2:https://vllm.local/v1/rerank:qwen3-reranker-8b",
		},
	});
	assert.equal(overrideCalls, 1);
	assert.equal(second.citations[0]?.id, "b");
	assert.equal(cache.size, 2);

	service.clearCache();
	assert.equal(cache.size, 0);
});

test("organization-model-settings service enforces Compose empty-env fallback, key-URL binding, private-LAN isolation, and reset_all integrity", async () => {
	const {
		mergeConfigPatch,
		resolveEffectiveBindings,
		testOrganizationModelConnection,
	} = await import("../../src/lib/server/organization-model-settings");

	// 1. Compose empty-string optional env vars (VLM_BASE_URL="", etc.) fall back cleanly to chatBaseUrl.
	const composeEnv: NodeJS.ProcessEnv = {
		...TEST_ENV,
		LLM_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		LLM_API_KEY: "test-env-dashscope-key",
		CHAT_MODEL: "qwen-plus",
		VLM_ENABLED: "false",
		VLM_BASE_URL: "",
		VLM_MODEL: "",
		VLM_PROVIDER_NAME: "",
		RERANK_BASE_URL: "",
		RERANK_MODEL: "",
	};
	const vlmEnablePatch = mergeConfigPatch({
		organizationId: "org-1",
		currentConfig: {},
		currentSecrets: {},
		patch: { vlm: { enabled: true, model: "qwen-vl-plus" } },
		env: composeEnv,
	});
	assert.equal(vlmEnablePatch.ok, true);
	const vlmBindings = resolveEffectiveBindings({
		organizationId: "org-1",
		config: vlmEnablePatch.ok ? vlmEnablePatch.config : {},
		secrets: vlmEnablePatch.ok ? vlmEnablePatch.secrets : {},
		env: composeEnv,
	});
	assert.equal(
		vlmBindings.vlm.baseUrl,
		"https://dashscope.aliyuncs.com/compatible-mode/v1",
	);
	assert.equal(vlmBindings.vlm.apiKey, "test-env-dashscope-key");
	assert.equal(vlmBindings.rerank.model, "qwen3-rerank");

	// 2. Moving org Chat to private LAN vLLM must NOT silently leak Judge or Rerank to cloud DashScope env!
	const lanChatKey = encryptModelApiKey(
		"local-vllm-key",
		{ organizationId: "org-1", slot: "chat" },
		composeEnv,
	);
	const lanBindings = resolveEffectiveBindings({
		organizationId: "org-1",
		config: {
			chat: { base_url: "http://10.0.1.50:8000/v1", model: "Qwen3-32B" },
			judge: { inherit_chat: false, model: "Qwen3-8B" },
		},
		secrets: { chat: lanChatKey },
		env: composeEnv,
	});
	assert.equal(lanBindings.judge.baseUrl, "http://10.0.1.50:8000/v1");
	assert.equal(lanBindings.judge.apiKey, "local-vllm-key");
	assert.equal(lanBindings.rerank.baseUrl, null);
	assert.equal(lanBindings.rerank.apiKey, undefined);

	// 3. Stored write-only key must NOT be exfiltrated via POST /test to a different URL!
	let probeCalled = false;
	const exfilAttempt = await testOrganizationModelConnection({
		organizationId: "org-1",
		request: {
			slot: "chat",
			base_url: "https://attacker.example/v1",
		},
		env: composeEnv,
		storedOverrideForTests: {
			config: { chat: { base_url: "http://10.0.1.50:8000/v1" } },
			secrets: { chat: lanChatKey },
		},
		fetch: async () => {
			probeCalled = true;
			return Response.json({ choices: [{ message: { content: "ok" } }] });
		},
	});
	assert.equal(exfilAttempt.ok, true);
	if (exfilAttempt.ok) {
		assert.equal(exfilAttempt.result.ok, false);
		assert.equal(exfilAttempt.result.category, "invalid_config");
	}
	assert.equal(probeCalled, false);

	// 4. PATCH changing base_url of a slot with stored secret requires new api_key or clear_api_key.
	const forwardBlocked = mergeConfigPatch({
		organizationId: "org-1",
		currentConfig: { chat: { base_url: "http://10.0.1.50:8000/v1" } },
		currentSecrets: { chat: lanChatKey },
		patch: { chat: { base_url: "https://new-provider.example/v1" } },
		env: composeEnv,
	});
	assert.equal(forwardBlocked.ok, false);

	// 5. OrganizationModelPatchSchema forbids combining reset_all with slot patches.
	assert.equal(
		OrganizationModelPatchSchema.safeParse({ reset_all: true, chat: null })
			.success,
		false,
	);
	const cleanReset = mergeConfigPatch({
		organizationId: "org-1",
		currentConfig: {},
		currentSecrets: { chat: lanChatKey },
		patch: { reset_all: true },
		env: composeEnv,
	});
	assert.equal(cleanReset.ok, true);
	if (cleanReset.ok) {
		assert.equal(cleanReset.keyActions.chat, "cleared");
	}

	// 6. Locked mode blocks VLM probe when VLM is disabled in env without firing outbound fetch.
	let lockedVlmCalled = false;
	const lockedVlm = await testOrganizationModelConnection({
		organizationId: "org-1",
		request: { slot: "vlm" },
		env: {
			...composeEnv,
			MODEL_SETTINGS_LOCKED: "true",
			VLM_ENABLED: "false",
			VLM_MODEL: "qwen-vl-plus",
		},
		fetch: async () => {
			lockedVlmCalled = true;
			return Response.json({ choices: [{ message: { content: "ok" } }] });
		},
	});
	assert.equal(lockedVlm.ok, true);
	if (lockedVlm.ok) {
		assert.equal(lockedVlm.result.ok, false);
		assert.equal(lockedVlm.result.category, "invalid_config");
	}
	assert.equal(lockedVlmCalled, false);

	// 7. Trailing slash on draft base_url still matches persisted URL and uses stored key cleanly.
	let authHeader: string | null = null;
	const trailingSlashProbe = await testOrganizationModelConnection({
		organizationId: "org-1",
		request: {
			slot: "chat",
			base_url: "http://10.0.1.50:8000/v1/",
		},
		env: composeEnv,
		storedOverrideForTests: {
			config: { chat: { base_url: "http://10.0.1.50:8000/v1" } },
			secrets: { chat: lanChatKey },
		},
		fetch: async (_url, init) => {
			authHeader = new Headers(init?.headers).get("authorization");
			return Response.json({
				choices: [{ message: { content: '{"ok":true}' } }],
				usage: { total_tokens: 4 },
			});
		},
	});
	assert.equal(trailingSlashProbe.ok, true);
	if (trailingSlashProbe.ok) {
		assert.equal(trailingSlashProbe.result.ok, true);
	}
	assert.equal(authHeader, "Bearer local-vllm-key");
});

test("DefaultRetrievalService reranks single sparse-only candidate even when rerankEnabled is true", async () => {
	const scope: AuthorizedScope = {
		organizationId: "org-1",
		workspaceId: "ws-1",
		principalIds: ["user-1"],
		groupIds: [],
		libraryIds: ["lib-1"],
		activeGenerationIds: ["gen-1"],
	};
	const sparseOnlyHit = {
		id: "sparse-1",
		score: 0.42,
		payload: {
			tenant_id: "org-1",
			workspace_id: "ws-1",
			library_id: "lib-1",
			doc_id: "doc-1",
			document_version_id: "ver-1",
			generation_id: "gen-1",
			lifecycle_visibility: "active" as const,
			acl_scope: "workspace" as const,
			acl_principals: [],
			acl_groups: [],
			record_type: "chunk" as const,
			record_id: "rec-s1",
			chunk_index: 0,
			title: "Doc",
			text: "SKU-9988 exact passage",
			body: "SKU-9988 exact passage",
			page: null,
			page_start: null,
			page_end: null,
			section_path: null,
			heading_text: null,
			preamble: null,
			table_id: null,
			figure_id: null,
			headers: [],
			rows: [],
			row_start: null,
			row_end: null,
			table_row_count: null,
			filename: "doc.txt",
			source_chunk_ids: [],
			source_node_ids: [],
		},
	};
	let rerankCalls = 0;
	const service = new DefaultRetrievalService(
		{
			async embedQuery() {
				return [1, 0];
			},
			async embedTexts() {
				return [[1, 0]];
			},
		},
		{
			async search() {
				return [];
			},
			async hybridSearch() {
				return [sparseOnlyHit];
			},
			async listCorpus() {
				return [];
			},
		},
		{
			async rerank() {
				rerankCalls += 1;
				return [{ index: 0, score: 0.94 }];
			},
		},
		{
			hybridEnabled: true,
			hybridAllowed: true,
			rerankEnabled: false,
			rerankAllowed: true,
			rerankTopK: 6,
			bm25TopK: 20,
			rrfK: 60,
		},
	);
	const result = await service.retrieve({
		query: "SKU-9988",
		libraryId: "lib-1",
		scope,
		topK: 4,
		options: { hybridEnabled: true, rerankEnabled: true },
	});
	assert.equal(rerankCalls, 1);
	assert.equal(result.debug.usedRerank, true);
	assert.equal(result.citations[0]?.score, 0.94);
});
