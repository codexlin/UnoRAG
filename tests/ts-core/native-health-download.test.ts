import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { UNORAG_QDRANT_PAYLOAD_INDEXES } from "../../src/core/retrieval/qdrant/collection-manager";
import {
	createQdrantHealthCheck,
	readProviderHealth,
} from "../../src/server/observability/provider-health";

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
	import("../../src/server/http/health/native-handler"),
	import("../../src/server/http/document/download-handler"),
]).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});
const healthModule = protectedModules.then(([health]) => health);
const downloadModule = protectedModules.then(([, download]) => download);

function healthyCollection() {
	return {
		points_count: 1,
		config: {
			params: {
				vectors: { dense: { size: 1024, distance: "Cosine" } },
				sparse_vectors: { lexical_v1: { modifier: "idf" } },
			},
		},
		payload_schema: Object.fromEntries(
			UNORAG_QDRANT_PAYLOAD_INDEXES.map(({ fieldName }) => [
				fieldName,
				{ data_type: "keyword" },
			]),
		),
	};
}

test("health checks the retrieval schema read-only and distinguishes empty metadata from a lost collection", async (t) => {
	const { handleNativeHealthRequest } = await healthModule;
	const previousKey = process.env.LLM_API_KEY;
	process.env.LLM_API_KEY = "offline-configured-key";
	t.after(() => {
		if (previousKey === undefined) delete process.env.LLM_API_KEY;
		else process.env.LLM_API_KEY = previousKey;
	});
	const cases = [
		{ name: "valid", code: null },
		{ name: "no-idf", code: "qdrant_schema_mismatch" },
		{ name: "absent-idf", code: "qdrant_schema_mismatch" },
		{ name: "no-sparse", code: "qdrant_schema_mismatch" },
		{ name: "wrong-sparse-name", code: "qdrant_schema_mismatch" },
		{ name: "hybrid-disabled-no-idf", code: "qdrant_schema_mismatch" },
		{ name: "distance", code: "qdrant_schema_mismatch" },
		{ name: "unknown-dense", code: "qdrant_schema_mismatch" },
		{ name: "dimension", code: "embedding_dimension_mismatch" },
		{ name: "payload-type", code: "qdrant_schema_mismatch" },
		{ name: "payload-missing", code: "qdrant_schema_mismatch" },
		{ name: "invalid-dimension", code: "qdrant_schema_mismatch" },
		{ name: "invalid-distance", code: "qdrant_schema_mismatch" },
		{ name: "configured-distance", code: null },
		{ name: "empty-empty", code: null },
		{ name: "empty-active", code: "qdrant_index_missing" },
		{ name: "missing-empty", code: null },
		{ name: "missing-active", code: "qdrant_collection_missing" },
		{ name: "missing-unknown", code: "qdrant_collection_missing" },
		{ name: "missing-unknown-result", code: "qdrant_collection_missing" },
		{ name: "missing-metadata-down", code: "qdrant_unavailable" },
	];
	for (const { name, code } of cases) {
		await t.test(name, async (t) => {
			const environment = {
				QDRANT_URL: "http://127.0.0.1:1",
				QDRANT_COLLECTION: "offline-health",
				EMBEDDING_DIM: name === "invalid-dimension" ? "invalid" : "1024",
				QDRANT_DISTANCE: name === "invalid-distance" ? "invalid" : "Cosine",
				TS_RETRIEVAL_HYBRID_ENABLED:
					name === "hybrid-disabled-no-idf" ? "false" : undefined,
			};
			if (name === "configured-distance") environment.QDRANT_DISTANCE = "Dot";
			const info = healthyCollection();
			if (name.startsWith("empty-")) info.points_count = 0;
			if (name === "no-idf" || name === "hybrid-disabled-no-idf")
				info.config.params.sparse_vectors.lexical_v1.modifier = "none";
			if (name === "absent-idf")
				Object.assign(info.config.params, {
					sparse_vectors: { lexical_v1: {} },
				});
			if (name === "no-sparse")
				Object.assign(info.config.params, { sparse_vectors: undefined });
			if (name === "wrong-sparse-name")
				Object.assign(info.config.params, {
					sparse_vectors: { lexical_v2: { modifier: "idf" } },
				});
			if (name === "distance" || name === "configured-distance")
				info.config.params.vectors.dense.distance = "Dot";
			if (name === "unknown-dense")
				Object.assign(info.config.params, {
					vectors: { unknown: { size: 1024, distance: "Cosine" } },
				});
			if (name === "dimension") info.config.params.vectors.dense.size = 768;
			if (name === "payload-type")
				info.payload_schema.tenant_id.data_type = "integer";
			if (name === "payload-missing") delete info.payload_schema.tenant_id;
			const methods: string[] = [];
			t.mock.method(
				globalThis,
				"fetch",
				async (input: string | URL, init: RequestInit) => {
					const url = new URL(input);
					assert.equal(url.origin, environment.QDRANT_URL);
					methods.push(init.method ?? "GET");
					assert.equal(init.method ?? "GET", "GET");
					if (url.pathname.endsWith("/exists"))
						return Response.json({
							result: { exists: !name.startsWith("missing-") },
						});
					assert.equal(url.pathname, "/collections/offline-health");
					return Response.json({ result: info });
				},
			);
			let metadataChecks = 0;
			const hasActiveDocuments =
				name === "missing-unknown"
					? undefined
					: async () => {
							metadataChecks += 1;
							if (name === "missing-metadata-down")
								throw new Error("private metadata error");
							if (name === "missing-unknown-result")
								return undefined as unknown as boolean;
							return name === "missing-active" || name === "empty-active";
						};
			const checkDatabase = async () => undefined;
			const providers = await readProviderHealth(
				{ checkDatabase, hasActiveDocuments },
				{ environment },
			);
			const item = providers.items.find((entry) => entry.code === "qdrant");
			assert.ok(item);
			const response = await handleNativeHealthRequest({
				probe: "ready",
				dependencies: {
					checkDatabase,
					checkQdrant: createQdrantHealthCheck(environment, {
						hasActiveDocuments,
					}),
				},
			});
			const body = await response.json();
			assert.equal(item.status, code ? "degraded" : "healthy");
			assert.equal(item.error_code, code);
			assert.equal(response.status, code ? 503 : 200);
			assert.equal(body.ask_ready, code === null);
			assert.equal(body.qdrant_ok, code === null);
			assert.deepEqual(body.reasons, code ? [code] : []);
			assert.equal(
				metadataChecks,
				(name.startsWith("missing-") || name.startsWith("empty-")) &&
					hasActiveDocuments
					? 2
					: 0,
			);
			assert.ok(methods.every((method) => method === "GET"));
			assert.doesNotMatch(
				JSON.stringify([providers, body]),
				/private metadata|offline-configured-key/,
			);
		});
	}
});

