import assert from "node:assert/strict";
import test from "node:test";
import {
	buildSparseBackfillPoint,
	indexedLexicalText,
} from "../../scripts/qdrant-backfill-sparse";

test("indexedLexicalText prefixes contextual_prefix for ordinary chunks only", () => {
	assert.equal(
		indexedLexicalText({
			record_type: "chunk",
			contextual_prefix: "第一章 总则",
			body: "系统必须执行权限隔离。",
		}),
		"第一章 总则\n系统必须执行权限隔离。",
	);
	assert.equal(
		indexedLexicalText({
			record_type: "chunk",
			table_id: "tbl-1",
			contextual_prefix: "第一章 总则",
			body: "表格内容",
		}),
		"表格内容",
	);
});

test("buildSparseBackfillPoint converts unnamed dense vector to named dense + lexical_v1", () => {
	const point = buildSparseBackfillPoint({
		id: "pt-1",
		vector: [0.1, 0.2, 0.3],
		payload: {
			record_type: "chunk",
			text: "和达科技 智慧水务 云解决方案",
			doc_id: "doc-1",
		},
	});
	assert.equal(point.id, "pt-1");
	assert.deepEqual(
		(point.vector as Record<string, unknown>).dense,
		[0.1, 0.2, 0.3],
	);
	const sparse = (point.vector as Record<string, unknown>).lexical_v1 as {
		indices: number[];
		values: number[];
	};
	assert.ok(sparse.indices.length > 0);
	assert.equal(sparse.indices.length, sparse.values.length);
});
