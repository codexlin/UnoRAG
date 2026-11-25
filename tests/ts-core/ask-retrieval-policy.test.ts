import assert from "node:assert/strict";
import test from "node:test";
import { injectAskOverrides } from "../../src/lib/server/ask-overrides-inject.mjs";
import {
	askRetrievalOptions,
	NativeAskPolicySchema,
} from "../../src/server/http/ask/policy";

test("server-injected reranking modes (auto / on / off) honor off on both attempts and retain auto retry", async () => {
	for (const scenario of [
		{
			settings: { reranking: "off" },
			first: [true, false],
			retry: [true, false],
		},
		{
			settings: { reranking: "auto" },
			first: [true, false],
			retry: [true, true],
		},
		{
			settings: { reranking: "on" },
			first: [true, true],
			retry: [true, true],
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

test("runtime auto rerank escalates bilingual, rewritten, comparison and sparse-only queries while honoring off", async () => {
	const autoInjected = await injectAskOverrides(
		new TextEncoder().encode(JSON.stringify({ question: "那今年呢？" })),
		"workspace-a",
		async () => ({ ask: { reranking: "auto" }, policy_version: 2 }),
	);
	assert.equal(autoInjected.ok, true);
	if (!autoInjected.ok) throw new Error("auto policy injection failed");
	const autoPolicy = NativeAskPolicySchema.parse(
		JSON.parse(new TextDecoder().decode(autoInjected.body)).ask_overrides,
	);
	assert.equal(autoPolicy.rerank_enabled, false);

	// Simple fact query keeps first-pass rerank off, but enables sparse-only auto-upgrade.
	const plain = askRetrievalOptions(autoPolicy, false, {
		query: "Describe the leave policy.",
		queryType: "fact",
		isMultiAspectFact: false,
		isDerivedCalculation: false,
		tableOnly: false,
	});
	assert.equal(plain.rerankEnabled, false);
	assert.equal(plain.rerankSparseOnly, true);

	// Rewritten follow-up / compare / multi-aspect / derived calculation / English sensitive queries escalate on round 1.
	for (const context of [
		{ query: "Compare Q1 vs Q2 gross margin", queryType: "fact" },
		{ query: "What does Clause 14.2 require?", queryType: "fact" },
		{ query: "对比2024和2025年A公司营收差异", queryType: "follow_up" },
		{ query: "summarize two plans", queryType: "compare" },
		{
			query: "summarize plan details",
			queryType: "fact",
			isMultiAspectFact: true,
		},
		{
			query: "calculate total cost",
			queryType: "fact",
			isDerivedCalculation: true,
		},
	]) {
		const escalated = askRetrievalOptions(autoPolicy, false, context);
		assert.equal(
			escalated.rerankEnabled,
			true,
			`expected round-1 rerank for ${JSON.stringify(context)}`,
		);
		assert.equal(escalated.rerankSparseOnly, undefined);
	}

	// Common English words containing "id" (provide, guide, holiday, evidence, valid, idea) must not false-positive.
	const englishPlain = askRetrievalOptions(autoPolicy, false, {
		query: "Please provide a guide for holiday evidence and valid ideas.",
		queryType: "fact",
		isMultiAspectFact: false,
		isDerivedCalculation: false,
		tableOnly: false,
	});
	assert.equal(englishPlain.rerankEnabled, false);
	assert.equal(englishPlain.rerankSparseOnly, true);

	// Deterministic table probe never forces runtime rerank or sparse-only escalation,
	// even on sensitive auto queries and retry attempts.
	const sensitiveAutoInjected = await injectAskOverrides(
		new TextEncoder().encode(
			JSON.stringify({ question: "Compare Table 1 revenue" }),
		),
		"workspace-a",
		async () => ({ ask: { reranking: "auto" }, policy_version: 2 }),
	);
	assert.equal(sensitiveAutoInjected.ok, true);
	if (!sensitiveAutoInjected.ok) throw new Error("sensitive auto failed");
	const sensitiveAutoPolicy = NativeAskPolicySchema.parse(
		JSON.parse(new TextDecoder().decode(sensitiveAutoInjected.body))
			.ask_overrides,
	);
	assert.equal(sensitiveAutoPolicy.rerank_enabled, true);
	for (const retry of [false, true]) {
		const tableProbe = askRetrievalOptions(sensitiveAutoPolicy, retry, {
			query: "Compare Table 1 revenue",
			queryType: "compare",
			tableOnly: true,
		});
		assert.equal(tableProbe.rerankEnabled, false);
		assert.equal(tableProbe.rerankSparseOnly, undefined);
	}

	// Explicit reranking="off" blocks runtime escalation AND sparse-only escalation.
	const optOutInjected = await injectAskOverrides(
		new TextEncoder().encode(
			JSON.stringify({ question: "Compare Q1 vs Q2 gross margin" }),
		),
		"workspace-a",
		async () => ({ ask: { reranking: "off" }, policy_version: 3 }),
	);
	assert.equal(optOutInjected.ok, true);
	if (!optOutInjected.ok) throw new Error("opt-out injection failed");
	const optOutPolicy = NativeAskPolicySchema.parse(
		JSON.parse(new TextDecoder().decode(optOutInjected.body)).ask_overrides,
	);
	const options = askRetrievalOptions(optOutPolicy, false, {
		query: "Compare Q1 vs Q2 gross margin",
		queryType: "compare",
		isMultiAspectFact: true,
		isDerivedCalculation: true,
	});
	assert.equal(options.rerankEnabled, false);
	assert.equal(options.rerankSparseOnly, undefined);
});
