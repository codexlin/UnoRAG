import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownAnswer } from "../../src/components/app/markdown-answer";
import type { UiCitation } from "../../src/lib/ui-types";

test("unknown historical source numbers stay plain text instead of fake citation badges", () => {
	const html = renderToStaticMarkup(
		createElement(MarkdownAnswer, {
			content: "价格[1]，第78行不是来源[78]。",
			citations: [{ index: 1, title: "报价", score: 1 }] as UiCitation[],
			onCite() {},
		}),
	);
	assert.equal((html.match(/<button/g) ?? []).length, 1);
	assert.match(html, /\[78\]/);
});

test("numeric Markdown links and code are not converted into citation buttons", () => {
	const html = renderToStaticMarkup(
		createElement(MarkdownAnswer, {
			content: "`[1]` 和 [1](https://example.org) 不是来源标记。",
			citations: [{ index: 1, title: "报价", score: 1 }] as UiCitation[],
			onCite() {},
		}),
	);
	assert.equal(html.includes("<button"), false);
	assert.match(html, /href="https:\/\/example.org"/);
});
