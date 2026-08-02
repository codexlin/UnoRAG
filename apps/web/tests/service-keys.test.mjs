import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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

test("control plane keys routes require canManageMembers and never list plaintext", () => {
	const listCreate = readFileSync(
		path.join(root, "src/app/api/workspace/keys/route.ts"),
		"utf8",
	);
	const revoke = readFileSync(
		path.join(root, "src/app/api/workspace/keys/[id]/route.ts"),
		"utf8",
	);
	const revokePost = readFileSync(
		path.join(root, "src/app/api/workspace/keys/[id]/revoke/route.ts"),
		"utf8",
	);
	const serviceKeys = readFileSync(
		path.join(root, "src/lib/server/service-keys.ts"),
		"utf8",
	);

	assert.match(listCreate, /canManageMembers/);
	assert.match(revoke, /canManageMembers/);
	assert.match(revokePost, /canManageMembers/);
	assert.match(listCreate, /listWorkspaceServiceKeys/);
	assert.match(listCreate, /createWorkspaceServiceKey/);
	assert.match(serviceKeys, /library_ids:\s*row\.libraryIds/);
	// list maps toPublicRow only — plaintext `key` is create-only
	assert.match(serviceKeys, /return rows\.map\(toPublicRow\)/);
	const publicRow = serviceKeys.slice(
		serviceKeys.indexOf("function toPublicRow"),
		serviceKeys.indexOf("export async function listWorkspaceServiceKeys"),
	);
	assert.match(publicRow, /prefix:/);
	assert.doesNotMatch(publicRow, /^\s*key:/m);
	assert.match(serviceKeys, /key:\s*rawKey/);
	assert.match(serviceKeys, /workspace\.service_key_created/);
	assert.match(serviceKeys, /workspace\.service_key_revoked/);
	assert.match(serviceKeys, /resourceType:\s*"service_key"/);
	assert.match(serviceKeys, /db\.transaction/);
	assert.doesNotMatch(serviceKeys, /details:\s*\{[\s\S]{0,300}keyHash/);
	assert.doesNotMatch(serviceKeys, /details:\s*\{[\s\S]{0,300}rawKey/);
});

test("authenticateServiceKey rejects revoked keys (revoked_at IS NULL filter)", () => {
	const serviceKeys = readFileSync(
		path.join(root, "src/lib/server/service-keys.ts"),
		"utf8",
	);
	assert.match(serviceKeys, /isNull\(workspaceServiceKeys\.revokedAt\)/);
	assert.match(
		serviceKeys,
		/invalid or revoked service key|authenticateServiceKey/,
	);
	const integration = readFileSync(
		path.join(root, "src/lib/server/integration-rag.ts"),
		"utf8",
	);
	assert.match(integration, /invalid or revoked service key/);
	assert.match(integration, /status:\s*401/);
});

test("integration routes use Bearer service keys and native Ask/Retrieve", () => {
	const ask = readFileSync(
		path.join(root, "src/app/api/v1/ask/route.ts"),
		"utf8",
	);
	const retrieve = readFileSync(
		path.join(root, "src/app/api/v1/retrieve/route.ts"),
		"utf8",
	);
	const integration = readFileSync(
		path.join(root, "src/lib/server/integration-rag.ts"),
		"utf8",
	);
	const ragProxy = readFileSync(
		path.join(root, "src/lib/server/rag-proxy.ts"),
		"utf8",
	);

	assert.match(ask, /handlePublicApiV1/);
	assert.match(ask, /scope:\s*"ask"/);
	assert.match(retrieve, /handlePublicApiV1/);
	assert.match(retrieve, /scope:\s*"retrieve"/);
	assert.match(integration, /executeNativeRetrieval/);
	assert.match(integration, /handleNativeAskRequest/);
	assert.match(integration, /publicTarget\s*===\s*"retrieve"/);
	assert.match(ragProxy, /handleNativeRetrievalRequest/);
	assert.match(ragProxy, /isNativeRetrievalPath/);
	assert.match(integration, /\/v1\/ask/);
	assert.match(integration, /\/v1\/retrieve/);
	assert.doesNotMatch(integration, /RAG_API_URL|createInternalRagHeaders/);
});

test("settings page mounts integration keys panel", () => {
	const page = readFileSync(
		path.join(root, "src/app/app/settings/page.tsx"),
		"utf8",
	);
	const panel = readFileSync(
		path.join(root, "src/components/app/workspace-integration-keys-panel.tsx"),
		"utf8",
	);
	assert.match(page, /WorkspaceIntegrationKeysPanel/);
	assert.match(panel, /manageMembers/);
	assert.match(panel, /\/api\/workspace\/keys/);
	assert.match(panel, /明文仅创建时显示一次/);
	assert.match(panel, /setCreatedKey\(null\)/);
	assert.match(panel, /清除明文/);
	assert.doesNotMatch(panel, /模式 B 服务密钥/);
});
