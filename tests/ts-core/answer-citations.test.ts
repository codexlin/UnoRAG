import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModel } from "ai";
import {
	AnswerCitationGuard,
	AnswerCitationValidationError,
} from "../../src/core/ai/answer-citations";
import { AnswerStreamAdapter } from "../../src/core/ai/answer-stream";

function guarded(chunks: string[], indices = [1, 2]) {
	const guard = new AnswerCitationGuard(indices);
	return chunks.map((chunk) => guard.push(chunk)).join("") + guard.finish();
}

test("source citations survive every token split without buffering ordinary text", () => {
	const text = "价格200元[1][2]。";
	for (let i = 0; i <= text.length; i++) {
		assert.equal(guarded([text.slice(0, i), text.slice(i)]), text);
	}
	assert.equal(guarded([...text]), text);
	const guard = new AnswerCitationGuard([1]);
	assert.equal(guard.push("价格200元["), "价格200元");
	assert.equal(guard.push("1]"), "");
	assert.equal(guard.finish(), "[1]");
});

test("row numbers, lists, ranges, truncated and oversized citations fail closed", () => {
	for (const marker of [
		"[78]",
		"[6–78]",
		"[6, 18, 30]",
		"[1,2]",
		"[0]",
		"[01]",
		"[1",
		`[${"1".repeat(300)}]`,
	]) {
		for (const chunks of [[marker], [...marker]]) {
			assert.throws(() => guarded(chunks), AnswerCitationValidationError);
		}
	}
	assert.throws(() => guarded(["[1]"], []), AnswerCitationValidationError);
});

test("code, escaped brackets, ordinary links and nonnumeric labels remain text", () => {
	for (const text of [
		"`[78]`",
		"```json\n[6, 78]\n```\n[1]",
		"``a`[78]`` [1]",
		"\\[78]",
		"[78](https://example.org)",
		"[说明]",
		"[]",
		"[ ]",
		"[",
	]) {
		assert.equal(guarded([...text]), text);
	}
});

test("stream adapter never emits invalid markers and releases the upstream iterator", async () => {
	let closed = false;
	const adapter = new AnswerStreamAdapter(
		{} as LanguageModel,
		async function* () {
			try {
				yield "价格200元";
				yield "[";
				yield "78]";
				yield "。";
			} finally {
				closed = true;
			}
		},
	);
	let received = "";
	await assert.rejects(
		async () => {
			for await (const token of adapter.stream(
				{ question: "价格", context: "[1]价格200元" },
				{ allowedCitationIndices: [1] },
			))
				received += token;
		},
		(error) =>
			error instanceof AnswerCitationValidationError &&
			error.code === "answer_citation_invalid",
	);
	assert.equal(received, "价格200元");
	assert.equal(closed, true);
});
