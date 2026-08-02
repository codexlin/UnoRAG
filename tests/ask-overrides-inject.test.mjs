import assert from "node:assert/strict";
import test from "node:test";

import { injectAskOverrides } from "../src/lib/server/ask-overrides-inject.mjs";

function encode(obj) {
	return new TextEncoder().encode(JSON.stringify(obj));
}

function decode(body) {
	return JSON.parse(new TextDecoder().decode(body));
}

test("fail-closed: invalid JSON → 400 and never forwards client ask_overrides", async () => {
	const result = await injectAskOverrides(
		new TextEncoder().encode("{not-json"),
		"ws-1",
		async () => ({ ask: {}, policy_version: 1 }),
	);
	assert.equal(result.ok, false);
	assert.equal(result.status, 400);
});

test("fail-closed: settings read failure → 503 (client overrides stripped, not forwarded)", async () => {
	const result = await injectAskOverrides(
		encode({
			question: "hello",
			ask_overrides: { answer_min_score: 0.01 },
		}),
		"ws-1",
		async () => {
			throw new Error("db down");
		},
	);
	assert.equal(result.ok, false);
	assert.equal(result.status, 503);
	assert.match(result.detail, /workspace policy unavailable/);
});

test("strips client ask_overrides and injects server policy", async () => {
	const result = await injectAskOverrides(
		encode({
			question: "hello",
			ask_overrides: { answer_min_score: 0.01, evil: true },
		}),
		"ws-1",
		async () => ({
			ask: { retrieval_mode: "hybrid" },
			policy_version: 3,
		}),
	);
	assert.equal(result.ok, true);
	const payload = decode(result.body);
	assert.equal(payload.ask_overrides.evil, undefined);
	assert.notEqual(payload.ask_overrides.answer_min_score, 0.01);
	assert.ok(payload.ask_overrides._ask_policy);
	assert.equal(payload.ask_overrides._ask_policy.policy_version, 3);
});

test("non-object JSON → 400", async () => {
	const result = await injectAskOverrides(
		encode(["not", "an", "object"]),
		"ws-1",
		async () => ({ ask: {}, policy_version: 1 }),
	);
	assert.equal(result.ok, false);
	assert.equal(result.status, 400);
});
