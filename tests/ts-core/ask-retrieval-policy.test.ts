import assert from "node:assert/strict";
import test from "node:test";
import { injectAskOverrides } from "../../src/lib/server/ask-overrides-inject.mjs";
import {
	askRetrievalOptions,
	NativeAskPolicySchema,
} from "../../src/server/http/ask/policy";

test("server-injected independent retrieval overrides honor off on both attempts and retain auto retry", async () => {
	for (const scenario of [
		{
			settings: { retrieval_enhancement: "off" },
			first: [false, false],
			retry: [false, false],
		},
		{
			settings: { retrieval_enhancement: "off", reranking: "inherit" },
			first: [false, false],
			retry: [false, false],
		},
		{
			settings: { retrieval_enhancement: "auto" },
			first: [true, false],
			retry: [true, true],
		},
		{
			settings: { retrieval_enhancement: "on", reranking: "off" },
			first: [true, false],
			retry: [true, false],
		},
		{
			settings: { retrieval_enhancement: "off", reranking: "on" },
			first: [false, true],
			retry: [false, true],
		},
		{
			settings: { retrieval_enhancement: "on", hybrid_retrieval: "off" },
			first: [false, true],
			retry: [false, true],
		},
	]) {
		const injected = await injectAskOverrides(
			new TextEncoder().encode(
				JSON.stringify({
					question: "Describe the leave policy.",
					ask_overrides: { rerank_enabled: true },
				}),
			),
			"workspace-a",
			async () => ({ ask: scenario.settings, policy_version: 1 }),
		);
		assert.equal(injected.ok, true);
		if (!injected.ok) throw new Error("policy injection failed");
		const payload = JSON.parse(new TextDecoder().decode(injected.body));
		const policy = NativeAskPolicySchema.parse(payload.ask_overrides);
		for (const retry of [false, true]) {
			const options = askRetrievalOptions(policy, retry);
			assert.deepEqual(
				[options.hybridEnabled, options.rerankEnabled],
				retry ? scenario.retry : scenario.first,
				JSON.stringify({ settings: scenario.settings, retry }),
			);
		}
	}
});