test("default native readiness reads active metadata for a missing collection on every probe", async (t) => {
	const { handleNativeHealthRequest } = await healthModule;
	const environment = {
		LLM_API_KEY: "offline-key",
		QDRANT_URL: "http://127.0.0.1:1",
		EMBEDDING_DIM: "1024",
	};
	for (const [key, value] of Object.entries(environment)) {
		const previous = process.env[key];
		process.env[key] = value;
		t.after(() => {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		});
	}
	t.mock.method(
		globalThis,
		"fetch",
		async (input: string | URL, init: RequestInit) => {
			assert.equal(new URL(input).origin, environment.QDRANT_URL);
			assert.equal(init.method ?? "GET", "GET");
			assert.ok(new URL(input).pathname.endsWith("/exists"));
			return Response.json({ result: { exists: false } });
		},
	);
	const globalDatabase = globalThis as typeof globalThis & {
		unoragPool?: unknown;
	};
	const previousPool = globalDatabase.unoragPool;
	t.after(() => {
		globalDatabase.unoragPool = previousPool;
	});
	let active = false;
	let metadataReads = 0;
	globalDatabase.unoragPool = {
		async query(query: { text: string }) {
			assert.match(query.text.trim(), /^select\s/i);
			if (/select 1$/i.test(query.text.trim())) return { rows: [{ value: 1 }] };
			metadataReads += 1;
			return { rows: active ? [["active-document"]] : [] };
		},
	};
	const empty = await handleNativeHealthRequest({ probe: "ready" });
	assert.equal(empty.status, 200);
	active = true;
	const lost = await handleNativeHealthRequest({ probe: "ready" });
	assert.equal(lost.status, 503);
	const body = await lost.json();
	assert.equal(body.ask_ready, false);
	assert.deepEqual(body.reasons, ["qdrant_collection_missing"]);
	assert.equal(metadataReads, 2);
});

