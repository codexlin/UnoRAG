import assert from "node:assert/strict";
import test from "node:test";
import { DomUtils, parseDocument } from "htmlparser2";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CitationSourceCard } from "../../src/components/app/citation-source-card";
import { MarkdownAnswer } from "../../src/components/app/markdown-answer";
import type { UiCitation } from "../../src/lib/ui-types";

test("source details display the original version snapshot and unscaled retrieval scores", () => {
	const citation: UiCitation = {
		id: "snapshot",
		index: 1,
		title: "制度",
		snippet: "预览",
		text: "召回原始片段",
		score: 0.9,
		bm25Score: 25.3,
		source: {
			id: "snapshot",
			index: 1,
			title: "制度",
			snippet: "预览",
			score: 0.9,
			document_version_id: "source-version-id",
			row_start: 2,
			row_end: 4,
		},
	};
	const html = renderToStaticMarkup(
		createElement(CitationSourceCard, {
			citation,
			expanded: true,
			showDiagnostics: true,
		}),
	);
	const text = DomUtils.textContent(parseDocument(html));
	assert.match(text, /回答所用版本source-version-id/);
	assert.match(text, /来源片段召回原始片段/);
	assert.match(text, /表格行组3 至 5/);
	assert.match(text, /BM2525\.3/);
	assert.doesNotMatch(text, /完整原文|当前生效版本|正确率|概率/);
});

const tableCitation: UiCitation = {
	id: "table-source",
	index: 1,
	title: "设备报价",
	score: 0.9,
	snippet: "服务器 | 120000",
	text: "设备 | 金额\n服务器 | 120000\n存储 | 30000",
	source: {
		id: "table-source",
		index: 1,
		title: "设备报价",
		score: 0.9,
		snippet: "服务器 | 120000",
		record_type: "table",
		table_id: "budget",
		headers: ["设备", "金额"],
		rows: [
			["服务器", "120000"],
			["存储", "30000"],
		],
		row_start: 0,
		row_end: 1,
	},
};

test("expanded table sources render structured snapshots as a keyboard-accessible semantic table", () => {
	const html = renderToStaticMarkup(
		createElement(CitationSourceCard, {
			citation: tableCitation,
			expanded: true,
		}),
	);
	const document = parseDocument(html);
	const [table] = DomUtils.getElementsByTagName("table", document.children);
	assert.ok(table);
	assert.equal(table.attribs["aria-label"], tableCitation.title);
	const headers = DomUtils.getElementsByTagName("th", table.children);
	assert.deepEqual(
		headers.map((cell) => DomUtils.textContent(cell)),
		["设备", "金额"],
	);
	assert.ok(headers.every((cell) => cell.attribs.scope === "col"));
	assert.deepEqual(
		DomUtils.getElementsByTagName("td", table.children).map((cell) =>
			DomUtils.textContent(cell),
		),
		["服务器", "120000", "存储", "30000"],
	);
	const scrollRegion = DomUtils.findOne(
		(element) => element.attribs["aria-label"] === "表格来源片段",
		document.children,
	);
	assert.equal(scrollRegion?.attribs.tabindex, "0");
	assert.match(DomUtils.textContent(document), /表格行组1 至 2/);
	assert.equal(tableCitation.source?.row_start, 0);
	assert.equal(tableCitation.source?.row_end, 1);
});

for (const [name, text, source] of [
	[
		"legacy pipe table",
		"设备 | 金额\n服务器 | 120000",
		{ record_type: "table" },
	],
	[
		"Markdown table",
		"| 设备 | 金额 |\n| :--- | ---: |\n| 服务器 \\| 存储 | 120000 |",
		undefined,
	],
] as const) {
	test(`expanded ${name} uses headers and cells without exposing pipe separators`, () => {
		const citation = {
			...tableCitation,
			text,
			source: source
				? {
						...tableCitation.source,
						...source,
						headers: undefined,
						rows: undefined,
					}
				: undefined,
		} as UiCitation;
		const html = renderToStaticMarkup(
			createElement(CitationSourceCard, { citation, expanded: true }),
		);
		const document = parseDocument(html);
		assert.equal(
			DomUtils.getElementsByTagName("table", document.children).length,
			1,
		);
		assert.equal(
			DomUtils.getElementsByTagName("th", document.children).length,
			2,
		);
		assert.deepEqual(
			DomUtils.getElementsByTagName("td", document.children).map((cell) =>
				DomUtils.textContent(cell),
			),
			[name === "Markdown table" ? "服务器 | 存储" : "服务器", "120000"],
		);
	});
}

for (const text of [
	"设备 | 金额\n服务器 | 120000 | 多余列",
	"设备 | 金额\n---\n服务器 | 120000",
	"设备 | 金额\n--- | --- | ---\n服务器 | 120000",
	"设备 | 金额\n--- | ---",
	"说明文字\n设备 | 金额\n服务器 | 120000",
	"普通来源正文 <script>alert(1)</script>",
]) {
	test(`unparseable table preserves its entire plain text: ${text}`, () => {
		const citation = {
			...tableCitation,
			text,
			source: { ...tableCitation.source, headers: undefined, rows: undefined },
		} as UiCitation;
		const html = renderToStaticMarkup(
			createElement(CitationSourceCard, { citation, expanded: true }),
		);
		const document = parseDocument(html);
		assert.equal(
			DomUtils.getElementsByTagName("table", document.children).length,
			0,
		);
		assert.ok(DomUtils.textContent(document).includes(text));
		assert.equal(
			DomUtils.getElementsByTagName("script", document.children).length,
			0,
		);
	});
}

test("malformed structured rows fall back to text and HTML-looking cells remain inert", () => {
	for (const malformed of [true, false]) {
		const citation = {
			...tableCitation,
			source: {
				...tableCitation.source,
				rows: malformed
					? [["missing column"]]
					: [["<script>alert(1)</script>", "<img src=x onerror=alert(1)>"]],
			},
		} as UiCitation;
		const document = parseDocument(
			renderToStaticMarkup(
				createElement(CitationSourceCard, { citation, expanded: true }),
			),
		);
		assert.equal(
			DomUtils.getElementsByTagName("table", document.children).length,
			malformed ? 0 : 1,
		);
		assert.equal(
			DomUtils.getElementsByTagName("script", document.children).length,
			0,
		);
		assert.equal(
			DomUtils.getElementsByTagName("img", document.children).length,
			0,
		);
		assert.ok(
			DomUtils.textContent(document).includes(
				malformed ? citation.text : "<script>alert(1)</script>",
			),
		);
	}
});

test("a deterministic table answer binds [1] to its selected inline citation", () => {
	const document = parseDocument(
		renderToStaticMarkup(
			createElement(MarkdownAnswer, {
				content: "命中 1 行：\n- 设备：服务器，金额：120000 [1]",
				citations: [tableCitation],
				onCite() {},
			}),
		),
	);
	const [button] = DomUtils.getElementsByTagName("button", document.children);
	assert.equal(button.attribs["data-citation-id"], tableCitation.id);
	assert.equal(button.attribs["aria-label"], "查看引用 1：设备报价");
	assert.equal(DomUtils.textContent(button), "1");
});

test("historical sources without a version remain unrecorded instead of guessing active version", () => {
	const html = renderToStaticMarkup(
		createElement(CitationSourceCard, {
			citation: {
				id: "legacy",
				index: 1,
				title: "旧记录",
				score: 0.8,
				snippet: "旧来源",
				text: "旧来源",
			},
			expanded: true,
		}),
	);
	assert.match(DomUtils.textContent(parseDocument(html)), /回答所用版本未记录/);
});

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
