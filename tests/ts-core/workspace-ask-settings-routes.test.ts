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
	async function retrieve(retry: boolean) {
		const body = new TextEncoder().encode(
			JSON.stringify({
				question: "hello",
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
		hybridEnabled: true,
		rerankEnabled: true,
	});
});
