import assert from "node:assert/strict";
import test from "node:test";
import { DomUtils, parseDocument } from "htmlparser2";
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

test("wrapping does not change long inline code, text, or link destinations", () => {
	const marker = `RECOVERY_PROOF_${"ABCD0123".repeat(20)}`;
	const url = `https://example.org/${"long-path-".repeat(30)}`;
	const html = renderToStaticMarkup(
		createElement(MarkdownAnswer, {
			content: `\`${marker}\`\n\n${marker}\n\n[${url}](${url})`,
		}),
	);
	const document = parseDocument(html);
	const [code] = DomUtils.getElementsByTagName("code", document.children);
	const [link] = DomUtils.getElementsByTagName("a", document.children);
	assert.equal(DomUtils.textContent(code), marker);
	assert.equal(DomUtils.textContent(link), url);
	assert.equal(link.attribs.href, url);
	assert.equal(DomUtils.textContent(document).split(marker).length - 1, 2);
});

for (const language of ["ts", ""]) {
	test(`fenced code ${language || "without a language"} has valid pre/code structure and preserves indentation`, () => {
		const snippet = `  ${"CODE_TOKEN_".repeat(30)}\n    next line`;
		const html = renderToStaticMarkup(
			createElement(MarkdownAnswer, {
				content: `\`\`\`${language}\n${snippet}\n\`\`\``,
			}),
		);
		const document = parseDocument(html);
		const blocks = DomUtils.getElementsByTagName("pre", document.children);
		assert.equal(blocks.length, 1);
		const codes = DomUtils.getElementsByTagName("code", blocks[0].children);
		assert.equal(codes.length, 1);
		assert.equal(DomUtils.textContent(codes[0]), snippet);
		assert.equal(
			DomUtils.getElementsByTagName("div", blocks[0].children).length,
			0,
		);
		assert.equal(
			DomUtils.getElementsByTagName("button", document.children).length,
			1,
		);
	});
}
