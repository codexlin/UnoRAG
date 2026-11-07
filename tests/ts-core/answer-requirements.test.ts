import assert from "node:assert/strict";
import test from "node:test";
import { buildAnswerMessages } from "../../src/core/ai/answer-stream";
import { deriveAnswerRequirements } from "../../src/core/ask-graph/answer-requirements";

test("Judge precision describes the requested field without assuming evidence sufficiency", () => {
	for (const question of [
		"维护前应做什么检查？",
		"上线前必须完成哪项校验？",
		"客户需要提交哪些材料？",
		"检查名称是什么？",
		"只列检查名称，不需要未列明的操作步骤。",
		"操作步骤.pdf 中检查名称是什么？",
	]) {
		assert.deepEqual(deriveAnswerRequirements(question), {
			granularity: "named_requirement",
			formal_name_required: false,
		});
	}
	assert.deepEqual(deriveAnswerRequirements("该检查的正式名称是什么？"), {
		granularity: "named_requirement",
		formal_name_required: true,
	});
});

test("explicit procedure precision takes precedence and unrelated scalar fields stay unspecified", () => {
	for (const question of [
		"请列出具体检查项和校验算法。",
		"这项检查的名称和详细步骤是什么？",
		"如何进行验证？",
		"不要细节，但需要详细操作步骤。",
	])
		assert.equal(
			deriveAnswerRequirements(question).granularity,
			"procedure_details",
		);
	for (const question of [
		"员工填写的天数是多少？",
		"接收地点的街道与门牌号是什么？",
		"操作步骤.pdf 中有哪些二级标题？",
		"需要哪些材料，并在几天内提交？",
		"检查名称是什么、由谁签字？",
	])
		assert.equal(deriveAnswerRequirements(question).granularity, "unspecified");
});

test("generation receives the same precision contract without changing legacy message shape", () => {
	const plain = {
		question: "应做什么检查？",
		context: "[1] 必须完成密封检查。",
	};
	assert.equal(
		buildAnswerMessages(plain)[0]?.content,
		`资料：\n${plain.context}\n\n问题：${plain.question}`,
	);
	const messages = buildAnswerMessages({
		...plain,
		requirements: deriveAnswerRequirements(plain.question),
	});
	assert.equal(typeof messages[0]?.content, "string");
	assert.match(String(messages[0]?.content), /named_requirement/);
	assert.match(String(messages[0]?.content), /必须完成密封检查/);
});
