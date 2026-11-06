import assert from "node:assert/strict";
import test from "node:test";
import { DocumentIRSchema } from "../../src/core/document-ir";
import {
	buildDocumentContext,
	documentContextText,
} from "../../src/core/document-ir/document-context";
import { chunkDocument } from "../../src/core/ingest/chunking";
import { buildIndexPayloads } from "../../src/core/ingest/index-records";
import { parseTextDocument } from "../../src/core/ingest/text-parser";
import {
	type ActiveDocumentDescriptor,
	executeOutlineQuestion,
	needsDocumentConstraint,
	resolveDocumentConstraint,
} from "../../src/core/retrieval/document-constraints";
import { publicParserReport } from "../../src/lib/parser-report-public";

function document() {
	return DocumentIRSchema.parse({
		id: "doc-a",
		title: "manual.docx",
		filename: "manual.docx",
		nodes: [
			{ id: "h1", type: "heading", text: "访问控制规程", level: 1 },
			{
				id: "p",
				type: "paragraph",
				text: "文件编号：SEC-ACCESS-27\n设备型号 SKU-ABC-123",
			},
			{ id: "h2a", type: "heading", text: "账户生命周期", level: 2 },
			{ id: "p2", type: "paragraph", text: "离职账户当日禁用。" },
			{ id: "h3", type: "heading", text: "审批记录", level: 3 },
			// Deliberately no paragraph below this heading.
			{ id: "h2b", type: "heading", text: "访问审计", level: 2 },
			{ id: "h1b", type: "heading", text: "附录", level: 1 },
		],
	});
}

function descriptor(
	overrides: Partial<ActiveDocumentDescriptor> = {},
): ActiveDocumentDescriptor {
	return {
		documentId: "doc-a",
		generationId: "gen-a",
		filename: "manual.docx",
		context: buildDocumentContext(document()),
		...overrides,
	};
}

function required<T>(value: T | null | undefined): T {
	assert.ok(value != null);
	return value;
}

