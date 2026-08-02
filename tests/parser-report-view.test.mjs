import assert from "node:assert/strict";
import test from "node:test";

import {
	dedupeTechDetails,
	formatParserReportView,
	isParserReportDegraded,
	PARSE_DEGRADED_REINDEX_HINT,
	PARSE_DEGRADED_STATUS_LABEL,
	PARSER_REPORT_TITLE,
	resolveDocumentStatusDisplay,
} from "../src/lib/parser-report-view.mjs";

test("title is 最新解析报告", () => {
	assert.equal(PARSER_REPORT_TITLE, "最新解析报告");
	assert.equal(formatParserReportView({}).title, "最新解析报告");
	assert.equal(formatParserReportView({}).degraded, false);
});

test("layers degrade + partial and dedupes tech details", () => {
	const view = formatParserReportView({
		partial: true,
		failed_pages: [2, 5],
		warnings: [
			"MinerU 不可用，已用基础解析（PyMuPDF）: MinerU unreachable: [Errno 61] Connection refused",
			"MinerU unreachable: [Errno 61] Connection refused",
		],
		notes: "; mineru_degrade=MinerU unreachable: [Errno 61] Connection refused",
		metrics: {
			route: "pymupdf_degrade",
			mineru_error: "MinerU unreachable: [Errno 61] Connection refused",
		},
	});

	assert.deepEqual(view.summaries, [
		"已用基础解析（PyMuPDF）· MinerU 暂不可用",
		"部分页未解析（失败页 2, 5）",
	]);
	assert.deepEqual(view.techDetails, [
		"MinerU unreachable: [Errno 61] Connection refused",
	]);
	assert.equal(view.empty, false);
	assert.equal(view.degraded, true);
	assert.ok(
		!view.summaries.some((line) =>
			/Errno|Connection refused|mineru_degrade=/i.test(line),
		),
	);
});

test("isParserReportDegraded detects route and notes", () => {
	assert.equal(
		isParserReportDegraded({ metrics: { route: "pymupdf_degrade" } }),
		true,
	);
	assert.equal(
		isParserReportDegraded({ metrics: { route: "pymupdf_no_mineru" } }),
		true,
	);
	assert.equal(
		isParserReportDegraded({
			notes: "; mineru_degrade=MinerU unreachable",
		}),
		true,
	);
	assert.equal(
		isParserReportDegraded({ metrics: { route: "pymupdf" } }),
		false,
	);
});

test("resolveDocumentStatusDisplay uses 已就绪（降级） for ready+degrade", () => {
	const degradedReady = resolveDocumentStatusDisplay("ready", {
		metrics: { route: "pymupdf_degrade" },
	});
	assert.equal(degradedReady.label, PARSE_DEGRADED_STATUS_LABEL);
	assert.equal(degradedReady.label, "已就绪（降级）");
	assert.equal(degradedReady.tone, "degraded");
	assert.equal(degradedReady.parseDegraded, true);

	const plainReady = resolveDocumentStatusDisplay("ready", {
		metrics: { route: "pymupdf" },
	});
	assert.equal(plainReady.label, "就绪");
	assert.equal(plainReady.parseDegraded, false);

	const lifecycleDegraded = resolveDocumentStatusDisplay("degraded", null);
	assert.equal(lifecycleDegraded.label, "降级可用");
	assert.equal(lifecycleDegraded.tone, "degraded");

	assert.match(PARSE_DEGRADED_REINDEX_HINT, /重新索引/);
});

test("circuit-open degrade uses 短窗熔断 user copy", () => {
	const view = formatParserReportView({
		partial: true,
		warnings: ["MinerU 不可用，已用基础解析（PyMuPDF）（短窗熔断）"],
		metrics: { route: "pymupdf_degrade", mineru_circuit: "open" },
	});
	assert.equal(
		view.summaries[0],
		"已用基础解析（PyMuPDF）· MinerU 暂不可用（短窗熔断）",
	);
	assert.deepEqual(view.techDetails, []);
});

test("dedupeTechDetails keeps longer overlapping line", () => {
	assert.deepEqual(
		dedupeTechDetails([
			"MinerU unreachable",
			"MinerU unreachable: [Errno 61] Connection refused",
			"; mineru_degrade=MinerU unreachable: [Errno 61] Connection refused",
		]),
		["MinerU unreachable: [Errno 61] Connection refused"],
	);
});

test("empty success report", () => {
	const view = formatParserReportView({
		partial: false,
		warnings: [],
		notes: "",
		metrics: { route: "pymupdf" },
	});
	assert.equal(view.empty, true);
	assert.deepEqual(view.summaries, []);
	assert.deepEqual(view.techDetails, []);
});
