import assert from "node:assert/strict";
import test from "node:test";
import { injectAskOverrides } from "../../src/lib/server/ask-overrides-inject.mjs";
import {
	mergeAskPatch,
	PUBLIC_ASK_DEFAULTS,
	validateAskPatch,
} from "../../src/lib/server/workspace-ask-settings.mjs";
import {
	askRetrievalOptions,
	NativeAskPolicySchema,
} from "../../src/server/http/ask/policy";
import { createWorkspaceAskSettingsHandlers } from "../../src/server/http/workspace-ask-settings";

test("only a workspace admin can change retrieval settings, applied on the next Ask including retries", async () => {
	let ask: Record<string, unknown> = { retrieval_enhancement: "on" };
	let role = "viewer";
	let policyVersion = 1;
	const { PATCH } = createWorkspaceAskSettingsHandlers({
		resolveIdentity: async () => ({
			workspaceId: "test-workspace",
			principalId: "caller",
			role,
		}),
		read: async () => ({
			ask,
			defaults: PUBLIC_ASK_DEFAULTS,
			updated_at: null,
			updated_by: null,
			policy_version: policyVersion,
			ask_previous: null,
		}),
		patch: async (workspaceId, requested, actor) => {
			assert.equal(workspaceId, "test-workspace");
			assert.equal(actor, "caller");
			const validated = validateAskPatch(requested);
			if (!validated.ok) return { ...validated, status: 400 };
			const previous = ask;
			ask = mergeAskPatch(previous, validated.patch);
			return {
				ok: true,
				ask,
				defaults: PUBLIC_ASK_DEFAULTS,
				updated_at: new Date(0).toISOString(),
				updated_by: actor ?? null,
				policy_version: ++policyVersion,
				ask_previous: previous,
			};
		},
	});
	const patch = (value: unknown) =>
		PATCH(
			new Request("https://console.example/api/workspace/settings", {
				method: "PATCH",
				body: JSON.stringify({ ask: value }),
			}),
		);
	async function retrieve(retry: boolean, question = "Hello") {
		const body = new TextEncoder().encode(
			JSON.stringify({
				question,
				ask_overrides: { rerank_enabled: true },
			}),
		);
		const injected = await injectAskOverrides(
			body,
			"test-workspace",
			async () => ({ ask, policy_version: policyVersion }),
		);
		if (!injected.ok) assert.fail(injected.detail);
		const { ask_overrides } = JSON.parse(
			new TextDecoder().decode(injected.body),
		);
		return askRetrievalOptions(
			NativeAskPolicySchema.parse(ask_overrides),
			retry,
		);
	}
	assert.deepEqual(await retrieve(false), {
		hybridEnabled: true,
		rerankEnabled: true,
	});
	const independent = { hybrid_retrieval: "on", reranking: "off" };
	for (const denied of ["viewer", "editor"]) {
		role = denied;
		assert.equal((await patch(independent)).status, 403);
	}
	assert.equal(policyVersion, 1);
	role = "admin";
	assert.equal((await patch({ reranking: true })).status, 400);
	assert.equal((await patch(independent)).status, 200);
	assert.equal(ask.retrieval_enhancement, "on");
	assert.deepEqual(await retrieve(false), {
		hybridEnabled: true,
		rerankEnabled: false,
	});
	assert.deepEqual(await retrieve(true), {
		hybridEnabled: true,
		rerankEnabled: false,
	});

	assert.equal(
		(await patch({ hybrid_retrieval: "off", reranking: "on" })).status,
		200,
	);
	assert.deepEqual(await retrieve(true), {
		hybridEnabled: false,
		rerankEnabled: true,
	});
	assert.equal(
		(
			await patch({
				hybrid_retrieval: null,
				reranking: null,
				retrieval_enhancement: "off",
			})
		).status,
		200,
	);
	assert.deepEqual(await retrieve(false), {
		hybridEnabled: false,
		rerankEnabled: false,
	});
	assert.deepEqual(await retrieve(true), {
		hybridEnabled: false,
		rerankEnabled: false,
	});

	assert.equal((await patch({ hybrid_retrieval: "on" })).status, 200);
	assert.deepEqual(await retrieve(false, "对比方案A和方案B"), {
		hybridEnabled: true,
		rerankEnabled: false,
	});
	assert.deepEqual(await retrieve(true), {
		hybridEnabled: true,
		rerankEnabled: false,
	});

	assert.equal(
		(await patch({ retrieval_enhancement: "auto", hybrid_retrieval: null }))
			.status,
		200,
	);
	assert.deepEqual(await retrieve(false, "请介绍休假政策。"), {
		hybridEnabled: true,
		rerankEnabled: false,
	});
	assert.deepEqual(await retrieve(false, "SKU-123"), {
		hybridEnabled: true,
		rerankEnabled: true,
	});
});