test("document context retains actual heading levels and empty headings, not SKUs", () => {
	const context = buildDocumentContext(document());
	assert.deepEqual(context.identifiers, ["SEC-ACCESS-27"]);
	assert.equal(context.outline_complete, true);
	assert.deepEqual(
		context.outline.map((heading) => heading.level),
		[1, 2, 3, 2, 1],
	);
	assert.match(documentContextText(context), /## 访问审计/);
});

test("identity labels support whitespace and colon without promoting arbitrary equipment numbers", () => {
	const doc = document();
	for (const [label, expected] of [
		["制度编号 FIN-TRAVEL-27。", "FIN-TRAVEL-27"],
		["编号 OPS-MAINT-27。", "OPS-MAINT-27"],
		["Document No: OPS-MAINT-28", "OPS-MAINT-28"],
	]) {
		required(doc.nodes[1]).text = required(label);
		assert.deepEqual(buildDocumentContext(doc).identifiers, [expected]);
	}
	required(doc.nodes[1]).text = "设备编号 SKU-EQUIP-123";
	assert.deepEqual(buildDocumentContext(doc).identifiers, []);
});

test("structure is incomplete for partial parsing, unknown levels and exceeded budgets", () => {
	const partial = document();
	partial.parser_report.partial = true;
	assert.equal(buildDocumentContext(partial).outline_complete, false);
	assert.equal(buildDocumentContext(partial).identifiers_complete, false);
	assert.equal(
		resolveDocumentConstraint(
			"SEC-ACCESS-27 的内容？",
			[
				descriptor(),
				descriptor({
					documentId: "partial",
					context: buildDocumentContext(partial),
				}),
			],
			true,
		).status,
		"unavailable",
	);
	const unknown = document();
	required(unknown.nodes[0]).level = null;
	assert.equal(buildDocumentContext(unknown).outline_complete, false);
	const long = document();
	long.nodes = Array.from({ length: 257 }, (_, i) => ({
		...required(long.nodes[0]),
		id: `h-${i}`,
		text: `目录 ${i}`,
	}));
	const context = buildDocumentContext(long);
	assert.equal(context.outline_complete, false);
	assert.equal(context.outline.length, 256);
	const manyIds = document();
	manyIds.nodes = Array.from({ length: 33 }, (_, index) => ({
		...required(manyIds.nodes[1]),
		id: `id-${index}`,
		text: `文件编号：SEC-DOC-${index}`,
	}));
	const identities = buildDocumentContext(manyIds);
	assert.equal(identities.identifiers.length, 32);
	assert.equal(identities.identifiers_complete, false);
	assert.equal(
		resolveDocumentConstraint(
			"SEC-DOC-0 的规则？",
			[descriptor({ context: identities })],
			true,
		).status,
		"unavailable",
	);
	assert.equal(
		resolveDocumentConstraint(
			"headings.docx 中账户的禁用时间？",
			[descriptor({ filename: "headings.docx" })],
			true,
		).outlineLevel,
		undefined,
	);
});

test("explicit filenames resolve only against the supplied authorized active catalog", () => {
	const allowed = descriptor();
	assert.deepEqual(
		resolveDocumentConstraint("MANUAL.DOCX 的二级标题有哪些？", [allowed], true)
			.documents,
		[allowed],
	);
	assert.equal(
		resolveDocumentConstraint("secret.docx 的内容？", [allowed], true).status,
		"unavailable",
	);
	assert.equal(
		resolveDocumentConstraint("manual.docx 的内容？", [], true).status,
		"unavailable",
	);
	assert.equal(
		resolveDocumentConstraint(
			"manual.docx 的内容？",
			[allowed, descriptor({ documentId: "other" })],
			true,
		).status,
		"ambiguous",
	);
	assert.equal(
		resolveDocumentConstraint("manual.docx 的内容？", [allowed], false).status,
		"unavailable",
	);
});

test("known document codes anchor while SKUs do not, and contradicting identities fail closed", () => {
	const allowed = descriptor();
	assert.equal(
		resolveDocumentConstraint("SEC-ACCESS-27 的禁用时间？", [allowed], true)
			.status,
		"resolved",
	);
	assert.equal(
		resolveDocumentConstraint("SKU-EQUIP-123 多少钱？", [allowed], true).status,
		"none",
	);
	assert.equal(
		resolveDocumentConstraint("文号 SEC-MISSING-27 的内容？", [allowed], true)
			.status,
		"unavailable",
	);
	const other = descriptor({
		documentId: "other",
		filename: "other.docx",
		context: { ...required(allowed.context), identifiers: ["SEC-OTHER-27"] },
	});
	assert.equal(
		resolveDocumentConstraint(
			"manual.docx 中 SEC-OTHER-27 的内容？",
			[allowed, other],
			true,
		).status,
		"unavailable",
	);
	assert.equal(
		resolveDocumentConstraint(
			"SEC-ACCESS-27 的内容？",
			[
				allowed,
				descriptor({ documentId: "old", filename: "old.docx", context: null }),
			],
			true,
		).status,
		"unavailable",
	);
});

test("phase subject anchors to document title without using a fixture-specific business vocabulary", () => {
	const a = descriptor({
		context: { ...required(descriptor().context), title: "库存盘点操作清单" },
	});
	const b = descriptor({
		documentId: "other",
		filename: "recovery.md",
		context: { ...required(a.context), title: "库存恢复操作规程" },
	});
	const result = resolveDocumentConstraint(
		"库存盘点前，需要核对哪些批次？",
		[a, b],
		true,
	);
	assert.deepEqual(
		result.documents.map((doc) => doc.documentId),
		[a.documentId],
	);
	assert.equal(
		resolveDocumentConstraint(
			"库存盘点前，需要核对哪些批次？",
			[a, descriptor({ ...a, documentId: "duplicate" })],
			true,
		).status,
		"ambiguous",
	);
	assert.equal(needsDocumentConstraint("普通账户如何登录？"), false);
	assert.equal(needsDocumentConstraint("备份目录的路径如何配置？"), false);
	assert.equal(
		resolveDocumentConstraint(
			"manual.docx 的备份目录路径是什么？",
			[descriptor()],
			true,
		).outlineLevel,
		undefined,
	);
});

test("complete outline execution preserves levels, sibling coverage and limits the parent subtree", () => {
	const catalog = [descriptor()];
	const question = "manual.docx 的二级标题包含哪些管理主题？";
	const result = executeOutlineQuestion(
		question,
		resolveDocumentConstraint(question, catalog, true),
	);
	assert.match(required(result), /账户生命周期/);
	assert.match(required(result), /访问审计/);
	assert.doesNotMatch(required(result), /审批记录/);
	const children = "manual.docx 中“访问控制规程”下面有哪些子标题？";
	assert.match(
		required(
			executeOutlineQuestion(
				children,
				resolveDocumentConstraint(children, catalog, true),
			),
		),
		/访问审计/,
	);
	assert.equal(
		executeOutlineQuestion(
			"manual.docx 的二级标题有哪些以及金额多少？",
			resolveDocumentConstraint(question, catalog, true),
		),
		null,
	);
	for (const compound of [
		"manual.docx 的二级标题有哪些？作者是谁？",
		"manual.docx 的二级标题有哪些，写一首诗",
		"manual.docx 的一二级标题有哪些？",
		"manual.docx 的一级标题、二级标题有哪些？",
	]) {
		assert.equal(
			executeOutlineQuestion(
				compound,
				resolveDocumentConstraint(compound, catalog, true),
			),
			null,
		);
	}
	assert.equal(
		executeOutlineQuestion(
			question,
			resolveDocumentConstraint(
				question,
				[descriptor({ context: null })],
				true,
			),
		),
		null,
	);
	assert.equal(
		executeOutlineQuestion(
			question,
			resolveDocumentConstraint(
				question,
				[
					descriptor({
						context: {
							...required(required(catalog[0]).context),
							outline_complete: false,
						},
					}),
				],
				true,
			),
		),
		null,
	);
});

test("document index is generation-scoped and includes headings that produce no body chunk", async () => {
	const doc = document();
	const chunks = await chunkDocument(doc);
	const options = {
		documentId: doc.id,
		documentVersionId: "version-a",
		generationId: "10000000-0000-4000-8000-000000000001",
		libraryId: "lib",
		organizationId: "org",
		workspaceId: "ws",
		filename: doc.filename,
		document: doc,
	};
	const records = buildIndexPayloads(chunks, options);
	const record = required(
		records.find((item) => item.record_type === "document"),
	);
	assert.equal(record.body, documentContextText(buildDocumentContext(doc)));
	assert.ok(record.embed_text.length <= 1_400);
	assert.equal(record.embed_text.includes("访问审计"), false);
	assert.ok(record.source_node_ids?.includes("h2b"));
	const replacement = required(
		buildIndexPayloads(chunks, {
			...options,
			generationId: "10000000-0000-4000-8000-000000000002",
		}).find((item) => item.record_type === "document"),
	);
	assert.notEqual(record._point_id, replacement._point_id);
	const large = document();
	large.nodes.push({
		...required(large.nodes[1]),
		id: "identities",
		text: Array.from(
			{ length: 32 },
			(_, i) => `文件编号：DOC-${i}-${"X".repeat(110)}`,
		).join("\n"),
	});
	const bounded = required(
		buildIndexPayloads(await chunkDocument(large), {
			...options,
			document: large,
		}).find((item) => item.record_type === "document"),
	);
	assert.equal(bounded.embed_text.length, 1_400);
	assert.ok(required(bounded.body).length > bounded.embed_text.length);
});

test("parser diagnostics strip content context without mutating persisted metadata", () => {
	const context = buildDocumentContext(document());
	const report = {
		parser: "docx",
		metrics: { document_context: context, heading_count: 5 },
	};
	assert.deepEqual(publicParserReport(report), {
		parser: "docx",
		metrics: { heading_count: 5 },
	});
	assert.equal(report.metrics.document_context, context);
	assert.equal(publicParserReport(null), null);
});

test("native text parser identity metadata is extracted from structured paragraph content", () => {
	const doc = parseTextDocument({
		documentId: "d",
		libraryId: "l",
		filename: "checklist.md",
		contentHash: "test-hash",
		sourceFormat: "md",
		content: new TextEncoder().encode(
			"# 库存盘点检查清单\n\n编号 OPS-STOCK-27。\n\n## 盘点前\n必须核对批次。",
		),
	});
	assert.deepEqual(buildDocumentContext(doc).identifiers, ["OPS-STOCK-27"]);
});
