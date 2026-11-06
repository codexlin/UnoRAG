import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModel } from "ai";
import {
	AnswerCitationGuard,
	AnswerCitationValidationError,
	projectAnswerCitationDiagnostic,
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
	] as const) {
		for (const chunks of [[marker], [...marker]]) {
			assert.throws(() => guarded(chunks), AnswerCitationValidationError);
		}
	}
	assert.throws(() => guarded(["[1]"], []), AnswerCitationValidationError);
});

test("citation failures classify the cause without retaining model-authored content", () => {
	for (const [marker, category] of [
		["[7]", "unknown_source"],
		["[1,2]", "invalid_format"],
		["[1", "incomplete_marker"],
		[`[${"1".repeat(300)}]`, "marker_too_long"],
	] as const) {
		assert.throws(
			() => guarded([...marker]),
			(error) => {
				assert.ok(error instanceof AnswerCitationValidationError);
				assert.deepEqual(error.diagnostics, {
					category,
					allowedSourceCount: 2,
				});
				assert.equal(JSON.stringify(error).includes(marker), false);
				return true;
			},
		);
	}
	assert.deepEqual(
		projectAnswerCitationDiagnostic({
			category: "unknown_source",
			allowedSourceCount: 1,
			marker: "private",
		}),
		{ category: "unknown_source", allowedSourceCount: 1 },
	);
	assert.equal(
		projectAnswerCitationDiagnostic({
			category: "private error",
			allowedSourceCount: 1,
		}),
		null,
	);
});

test("generation source manifest uses only server-provided indices, not clause numbers", async () => {
	const adapter = new AnswerStreamAdapter(
		{} as LanguageModel,
		async function* (request) {
			assert.match(request.instructions, /服务端来源编号清单/);
			assert.match(request.instructions, /独立来源总数：1/);
			yield "应按第七条处理[source:1]。";
		},
	);
	let output = "";
	for await (const token of adapter.stream(
		{ question: "规则？", context: "[1] 第七条" },
		{ allowedCitationIndices: [1] },
	))
		output += token;
	assert.equal(output, "应按第七条处理[1]。");
});

function modelCitations(chunks: string[], indices = [1, 2]) {
	const guard = new AnswerCitationGuard(indices, true);
	return chunks.map((chunk) => guard.push(chunk)).join("") + guard.finish();
}

test("model source tokens normalize across every split without changing public citation syntax", () => {
	const raw = "按第七条办理[source:1]，另见[source:2]";
	const expected = "按第七条办理[1]，另见[2]";
	for (let split = 0; split <= raw.length; split++)
		assert.equal(
			modelCitations([raw.slice(0, split), raw.slice(split)]),
			expected,
		);
	assert.equal(modelCitations([...raw]), expected);
	assert.equal(guarded([expected]), expected);
});

test("model source tokens never remap unknown sources or leak malformed reserved markers", () => {
	for (const marker of [
		"[source:7]",
		"[source:x]",
		"[source:01]",
		"[source:1,2]",
		"[source:1",
		"[source",
		"[source:1](https://example.org)",
		`[source:${"x".repeat(300)}]`,
		"[7]",
	]) {
		for (const chunks of [[marker], [...marker]])
			assert.throws(
				() => modelCitations(chunks),
				AnswerCitationValidationError,
			);
	}
	assert.throws(
		() => modelCitations(["[source:1]"], []),
		AnswerCitationValidationError,
	);
});

test("reserved tokens inside code and escaped text remain literal, with ordinary labels intact", () => {
	for (const text of [
		"`[source:7]`",
		"```txt\n[source:7]\n```",
		"\\[source:7]",
		"[sourcebook]",
		"[说明]",
		"[78](https://example.org)",
	])
		assert.equal(modelCitations([...text]), text);
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
