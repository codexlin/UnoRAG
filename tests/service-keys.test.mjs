import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
	extractBearerServiceKey,
	generateServiceKeyRaw,
	hashServiceKey,
	KEY_PREFIX,
	normalizeLibraryIds,
	normalizeScopes,
	principalForServiceKey,
	serviceKeyAllowsLibrary,
	serviceKeyHasScope,
} from "../src/lib/server/service-keys-core.mjs";
import { canManageMembers } from "../src/lib/server/workspace-permissions.mjs";

test("service key raw format and hash", () => {
	const { rawKey, prefix } = generateServiceKeyRaw();
	assert.ok(rawKey.startsWith(KEY_PREFIX));
	assert.equal(prefix, rawKey.slice(0, 16));
	const expected = createHash("sha256").update(rawKey, "utf8").digest("hex");
	assert.equal(hashServiceKey(rawKey), expected);
	assert.equal(expected.length, 64);
});

test("scope and library allow-list helpers", () => {
	assert.deepEqual(normalizeScopes(["ask", "retrieve", "ask", "admin"]), [
		"ask",
		"retrieve",
	]);
	assert.equal(normalizeScopes(["ingest"]), null);
	assert.deepEqual(normalizeLibraryIds(["lib-a", "lib-a", ""]), ["lib-a"]);
	assert.equal(normalizeLibraryIds([]), null);

	const key = { scopes: ["retrieve"], libraryIds: ["lib-1"] };
	assert.equal(serviceKeyHasScope(key, "retrieve"), true);
	assert.equal(serviceKeyHasScope(key, "ask"), false);
	assert.equal(serviceKeyAllowsLibrary(key, "lib-1"), true);
	assert.equal(serviceKeyAllowsLibrary(key, "lib-2"), false);
	assert.equal(
		serviceKeyAllowsLibrary({ scopes: ["ask"], libraryIds: null }, "any"),
		true,
	);
});

test("bearer extraction and principal", () => {
	assert.equal(
		extractBearerServiceKey("Bearer mk_svc_abc", null),
		"mk_svc_abc",
	);
	assert.equal(extractBearerServiceKey(null, "mk_svc_alt"), "mk_svc_alt");
	assert.equal(extractBearerServiceKey("Basic x", null), null);
	assert.equal(
		principalForServiceKey("11111111-1111-1111-1111-111111111111"),
		"service:11111111-1111-1111-1111-111111111111",
	);
});

test("viewer cannot manage service keys (same gate as members)", () => {
	assert.equal(canManageMembers({ role: "viewer" }), false);
	assert.equal(canManageMembers({ role: "editor" }), false);
	assert.equal(canManageMembers({ role: "admin" }), true);
	assert.equal(canManageMembers({ role: "owner" }), true);
});
