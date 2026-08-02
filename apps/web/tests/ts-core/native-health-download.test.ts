import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

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

const healthModule = import("../../src/server/http/health/native-handler");
const downloadModule = import(
	"../../src/server/http/document/download-handler"
).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

test("native health reports ready only when all required dependencies are ready", async () => {
	const previousKey = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "test-key";
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
	} finally {
		if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previousKey;
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
