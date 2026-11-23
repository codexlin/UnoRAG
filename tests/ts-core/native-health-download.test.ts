import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
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
			return Response.json({
				result: {
					config: {
						params: { vectors: mode === "mismatch" ? { dense } : dense },
					},
				},
			});
		},
	);

	for (mode of ["missing", "matching", "mismatch", "down"] as const) {
		paths.length = 0;
		const checkDatabase = async () => undefined;
		const operations = await readProviderHealth(
			{ checkDatabase },
			{ environment },
		);
		const item = operations.items.find((entry) => entry.code === "qdrant");
		assert.ok(item);
		const response = await handleNativeHealthRequest({
			probe: "ready",
			dependencies: {
				checkDatabase,
				checkQdrant: createQdrantHealthCheck(environment),
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
			assert.match(item.recovery, /集合的向量维度为 768/);
			assert.match(
				item.recovery,
				/EMBEDDING_DIM=1024.*set EMBEDDING_DIM=768.*QDRANT_COLLECTION.*reindex/,
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
