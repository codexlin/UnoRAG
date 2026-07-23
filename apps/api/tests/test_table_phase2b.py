"""Phase 2B：table IndexRecord / TableQueryPlan / 幂等 reindex。"""

from __future__ import annotations

from app.services.ingest.chunker import chunk_document
from app.services.ingest.index_record import (
	build_table_records_from_chunks,
	table_record_id,
)
from app.services.ingest.ir import Chunk, DocumentIR, Node, NodeType, SplitStrategy
from app.services.ingest.pipeline import chunks_to_payloads
from app.services.retrieval_plan import build_retrieval_plan
from app.services.table_query import (
	build_table_query_plan,
	execute_table_query,
)


def _quote_chunks() -> list[Chunk]:
	return [
		Chunk(
			chunk_index=0,
			text="x",
			body="供应商名称 | 总价(元)\n甲公司 | 120000",
			section_path=None,
			table_id="t1",
			split_strategy=SplitStrategy.TABLE,
			node_ids=["n-table"],
			meta={
				"headers": ["序号", "供应商名称", "总价(元)"],
				"rows": [
					["1", "甲公司", "120000"],
					["2", "乙科技", "170000"],
					["3", "丙网络", "75000"],
					["4", "丁电子", "45000"],
				],
			},
		)
	]


def test_table_records_split_copy_headers_and_deterministic_ids() -> None:
	chunks = _quote_chunks()
	# 强制小行组：4 行 → 2 个 record，headers 复制
	first = build_table_records_from_chunks(chunks, doc_id="doc-q", max_rows=2)
	second = build_table_records_from_chunks(chunks, doc_id="doc-q", max_rows=2)
	assert len(first) == 2
	assert first[0].record_type == "table"
	assert first[0].headers == ["序号", "供应商名称", "总价(元)"]
	assert first[1].headers == first[0].headers
	assert first[0].row_start == 0 and first[0].row_end == 1
	assert first[1].row_start == 2 and first[1].row_end == 3
	assert first[0].record_id == table_record_id("doc-q", "t1", 0, 1)
	assert [r.record_id for r in first] == [r.record_id for r in second]
	assert [r.point_uuid() for r in first] == [r.point_uuid() for r in second]


def test_chunks_to_payloads_include_tables_idempotent_point_ids() -> None:
	chunks = _quote_chunks()
	a = chunks_to_payloads(chunks, doc_id="doc-q", library_id="lib-1")
	b = chunks_to_payloads(chunks, doc_id="doc-q", library_id="lib-1")
	table_a = [p for p in a if p.get("record_type") == "table"]
	table_b = [p for p in b if p.get("record_type") == "table"]
	assert table_a
	assert {p["_point_id"] for p in table_a} == {p["_point_id"] for p in table_b}
	assert all(p.get("headers") for p in table_a)
	assert all(p.get("row_start") is not None for p in table_a)


def test_retrieval_plan_table_forces_record_type() -> None:
	plan = build_retrieval_plan(
		query_type="table",
		route_reason="table_keyword",
		library_id="lib-1",
		top_k=6,
		hybrid_enabled=False,
		rerank_enabled=False,
	)
	assert plan["execute_path"] == "table"
	assert plan["record_type"] == "table"
	assert plan["filters"]["record_type"] == "table"

	compare = build_retrieval_plan(
		query_type="compare",
		route_reason="compare_keyword",
		library_id="lib-1",
		top_k=6,
		hybrid_enabled=False,
		rerank_enabled=False,
	)
	assert compare["record_type"] == "chunk"
	assert compare["execute_path"] == "short"


def test_table_query_plan_filter_min_lookup() -> None:
	headers = ["供应商名称", "总价(元)"]
	filt = build_table_query_plan("表格里哪些供应商报价超过十万？", headers=headers)
	assert filt["confident"] is True
	assert filt["operation"] == "filter"
	assert filt["operator"] == ">"
	assert filt["value"] == 100_000
	assert "总价" in str(filt["column"])

	mn = build_table_query_plan("最低报价是多少？", headers=headers)
	assert mn["confident"] is True
	assert mn["operation"] == "min"

	lk = build_table_query_plan("甲公司总价是多少？", headers=headers)
	assert lk["confident"] is True
	assert lk["operation"] == "lookup"
	assert lk["entity_value"] == "甲公司"


def test_table_query_execute_on_quote_rows() -> None:
	headers = ["供应商名称", "总价(元)"]
	rows = [
		["甲公司", "120000"],
		["乙科技", "170000"],
		["丙网络", "75000"],
		["丁电子", "45000"],
	]
	filt = build_table_query_plan("超过十万的供应商", headers=headers)
	ex = execute_table_query(filt, headers=headers, rows=rows)
	assert ex["ok"] is True
	assert len(ex["matched_rows"]) == 2
	vals = {str(r.get("总价(元)")) for r in ex["matched_rows"]}
	assert vals == {"120000", "170000"}

	mn = build_table_query_plan("最低报价", headers=headers)
	ex2 = execute_table_query(mn, headers=headers, rows=rows)
	assert ex2["ok"] is True
	assert ex2["answer_value"] == 45000.0

	lk = build_table_query_plan("甲公司总价", headers=headers)
	ex3 = execute_table_query(lk, headers=headers, rows=rows)
	assert ex3["ok"] is True
	assert str(ex3["answer_value"]) == "120000"


def test_table_query_uncertain_no_guess() -> None:
	plan = build_table_query_plan("把那个数算一下再乘税率")
	assert plan["confident"] is False
	assert plan["operation"] == "fallback"


def test_chunker_attaches_table_meta_for_quote_ir() -> None:
	doc = DocumentIR(
		id="doc-1",
		title="报价",
		source_format="docx",
		nodes=[
			Node(
				id="n1",
				type=NodeType.TABLE,
				table_id="t1",
				text="供应商 | 总价\n甲 | 1",
				table_json={
					"headers": ["供应商", "总价"],
					"rows": [["甲公司", "120000"], ["乙", "1"]],
				},
			)
		],
	)
	chunks = chunk_document(doc)
	table_chunks = [c for c in chunks if c.table_id == "t1"]
	assert table_chunks
	assert table_chunks[0].meta.get("headers") == ["供应商", "总价"]
	assert len(table_chunks[0].meta.get("rows") or []) == 2
