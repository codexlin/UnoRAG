"""Phase 2B：table IndexRecord / TableQueryPlan / 幂等 reindex。"""

from __future__ import annotations

from app.graph.ask_graph import build_ask_graph, stub_generate
from app.services.ingest.chunker import chunk_document
from app.services.ingest.index_record import (
	DEFAULT_TABLE_MAX_ROWS,
	build_table_records_from_chunks,
	table_record_id,
)
from app.services.ingest.ir import Chunk, DocumentIR, Node, NodeType, SplitStrategy
from app.services.ingest.pipeline import chunks_to_payloads
from app.services.retrieval_plan import build_retrieval_plan
from app.services.table_query import (
	EVIDENCE_GROUPS_LIMIT,
	MATCHED_ROWS_PREVIEW_LIMIT,
	_cell_number,
	build_table_query_plan,
	citations_with_matched_evidence,
	execute_table_query,
	merge_table_hits_for_execute,
	prepare_table_for_execute,
	select_evidence_groups,
	table_instance_key,
)
from app.settings import Settings


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


def test_same_table_id_across_docs_do_not_mix() -> None:
	"""两文档均有 t1：合并/定位不得混行、混表头。"""
	citations = [
		{
			"record_type": "table",
			"doc_id": "doc-a",
			"document_version_id": "doc-a:v1",
			"table_id": "t1",
			"score": 0.95,
			"headers": ["供应商", "总价"],
			"rows": [["甲公司", "120000"]],
			"row_start": 0,
			"row_end": 0,
			"table_row_count": 2,
		},
		{
			"record_type": "table",
			"doc_id": "doc-b",
			"document_version_id": "doc-b:v1",
			"table_id": "t1",
			"score": 0.80,
			"headers": ["产品", "单价"],
			"rows": [["芯片", "99"]],
			"row_start": 0,
			"row_end": 0,
			"table_row_count": 1,
		},
		{
			"record_type": "table",
			"doc_id": "doc-a",
			"document_version_id": "doc-a:v1",
			"table_id": "t1",
			"score": 0.90,
			"headers": ["供应商", "总价"],
			"rows": [["乙科技", "170000"]],
			"row_start": 1,
			"row_end": 1,
			"table_row_count": 2,
		},
	]
	assert table_instance_key(citations[0]) != table_instance_key(citations[1])
	merged = merge_table_hits_for_execute(citations)
	assert merged["doc_id"] == "doc-a"
	assert merged["table_id"] == "t1"
	assert merged["headers"] == ["供应商", "总价"]
	assert merged["complete"] is True
	assert len(merged["rows"]) == 2
	assert merged["rows"][0][0] == "甲公司"
	assert all(row[0] != "芯片" for row in merged["rows"])


def test_large_table_full_load_aggregate_not_top_k_subset() -> None:
	"""大表超出 top_k×40 行：必须全表加载后聚合；仅 citation 子集不得标 complete。"""
	max_rows = DEFAULT_TABLE_MAX_ROWS
	top_k = 6
	total_rows = top_k * max_rows + 50  # > top_k×40
	headers = ["供应商", "总价"]
	all_rows = [[f"供应商{i}", str(1000 + i)] for i in range(total_rows)]
	# 最低价在最后一组（向量 top_k 通常拿不到）
	all_rows[-1] = ["最低供应商", "1"]

	full_groups: list[dict] = []
	for start in range(0, total_rows, max_rows):
		end = min(total_rows, start + max_rows) - 1
		full_groups.append(
			{
				"record_type": "table",
				"doc_id": "doc-big",
				"document_version_id": "doc-big:v1",
				"table_id": "t1",
				"headers": headers,
				"rows": all_rows[start : end + 1],
				"row_start": start,
				"row_end": end,
				"table_row_count": total_rows,
				"score": 0.5,
			}
		)

	# 模拟 vector retrieve：仅前 top_k 组（连续前缀，但缺尾部）
	citations = [{**g, "score": 0.9 - i * 0.01} for i, g in enumerate(full_groups[:top_k])]
	partial = prepare_table_for_execute(citations, load_table_groups=None)
	assert partial["complete"] is False
	assert "truncated" in str(partial.get("reason"))

	def _load(**_kwargs):
		return full_groups

	full = prepare_table_for_execute(citations, load_table_groups=_load)
	assert full["complete"] is True
	assert len(full["rows"]) == total_rows
	plan = build_table_query_plan("最低报价是多少？", headers=headers)
	ex = execute_table_query(plan, headers=headers, rows=full["rows"])
	assert ex["ok"] is True
	assert ex["answer_value"] == 1.0
	assert any("最低供应商" in str(r.values()) for r in ex["matched_rows"])