test("native readiness validates model bindings while allowing an intentionally absent reranker", async (t) => {
	const { handleNativeHealthRequest } = await healthModule;
	const keys = [
		"LLM_API_KEY",
		"LLM_BASE_URL",
		"OPENAI_API_KEY",
		"OPENAI_BASE_URL",
		"DASHSCOPE_API_KEY",
		"DASHSCOPE_BASE_URL",
		"EMBEDDING_API_KEY",
		"EMBEDDING_BASE_URL",
		"RERANK_API_KEY",
		"RERANK_BASE_URL",
		"CHAT_MODEL",
		"JUDGE_MODEL",
		"JUDGE_API_KEY",
		"JUDGE_BASE_URL",
		"VLM_ENABLED",
		"VLM_MODEL",
		"VLM_API_KEY",
		"VLM_BASE_URL",
		"VLM_TIMEOUT_MS",
		"VLM_MAX_FIGURES_PER_REQUEST",
		"VLM_MAX_IMAGE_BYTES",
	];
	for (const { environment, reason } of [
		{
			environment: {
				LLM_API_KEY: "offline-key",
				LLM_BASE_URL: "https://custom.private.invalid/v1",
			},
			reason: null,
		},
		{
			environment: { LLM_API_KEY: "offline-key", LLM_BASE_URL: "not-a-url" },
			reason: "llm_not_configured",
		},
		{
			environment: {
				LLM_API_KEY: "offline-key",
				EMBEDDING_BASE_URL: "https://embedding.private.invalid/v1",
			},
			reason: "embedding_not_configured",
		},
		{
			environment: {
				LLM_API_KEY: "offline-key",
				EMBEDDING_BASE_URL: "https://embedding.private.invalid/v1",
				EMBEDDING_API_KEY: "embedding-key",
			},
			reason: null,
		},
		{
			environment: {
				LLM_API_KEY: "offline-key",
				RERANK_BASE_URL: "https://rerank.private.invalid/v1",
			},
			reason: "rerank_not_configured",
		},
		{
			environment: {
				LLM_BASE_URL: "https://custom.private.invalid/v1",
				OPENAI_API_KEY: "offline-key",
			},
			reason: "llm_key_missing",
		},
		{
			environment: { LLM_API_KEY: "offline-key", CHAT_MODEL: " " },
			reason: "llm_not_configured",
		},
		{
			environment: {
				LLM_API_KEY: "offline-key",
				JUDGE_BASE_URL: "https://judge.private.invalid/v1",
			},
			reason: "judge_not_configured",
		},
		{
			environment: {
				LLM_API_KEY: "offline-key",
				JUDGE_BASE_URL: "invalid-url",
				JUDGE_API_KEY: "judge-secret",
			},
			reason: "judge_not_configured",
		},
		{
			environment: {
				LLM_API_KEY: "offline-key",
				JUDGE_BASE_URL: "https://judge.private.invalid/v1",
				JUDGE_API_KEY: "judge-secret",
			},
			reason: null,
		},
		{
			environment: { LLM_API_KEY: "offline-key", VLM_ENABLED: "true" },
			reason: "vlm_not_configured",
		},
		{
			environment: {
				LLM_API_KEY: "offline-key",
				VLM_ENABLED: "false",
				VLM_BASE_URL: "invalid-url",
				VLM_TIMEOUT_MS: "invalid",
			},
			reason: null,
		},
		{
			environment: {
				LLM_API_KEY: "offline-key",
				VLM_ENABLED: " TRUE ",
				VLM_MODEL: "vision",
			},
			reason: null,
		},
		{
			environment: {
				LLM_API_KEY: "offline-key",
				VLM_ENABLED: "true",
				VLM_MODEL: "vision",
				VLM_BASE_URL: "https://vlm.private.invalid/v1",
			},
			reason: "vlm_not_configured",
		},
		{
			environment: {
				LLM_API_KEY: "offline-key",
				VLM_ENABLED: "true",
				VLM_MODEL: "vision",
				VLM_BASE_URL: "https://vlm.private.invalid/v1",
				VLM_API_KEY: "vlm-secret",
			},
			reason: null,
		},
		{
			environment: {
				LLM_API_KEY: "offline-key",
				VLM_ENABLED: "true",
				VLM_MODEL: "vision",
				VLM_TIMEOUT_MS: "999",
			},
			reason: "vlm_not_configured",
		},
		{
			environment: {
				LLM_API_KEY: "offline-key",
				VLM_ENABLED: "true",
				VLM_MODEL: "vision",
				VLM_MAX_FIGURES_PER_REQUEST: "5",
			},
			reason: "vlm_not_configured",
		},
		{
			environment: {
				LLM_API_KEY: "offline-key",
				VLM_ENABLED: "true",
				VLM_MODEL: "vision",
				VLM_MAX_IMAGE_BYTES: "42",
			},
			reason: "vlm_not_configured",
		},
	]) {
		await t.test(reason ?? "configured", async (t) => {
			const values: Record<string, string | undefined> = environment;
			for (const key of keys) {
				const previous = process.env[key];
				if (values[key] === undefined) delete process.env[key];
				else process.env[key] = values[key];
				t.after(() => {
					if (previous === undefined) delete process.env[key];
					else process.env[key] = previous;
				});
			}
			t.mock.method(globalThis, "fetch", async () => {
				throw new Error("Unexpected model HTTP");
			});
			const response = await handleNativeHealthRequest({
				probe: "ready",
				dependencies: {
					checkDatabase: async () => undefined,
					checkQdrant: async () => undefined,
				},
			});
			const body = await response.json();
			assert.equal(response.status, reason ? 503 : 200);
			assert.equal(body.ask_ready, reason === null);
			assert.deepEqual(body.reasons, reason ? [reason] : []);
			if (reason) assert.equal(typeof body.recovery, "string");
			assert.doesNotMatch(
				JSON.stringify(body),
				/offline-key|embedding-key|judge-secret|vlm-secret|private\.invalid|not-a-url|invalid-url/,
			);
		});
	}
});

