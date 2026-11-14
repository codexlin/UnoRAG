import assert from "node:assert/strict";
import test from "node:test";
import { parseDocument } from "htmlparser2";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hasAskTrace } from "../../src/components/app/ask/ask-trace-drawer";
import { ModelUsagePanel } from "../../src/components/app/model-usage-panel";
import type { ModelUsageSummary } from "../../src/core/ai/model-usage";
import {
	partialModelUsage,
	reportedModelUsage,
	unavailableModelUsage,
	unusedModelUsage,
} from "../fixtures/model-usage";

function content(
	node: ReturnType<typeof parseDocument>["children"][number],
): string {
	if (node.type === "text") return node.data;
	return "children" in node ? node.children.map(content).join("") : "";
}

function render(usage?: ModelUsageSummary | null) {
	const html = renderToStaticMarkup(createElement(ModelUsagePanel, { usage }));
	return { html, text: parseDocument(html).children.map(content).join("") };
}

test("model usage displays authoritative totals without adding cached input twice", () => {
	const { html, text } = render(reportedModelUsage);
	assert.match(text, /输入2,000输出200合计2,200/);
	assert.match(text, /缓存输入 400.*包含在输入内/);
	assert.doesNotMatch(text, /2,600/);
	assert.match(text, /仅 LLM，不含 Embedding \/ Rerank；不代表费用/);
	assert.match(text, /rewrite尝试 1已完成 · 已上报/);
	assert.match(text, /模型rewrite-fixtureProviderfixture-provider/);
	assert.match(html, /aria-label="模型 Token 用量"/);
});

test("partial model usage labels known counts and preserves unknown totals", () => {
	const { html, text } = render(partialModelUsage);
	assert.match(text, /已知输入800已知输出未知已知合计未知/);
	assert.match(text, /不是完整请求总量；未知不计为零/);
	assert.match(text, /judge尝试 1失败 · 用量未知/);
	assert.match(text, /judge尝试 2已完成 · 部分已知/);
	assert.match(text, /generate尝试 1已取消 · 用量未知/);
	assert.doesNotMatch(html, /<dd[^>]*>0<\/dd>/);
});

test("unavailable model usage and missing identities display unknown rather than blank or zero", () => {
	const { html, text } = render(unavailableModelUsage);
	assert.match(text, /输入未知输出未知合计未知/);
	assert.match(text, /模型未知Provider未知/);
	assert.match(text, /模型用量未上报，不能视为零消耗/);
	assert.doesNotMatch(html, /<dd[^>]*>0<\/dd>|<dd[^>]*><\/dd>/);
});

test("legacy missing usage is unrecorded, not unused", () => {
	for (const usage of [undefined, null]) {
		const { html, text } = render(usage);
		assert.match(text, /未记录模型用量/);
		assert.match(text, /不能视为零消耗/);
		assert.doesNotMatch(text, /未调用 LLM/);
		assert.doesNotMatch(html, /<dl|<ol/);
	}
});

test("explicit unused usage displays no LLM call without inventing token counts", () => {
	const { html, text } = render(unusedModelUsage);
	assert.match(text, /此请求未调用 LLM/);
	assert.doesNotMatch(text, /未记录|用量未知/);
	assert.doesNotMatch(html, /<dl|<ol/);
});

test("reported zero counts stay zero instead of becoming unknown", () => {
	const zero = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cachedInputTokens: 0,
	};
	const { text } = render({
		...reportedModelUsage,
		...zero,
		calls: [{ ...reportedModelUsage.calls[0], ...zero }],
	});
	assert.match(text, /输入0输出0合计0/);
	assert.match(text, /缓存输入 0/);
	assert.doesNotMatch(text, /未知/);
});

test("truncated usage discloses retained records and known-only counts", () => {
	const { text } = render({ ...partialModelUsage, truncated: true });
	assert.match(text, /调用记录已截断，仅展示保留的记录/);
	assert.match(text, /已知合计未知/);
});

test("model usage alone makes Ask diagnostics reachable", () => {
	assert.equal(hasAskTrace({ model_usage: reportedModelUsage }), true);
	assert.equal(hasAskTrace({ model_usage: unusedModelUsage }), true);
	assert.equal(hasAskTrace({}), false);
});
