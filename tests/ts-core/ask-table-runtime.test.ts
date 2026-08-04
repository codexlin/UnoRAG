import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import type { InternalCitation } from "../../src/core/retrieval";

type ResolveFilename = (
	request: string,
	parent?: unknown,
	isMain?: boolean,
	options?: unknown,
) => string;

const require = createRequire(import.meta.url);
const nodeModule = require("node:module") as {
	_resolveFilename: ResolveFilename;
};
const originalResolveFilename = nodeModule._resolveFilename.bind(nodeModule);
const inertServerOnlyModule = require.resolve("next/package.json");

nodeModule._resolveFilename = (request, parent, isMain, options) =>
	request === "server-only"
		? inertServerOnlyModule
		: originalResolveFilename(request, parent, isMain, options);

const runtimeModule = import(
	"../../src/server/http/ask/native-runtime"
).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

function citation(input: {
	id: string;
	tableId: string;
	device: string;
	amount: string;
}): InternalCitation {
	return {
		id: input.id,
		index: 1,
		title: input.tableId,
		page: "1",
		page_start: 1,
		page_end: 1,
		section_path: null,
		preamble: null,
		table_id: input.tableId,
		headers: ["设备名称", "金额（元）"],
		rows: [[input.device, input.amount]],
		row_start: 0,
		row_end: 0,
		table_row_count: 1,
		snippet: `${input.device} | ${input.amount}`,
		score: 0.9,
		dense_score: 0.9,
		bm25_score: null,
		rrf_score: null,
		used_rerank: false,
		used_hybrid: false,
		text: `${input.device} | ${input.amount}`,
		body: `${input.device} | ${input.amount}`,
		library_id: "library-a",
		doc_id: `doc-${input.tableId}`,
		chunk_index: 0,
		filename: `${input.tableId}.pdf`,
		document_version_id: "version-a",
		generation_id: "generation-a",
		tenant_id: "tenant-a",
		workspace_id: "workspace-a",
		record_type: "table",
		record_id: input.id,
		source_chunk_ids: [],
		source_node_ids: [],
	};
}

test("runtime selects the explicitly planned table among identical headers", async () => {
	const { executePlannedTableQuery } = await runtimeModule;
	const result = executePlannedTableQuery(
		{
			mode: "single",
			tableId: "approved-budget",
			operation: "lookup",
			entity: {
				column: "设备名称",
				value: "服务器",
				match: "exact",
			},
			selectColumns: ["设备名称", "金额（元）"],
			includeSummaryRows: false,
		},
		[
			citation({
				id: "draft-hit",
				tableId: "draft-budget",
				device: "服务器",
				amount: "100000",
			}),
			citation({
				id: "approved-hit",
				tableId: "approved-budget",
				device: "服务器",
				amount: "120000",
			}),
		],
	);

	assert.equal(result?.status, "success");
	assert.equal(result?.matchedRows[0]["金额（元）"], "120000");
	assert.deepEqual(
		result?.evidence.map((item) => item.citationId),
		["approved-hit"],
	);
});

test("runtime refuses absent or ambiguous table identifiers", async () => {
	const { executePlannedTableQuery } = await runtimeModule;
	const plan = {
		mode: "single" as const,
		tableId: "missing-table",
		operation: "count" as const,
		selectColumns: [],
		includeSummaryRows: false,
	};
	assert.equal(
		executePlannedTableQuery(plan, [
			citation({
				id: "only-hit",
				tableId: "other-table",
				device: "服务器",
				amount: "120000",
			}),
		]),
		null,
	);
});

test("structured router fallback remains deterministic and conservative", async () => {
	const { fallbackQueryRoute } = await runtimeModule;
	assert.deepEqual(fallbackQueryRoute("表中有多少行？"), {
		queryType: "table",
		reason: "structured_router_fallback_table",
	});
	assert.deepEqual(fallbackQueryRoute("那么它的金额呢？", 2), {
		queryType: "follow_up",
		reason: "structured_router_fallback_follow_up",
	});
	assert.deepEqual(fallbackQueryRoute("2029年春节团建预算是多少？"), {
		queryType: "fact",
		reason: "structured_router_fallback_fact",
	});
	assert.deepEqual(
		fallbackQueryRoute(
			"服务器主机（CloudMax CM-R7425）的单价大约是多少？它的规格参数要点有哪些？",
		),
		{
			queryType: "fact",
			reason: "structured_router_fallback_fact",
		},
	);
	assert.deepEqual(fallbackQueryRoute("这个"), {
		queryType: "ambiguous",
		reason: "structured_router_fallback_ambiguous",
	});
});

test("judge evidence projection is bounded and excludes raw table rows", async () => {
	const { projectJudgeEvidence } = await runtimeModule;
	const source = citation({
		id: "table-hit",
		tableId: "budget",
		device: "服务器",
		amount: "120000",
	});
	const projected = projectJudgeEvidence([
		{ ...source, body: "证据".repeat(2_000) },
	]);

	assert.equal(projected.length, 1);
	assert.equal(projected[0]?.text.length, 2_401);
	assert.equal("rows" in (projected[0] ?? {}), false);
	assert.equal("tenant_id" in (projected[0] ?? {}), false);
});