test("both health surfaces flag a live Qdrant dimension mismatch and permit first boot", async (t) => {
	const { handleNativeHealthRequest } = await healthModule;
	const environment = {
		LLM_API_KEY: "configured-model-credential",
		QDRANT_URL: "https://private-vector.example",
		QDRANT_API_KEY: "private-vector-credential",
		QDRANT_COLLECTION: "health-test",
		EMBEDDING_DIM: "1024",
	};
	const previousKey = process.env.LLM_API_KEY;
	process.env.LLM_API_KEY = environment.LLM_API_KEY;
	t.after(() => {
		if (previousKey === undefined) delete process.env.LLM_API_KEY;
		else process.env.LLM_API_KEY = previousKey;
	});
	const paths: string[] = [];
	let mode: "missing" | "matching" | "mismatch" | "down";
	t.mock.method(
		globalThis,
		"fetch",
		async (input: string | URL, init: RequestInit) => {
			const { pathname } = new URL(input);
			paths.push(pathname);
			assert.equal(
				new Headers(init.headers).get("api-key"),
				environment.QDRANT_API_KEY,
			);
			if (mode === "down") {
				return Response.json(
					{ error: "https://private-vector.example?token=private-response" },
					{ status: 503 },
				);
			}
			if (pathname === "/collections/health-test/exists") {
				return Response.json({ result: { exists: mode !== "missing" } });
			}
			assert.equal(pathname, "/collections/health-test");
			const dense = {
				size: mode === "mismatch" ? 768 : 1024,
				distance: "Cosine",
			};
			const info = healthyCollection();
			Object.assign(info.config.params, {
				vectors: mode === "mismatch" ? { dense } : dense,
			});
			return Response.json({ result: info });
		},
	);

	for (mode of ["missing", "matching", "mismatch", "down"] as const) {
		paths.length = 0;
		const checkDatabase = async () => undefined;
		const hasActiveDocuments = async () => false;
		const operations = await readProviderHealth(
			{ checkDatabase, hasActiveDocuments },
			{ environment },
		);
		const item = operations.items.find((entry) => entry.code === "qdrant");
		assert.ok(item);
		const response = await handleNativeHealthRequest({
			probe: "ready",
			dependencies: {
				checkDatabase,
				checkQdrant: createQdrantHealthCheck(environment, {
					hasActiveDocuments,
				}),
			},
		});
		const native = await response.json();
		const ready = mode === "missing" || mode === "matching";
		const expectedCode =
			mode === "mismatch"
				? "embedding_dimension_mismatch"
				: "qdrant_unavailable";
		assert.equal(item.status, ready ? "healthy" : "degraded");
		assert.equal(item.error_code, ready ? null : expectedCode);
		assert.equal(response.status, ready ? 200 : 503);
		assert.equal(native.ask_ready, ready);
		assert.deepEqual(native.reasons, ready ? [] : [expectedCode]);
		assert.equal(
			paths.filter((path) => path === "/collections/health-test").length,
			mode === "matching" || mode === "mismatch" ? 2 : 0,
		);
		if (mode === "mismatch") {
			assert.equal(native.recovery, item.recovery);
			assert.doesNotMatch(item.recovery, /\p{Script=Han}/u);
			assert.match(
				item.recovery,
				/supports 768 dimensions, set EMBEDDING_DIM=768.*To use 1024 dimensions, set QDRANT_COLLECTION.*reindex/,
			);
		}
		assert.doesNotMatch(
			JSON.stringify([native, operations]),
			/private-vector|configured-model-credential|private-response|authorization/i,
		);
	}
});