def test_cell_number_chinese_units() -> None:
	assert _cell_number("12万") == 120_000.0
	assert _cell_number("1.5千") == 1_500.0
	assert _cell_number("2亿元") == 200_000_000.0
	assert _cell_number("12万元") == 120_000.0
	# 含单位却无法可靠解析 → None，不得截成 12
	assert _cell_number("十二万左右") is None

	headers = ["供应商", "总价"]
	rows = [
		["甲", "12万"],
		["乙", "1.5千"],
		["丙", "80000"],
	]
	plan = build_table_query_plan("超过十万的供应商", headers=headers)
	ex = execute_table_query(plan, headers=headers, rows=rows)
	assert ex["ok"] is True
	assert len(ex["matched_rows"]) == 1
	assert ex["matched_rows"][0].get("供应商") == "甲"


def test_ascii_filter_parses_numeric_units() -> None:
	"""ASCII 比较式须识别万/千/亿，不得把「>= 10万」当成 10。"""
	headers = ["供应商", "总价"]
	plan = build_table_query_plan("总价 >= 10万", headers=headers)
	assert plan["confident"] is True
	assert plan["operation"] == "filter"
	assert plan["operator"] == ">="
	assert plan["value"] == 100_000.0

	plan_k = build_table_query_plan("报价 > 1.5千", headers=headers)
	assert plan_k["confident"] is True
	assert plan_k["value"] == 1_500.0

	rows = [
		["甲", "120000"],
		["乙", "80000"],
		["丙", "10万"],
	]
	ex = execute_table_query(plan, headers=headers, rows=rows)
	assert ex["ok"] is True
	names = {str(r.get("供应商")) for r in ex["matched_rows"]}
	assert names == {"甲", "丙"}


def test_ascii_filter_parses_thousand_separators() -> None:
	"""千分位不得在逗号处截断成 100.0。"""
	headers = ["供应商", "总价"]
	cases = [
		("总价 >= 100,000", 100_000.0),
		("总价 >= 100，000", 100_000.0),
		("总价 >= 1,000.50", 1_000.50),
		("总价大于100,000", 100_000.0),
		("总价不低于100，000", 100_000.0),
	]
	for question, expected in cases:
		plan = build_table_query_plan(question, headers=headers)
		assert plan["confident"] is True, question
		assert plan["operation"] == "filter", question
		assert plan["value"] == expected, question

	rows = [
		["甲", "120000"],
		["乙", "90000"],
		["丙", "1000.5"],
		["丁", "999.9"],
	]
	ex = execute_table_query(
		build_table_query_plan("总价 >= 100,000", headers=headers),
		headers=headers,
		rows=rows,
	)
	assert ex["ok"] is True
	assert ex["matched_count"] == 1
	assert ex["matched_rows"][0].get("供应商") == "甲"

	ex_decimal = execute_table_query(
		build_table_query_plan("总价 >= 1,000.50", headers=headers),
		headers=headers,
		rows=rows,
	)
	assert ex_decimal["ok"] is True
	assert ex_decimal["matched_count"] == 3
	names = {str(r.get("供应商")) for r in ex_decimal["matched_rows"]}
	assert names == {"甲", "乙", "丙"}
	assert "丁" not in names