test("workspace settings PATCH enforces same-origin and policy_version optimistic locking", async () => {
	let ask: Record<string, unknown> = { ...PUBLIC_ASK_DEFAULTS };
	let policyVersion = 2;
	const { PATCH } = createWorkspaceAskSettingsHandlers({
		resolveIdentity: async () => ({
			workspaceId: "test-workspace",
			principalId: "caller",
			role: "admin",
		}),
		appBaseUrl: "https://console.example",
		read: async () => ({
			ask,
			defaults: PUBLIC_ASK_DEFAULTS,
			updated_at: null,
			updated_by: null,
			policy_version: policyVersion,
			ask_previous: null,
		}),
		patch: async (_workspaceId, requested, actor, options) => {
			if (
				options?.expectedPolicyVersion !== undefined &&
				options.expectedPolicyVersion !== policyVersion
			) {
				return {
					ok: false,
					status: 409,
					code: "version_conflict",
					detail: "policy_version conflict",
				};
			}
			const validated = validateAskPatch(requested);
			if (!validated.ok) return { ...validated, status: 400 };
			const previous = ask;
			ask = mergeAskPatch(previous, validated.patch);
			return {
				ok: true,
				ask,
				defaults: PUBLIC_ASK_DEFAULTS,
				updated_at: new Date(0).toISOString(),
				updated_by: actor ?? null,
				policy_version: ++policyVersion,
				ask_previous: previous,
			};
		},
	});

	const crossSite = await PATCH(
		new Request("https://console.example/api/workspace/settings", {
			method: "PATCH",
			headers: {
				origin: "https://evil.example",
				"sec-fetch-site": "cross-site",
			},
			body: JSON.stringify({
				ask: { answer_profile: "precise" },
				policy_version: 2,
			}),
		}),
	);
	assert.equal(crossSite.status, 403);

	const invalidVersion = await PATCH(
		new Request("https://console.example/api/workspace/settings", {
			method: "PATCH",
			body: JSON.stringify({
				ask: { answer_profile: "precise" },
				policy_version: 0,
			}),
		}),
	);
	assert.equal(invalidVersion.status, 400);
	assert.equal((await invalidVersion.json()).code, "invalid_version");

	const stale = await PATCH(
		new Request("https://console.example/api/workspace/settings", {
			method: "PATCH",
			body: JSON.stringify({
				ask: { answer_profile: "precise" },
				policy_version: 1,
			}),
		}),
	);
	assert.equal(stale.status, 409);
	assert.equal((await stale.json()).code, "version_conflict");

	const ok = await PATCH(
		new Request("https://console.example/api/workspace/settings", {
			method: "PATCH",
			headers: {
				origin: "https://console.example",
				"sec-fetch-site": "same-origin",
			},
			body: JSON.stringify({
				ask: { answer_profile: "precise" },
				policy_version: 2,
			}),
		}),
	);
	assert.equal(ok.status, 200);
	assert.equal((await ok.json()).policy_version, 3);
});
