import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import { createClient } from "redis";

import type { ConversationScope } from "../../src/server/conversations/types";

const redisUrl = process.env.REDIS_INTEGRATION_TEST_URL?.trim();
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
const sessionMemoryModule = import(
	"../../src/server/conversations/session-memory"
).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

test("Redis session memory is scoped, bounded, and expiring", {
	skip: redisUrl ? false : "REDIS_INTEGRATION_TEST_URL is not configured",
}, async () => {
	assert.ok(redisUrl);
	process.env.REDIS_URL = redisUrl;
	process.env.SESSION_MEMORY_TTL_SECONDS = "60";
	const { closeSessionMemoryForTests, RedisSessionMemoryStore } =
		await sessionMemoryModule;
	const inspector = createClient({ url: redisUrl });
	await inspector.connect();
	const store = new RedisSessionMemoryStore();
	const scope: ConversationScope = {
		organizationId: "10000000-0000-4000-8000-000000000001",
		workspaceId: "20000000-0000-4000-8000-000000000001",
		principalId: "30000000-0000-4000-8000-000000000001",
	};
	const otherWorkspace = {
		...scope,
		workspaceId: "20000000-0000-4000-8000-000000000002",
	};
	const keys = [scope, otherWorkspace].map((item) =>
		testMemoryKey(item, "shared-session-id"),
	);

	try {
		await inspector.del(keys);
		await store.append(
			scope,
			"shared-session-id",
			[
				{ role: "user", content: "one" },
				{ role: "assistant", content: "two" },
				{ role: "user", content: "three" },
				{ role: "assistant", content: "four" },
				{ role: "user", content: "five" },
			],
			2,
		);
		await store.append(
			otherWorkspace,
			"shared-session-id",
			[{ role: "user", content: "workspace two" }],
			2,
		);

		assert.deepEqual(await store.load(scope, "shared-session-id", 2), [
			{ role: "assistant", content: "two" },
			{ role: "user", content: "three" },
			{ role: "assistant", content: "four" },
			{ role: "user", content: "five" },
		]);
		assert.deepEqual(await store.load(otherWorkspace, "shared-session-id", 2), [
			{ role: "user", content: "workspace two" },
		]);

		for (const key of keys) {
			assert.equal(await inspector.exists(key), 1);
			const ttl = await inspector.ttl(key);
			assert.ok(ttl > 0 && ttl <= 60, `unexpected TTL ${ttl}`);
		}
	} finally {
		await closeSessionMemoryForTests();
		await inspector.del(keys);
		await inspector.close();
	}
});

test("Redis session memory reconnects after an initial configuration failure", {
	skip: redisUrl ? false : "REDIS_INTEGRATION_TEST_URL is not configured",
}, async () => {
	assert.ok(redisUrl);
	const { closeSessionMemoryForTests, RedisSessionMemoryStore } =
		await sessionMemoryModule;
	delete process.env.REDIS_URL;
	const store = new RedisSessionMemoryStore();
	const scope: ConversationScope = {
		organizationId: "10000000-0000-4000-8000-000000000001",
		workspaceId: "20000000-0000-4000-8000-000000000001",
		principalId: "30000000-0000-4000-8000-000000000001",
	};

	try {
		await assert.rejects(store.load(scope, "reconnect-session", 2));
		process.env.REDIS_URL = redisUrl;
		await store.append(
			scope,
			"reconnect-session",
			[{ role: "user", content: "recovered" }],
			2,
		);
		assert.deepEqual(await store.load(scope, "reconnect-session", 2), [
			{ role: "user", content: "recovered" },
		]);
	} finally {
		process.env.REDIS_URL = redisUrl;
		await closeSessionMemoryForTests();
		const inspector = createClient({ url: redisUrl });
		await inspector.connect();
		await inspector.del(testMemoryKey(scope, "reconnect-session"));
		await inspector.close();
	}
});

function testMemoryKey(scope: ConversationScope, sessionId: string): string {
	const digest = createHash("sha256")
		.update(
			`${scope.organizationId}\0${scope.workspaceId}\0${scope.principalId}\0${sessionId}`,
		)
		.digest("hex");
	return `unorag:ask-memory:${digest}`;
}