def test_wide_match_previews_rows_and_caps_evidence_groups() -> None:
	"""宽过滤/count：matched_rows 仅预览；证据组有上限并记录截断审计。"""
	headers = ["供应商", "总价"]
	total_rows = 400
	rows = [[f"供应商{i}", str(1000 + i)] for i in range(total_rows)]
	plan = build_table_query_plan("有多少行？", headers=headers)
	ex = execute_table_query(
		plan,
		headers=headers,
		rows=rows,
		collect_evidence_indices=True,
	)
	evidence_indices = ex.pop("_evidence_row_indices")
	assert ex["ok"] is True
	assert ex["matched_count"] == total_rows
	assert ex["answer_value"] == total_rows
	assert len(ex["matched_rows"]) == MATCHED_ROWS_PREVIEW_LIMIT
	assert ex["matched_rows_truncated"] is True
	assert len(ex["matched_row_indices"]) == MATCHED_ROWS_PREVIEW_LIMIT
	assert ex["matched_row_indices_truncated"] is True
	assert len(evidence_indices) == total_rows
	assert "_evidence_row_indices" not in ex

	# 每组 40 行 → 10 个证据组；应截断到 EVIDENCE_GROUPS_LIMIT
	groups = []
	group_size = 40
	for start in range(0, total_rows, group_size):
		end = min(start + group_size - 1, total_rows - 1)
		groups.append(
			{
				"id": f"g{start}",
				"record_type": "table",
				"doc_id": "doc-wide",
				"document_version_id": "doc-wide:v1",
				"table_id": "t1",
				"headers": headers,
				"rows": rows[start : end + 1],
				"row_start": start,
				"row_end": end,
				"table_row_count": total_rows,
				"score": 0.5,
				"body": f"rows {start}-{end}",
			}
		)
	assert len(groups) == 10

	selected = select_evidence_groups(
		groups,
		matched_row_indices=evidence_indices,
	)
	assert selected["total_group_count"] == 10
	assert selected["evidence_truncated"] is True
	assert selected["evidence_group_count"] == EVIDENCE_GROUPS_LIMIT
	assert len(selected["groups"]) == EVIDENCE_GROUPS_LIMIT
	assert selected["groups"][0]["row_start"] == 0

	final, meta = citations_with_matched_evidence(
		[dict(groups[0])],
		groups=groups,
		matched_rows=ex["matched_rows"],
		matched_row_indices=evidence_indices,
		target_key=table_instance_key(groups[0]),
		seed_citation=groups[0],
	)
	assert meta["total_group_count"] == 10
	assert meta["evidence_truncated"] is True
	assert meta["evidence_group_count"] == EVIDENCE_GROUPS_LIMIT
	assert sum(1 for c in final if c.get("table_id") == "t1") == EVIDENCE_GROUPS_LIMIT

	filter_ex = execute_table_query(
		build_table_query_plan("总价 >= 0", headers=headers),
		headers=headers,
		rows=rows,
	)
	assert filter_ex["matched_count"] == total_rows
	assert len(filter_ex["answer_value"]) == MATCHED_ROWS_PREVIEW_LIMIT
	assert filter_ex["answer_value_truncated"] is True
	assert len(filter_ex["matched_row_indices"]) == MATCHED_ROWS_PREVIEW_LIMIT
	assert "_evidence_row_indices" not in filter_ex