test("native health reports ready only when all required dependencies are ready", async () => {
	const previousKey = process.env.OPENAI_API_KEY;
	const previousVersion = process.env.UNORAG_VERSION;
	const previousRevision = process.env.UNORAG_REVISION;
	process.env.OPENAI_API_KEY = "test-key";
	process.env.UNORAG_VERSION = "0.1.0-rc.9";
	process.env.UNORAG_REVISION = "0123456789abcdef0123456789abcdef01234567";
	try {
		const { handleNativeHealthRequest } = await healthModule;
		const ready = await handleNativeHealthRequest({
			dependencies: {
				checkDatabase: async () => undefined,
				checkQdrant: async () => undefined,
			},
		});
		assert.equal(ready.status, 200);
		const readyBody = (await ready.json()) as Record<string, unknown>;
		assert.equal(readyBody.ask_ready, true);
		assert.equal(readyBody.effective_mode, "typescript");
		assert.deepEqual(
			(readyBody.release as Record<string, unknown>).version,
			"0.1.0-rc.9",
		);

		const degraded = await handleNativeHealthRequest({
			dependencies: {
				checkDatabase: async () => undefined,
				checkQdrant: async () => {
					throw new Error("unavailable");
				},
			},
		});
		assert.equal(degraded.status, 200);
		const degradedBody = (await degraded.json()) as Record<string, unknown>;
		assert.equal(degradedBody.ask_ready, false);
		assert.deepEqual(degradedBody.reasons, ["qdrant_unavailable"]);

		const notReady = await handleNativeHealthRequest({
			probe: "ready",
			dependencies: {
				checkDatabase: async () => undefined,
				checkQdrant: async () => {
					throw new Error("unavailable");
				},
			},
		});
		assert.equal(notReady.status, 503);
		assert.equal(
			((await notReady.json()) as Record<string, unknown>).ask_ready,
			false,
		);

		const live = await handleNativeHealthRequest({
			probe: "live",
			dependencies: {
				checkDatabase: async () => {
					throw new Error("unavailable");
				},
				checkQdrant: async () => {
					throw new Error("unavailable");
				},
			},
		});
		assert.equal(live.status, 200);
		assert.deepEqual(await live.json(), {
			status: "ok",
			service: "unorag-web",
			live_ready: true,
		});
	} finally {
		if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previousKey;
		if (previousVersion === undefined) delete process.env.UNORAG_VERSION;
		else process.env.UNORAG_VERSION = previousVersion;
		if (previousRevision === undefined) delete process.env.UNORAG_REVISION;
		else process.env.UNORAG_REVISION = previousRevision;
	}
});

test("document download route and ACL checks fail closed", async () => {
	const { documentAclAllows, isNativeDocumentDownloadPath } =
		await downloadModule;
	const identity = { principalId: "user-1", groupIds: ["group-1"] };

	assert.equal(
		isNativeDocumentDownloadPath(["v1", "documents", "document-1", "download"]),
		true,
	);
	assert.equal(documentAclAllows([], identity), true);
	assert.equal(
		documentAclAllows(
			[{ subjectType: "principal", subjectId: "user-2" }],
			identity,
		),
		false,
	);
	assert.equal(
		documentAclAllows(
			[{ subjectType: "group", subjectId: "group-1" }],
			identity,
		),
		true,
	);
});