def test_ask_graph_drops_internal_evidence_indices() -> None:
	"""全量行号只允许存在于 table_execute 节点局部，不得进入最终 state/archive。"""
	headers = ["供应商", "总价"]
	rows = [[f"供应商{i}", str(i)] for i in range(400)]
	groups = []
	for start in range(0, len(rows), 40):
		end = min(start + 39, len(rows) - 1)
		groups.append(
			{
				"id": f"g{start}",
				"index": 1,
				"record_type": "table",
				"doc_id": "doc-state",
				"document_version_id": "doc-state:v1",
				"library_id": "lib-state",
				"table_id": "t1",
				"title": "大表",
				"headers": headers,
				"rows": rows[start : end + 1],
				"row_start": start,
				"row_end": end,
				"table_row_count": len(rows),
				"score": 0.9,
				"body": f"rows {start}-{end}",
			}
		)

	def _retrieve(*_args):
		return [groups[0]]

	graph = build_ask_graph(
		settings=Settings(ask_mode="stub"),
		retrieve_fn=_retrieve,
		generate_fn=stub_generate,
		mode="stub",
		load_table_groups_fn=lambda **_kwargs: groups,
	)
	state = graph.invoke(
		{
			"session_id": "s-table-state",
			"question": "总价 >= 0",
			"library_id": "lib-state",
			"history": [],
			"retrieval_debug": {},
		}
	)
	execution = state["table_execution"]
	assert execution["matched_count"] == len(rows)
	assert len(execution["matched_rows"]) == MATCHED_ROWS_PREVIEW_LIMIT
	assert len(execution["matched_row_indices"]) == MATCHED_ROWS_PREVIEW_LIMIT
	assert len(execution["answer_value"]) == MATCHED_ROWS_PREVIEW_LIMIT
	assert execution["evidence_group_count"] == EVIDENCE_GROUPS_LIMIT
	assert execution["evidence_truncated"] is True
	assert "_evidence_row_indices" not in execution
	assert "_evidence_row_indices" not in state["retrieval_debug"]["table_execution"]


def test_matched_row_evidence_citations_replace_vector_hits() -> None:
	"""最低价在后组：最终 citation 须含该证据组，不能只留向量召回的前组。"""
	headers = ["供应商", "总价"]
	groups = [
		{
			"id": "g0",
			"record_type": "table",
			"doc_id": "doc-e",
			"document_version_id": "doc-e:v1",
			"table_id": "t1",
			"title": "报价表",
			"headers": headers,
			"rows": [["甲", "100"], ["乙", "90"]],
			"row_start": 0,
			"row_end": 1,
			"table_row_count": 4,
			"score": 0.95,
			"body": "甲 | 100\n乙 | 90",
		},
		{
			"id": "g1",
			"record_type": "table",
			"doc_id": "doc-e",
			"document_version_id": "doc-e:v1",
			"table_id": "t1",
			"title": "报价表",
			"headers": headers,
			"rows": [["丙", "50"], ["最低供应商", "1"]],
			"row_start": 2,
			"row_end": 3,
			"table_row_count": 4,
			"score": 0.2,
			"body": "丙 | 50\n最低供应商 | 1",
		},
	]
	# 向量只召回前组
	citations = [dict(groups[0])]
	full = prepare_table_for_execute(
		citations,
		load_table_groups=lambda **_kwargs: groups,
	)
	assert full["complete"] is True
	plan = build_table_query_plan("最低报价是多少？", headers=headers)
	ex = execute_table_query(
		plan,
		headers=headers,
		rows=full["rows"],
		row_offset=int(full.get("row_offset") or 0),
	)
	assert ex["ok"] is True
	assert ex["answer_value"] == 1.0
	assert ex["matched_rows"][0]["_row_index"] == 3

	evidence = select_evidence_groups(
		groups,
		matched_row_indices=ex["matched_row_indices"],
	)
	assert evidence["total_group_count"] == 1
	assert evidence["evidence_truncated"] is False
	assert len(evidence["groups"]) == 1
	assert evidence["groups"][0]["row_start"] == 2

	final, meta = citations_with_matched_evidence(
		citations,
		groups=groups,
		matched_rows=ex["matched_rows"],
		matched_row_indices=ex["matched_row_indices"],
		target_key=table_instance_key(groups[0]),
		seed_citation=citations[0],
	)
	assert meta["evidence_truncated"] is False
	assert meta["total_group_count"] == 1
	assert len(final) == 1
	assert final[0]["row_start"] == 2
	assert final[0]["row_end"] == 3
	assert any("最低供应商" in str(cell) for row in final[0]["rows"] for cell in row)
	# 前组不应再作为唯一证据
	assert not any(
		c.get("row_start") == 0 and c.get("row_end") == 1 for c in final
	)
