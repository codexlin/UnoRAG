"""Ask 路由哲学：阶段1短路 / 阶段2升级 / 精路径三岔门。"""

from __future__ import annotations

from app.graph.ask_graph import build_ask_graph, stub_generate
from app.services.ask_route import (
	looks_like_high_confidence_table_shortcircuit,
	should_upgrade_fast_to_precise_table,
)
from app.services.query_router import classify_query
from app.services.retrieval_plan import build_retrieval_plan
from app.services.table_query import citations_for_table_overview
from app.settings import Settings


def test_stage1_high_confidence_shortcircuits_to_precise() -> None:
	q = "表格里哪些供应商报价超过十万？"
	assert looks_like_high_confidence_table_shortcircuit(q) is True
	qt, reason = classify_query(q)
	assert qt == "table"
	assert reason == "table_shortcircuit"
	plan = build_retrieval_plan(
		query_type=qt,
		route_reason=reason,
		library_id="lib-1",
		top_k=6,
		hybrid_enabled=False,
		rerank_enabled=False,
		question=q,
	)
	assert plan["path"] == "precise"
	assert plan["precise_kind"] == "table"
	assert plan["route"] == "precise_table"


def test_stage1_uncertain_text_goes_fast() -> None:
	q = "公司的差旅报销额度是多少？"
	assert looks_like_high_confidence_table_shortcircuit(q) is False
	qt, _reason = classify_query(q)
	assert qt == "fact"
	plan = build_retrieval_plan(
		query_type=qt,
		route_reason="default_fact",
		library_id="lib-1",
		top_k=6,
		hybrid_enabled=False,
		rerank_enabled=False,
		question=q,
	)
	assert plan["path"] == "fast"
	assert plan["precise_kind"] is None
	assert plan["record_type"] == "chunk+table_summary"


def test_stage2_upgrade_condition_and_reason() -> None:
	q = "这个数额最大是多少？"  # 无表表面词，阶段1不短路
	assert looks_like_high_confidence_table_shortcircuit(q) is False
	ok, reason = should_upgrade_fast_to_precise_table(
		q,
		[
			{
				"record_type": "table_summary",
				"table_id": "t1",
				"score": 0.88,
				"body": "报价表摘要",
			}
		],
	)
	assert ok is True
	assert "table_summary" in reason
	assert "numerical_intent" in reason
	assert "0.88" in reason


def test_stage2_no_upgrade_without_table_hit() -> None:
	ok, reason = should_upgrade_fast_to_precise_table(
		"最低报价是多少？",
		[{"record_type": "chunk", "score": 0.9, "body": "人事制度"}],
	)
	assert ok is False
	assert reason == ""


def test_ask_graph_precise_shortcircuit_debug_fields() -> None:
	headers = ["供应商", "总价"]
	rows = [["甲公司", "120000"], ["乙公司", "80000"]]
	groups = [
		{
			"id": "g0",
			"record_type": "table",
			"doc_id": "doc-p",
			"document_version_id": "doc-p:v1",
			"library_id": "lib-p",
			"table_id": "t1",
			"title": "报价表",
			"headers": headers,
			"rows": rows,
			"row_start": 0,
			"row_end": 1,
			"table_row_count": 2,
			"score": 0.9,
			"body": "甲 | 120000",
		}
	]

	def _retrieve(query, library_id, top_k, filters=None):
		_ = query, library_id, top_k
		rt = str((filters or {}).get("record_type") or "chunk")
		if rt == "table_summary":
			return [
				{
					"id": "sum1",
					"index": 1,
					"record_type": "table_summary",
					"table_id": "t1",
					"doc_id": "doc-p",
					"document_version_id": "doc-p:v1",
					"title": "报价表",
					"score": 0.92,
					"body": "报价表摘要 供应商 总价",
					"text": "报价表摘要 供应商 总价",
					"snippet": "报价表摘要",
				}
			]
		if rt == "table":
			return [dict(groups[0])]
		return [
			{
				"id": "c1",
				"index": 1,
				"record_type": "chunk",
				"title": "手册",
				"score": 0.5,
				"body": "文本",
				"text": "文本",
				"snippet": "文本",
			}
		]

	graph = build_ask_graph(
		settings=Settings(ask_mode="stub"),
		retrieve_fn=_retrieve,
		generate_fn=stub_generate,
		mode="stub",
		load_table_groups_fn=lambda **_kwargs: groups,
	)
	state = graph.invoke(
		{
			"session_id": "s-precise",
			"question": "表格里最低报价是多少？",
			"library_id": "lib-p",
			"history": [],
			"retrieval_debug": {},
		}
	)
	debug = state["retrieval_debug"]
	plan = state["retrieval_plan"]
	assert plan["path"] == "precise"
	assert plan["precise_kind"] == "table"
	assert debug.get("route") == "precise_table"
	assert debug.get("path") == "precise"
	assert state.get("upgrade") in {None, False} or state.get("upgrade") is None
	assert state["table_execution"]["ok"] is True
	assert "80000" in (state.get("answer") or "") or state["table_execution"].get(
		"answer_value"
	) in {80000, 80000.0, "80000"}


def test_ask_graph_fast_upgrade_to_precise() -> None:
	"""无阶段1表面词，但 fast 命中 table_summary + 数值意图 → upgrade。"""
	headers = ["供应商", "总价"]
	rows = [["甲公司", "120000"], ["乙公司", "80000"]]
	groups = [
		{
			"id": "g0",
			"record_type": "table",
			"doc_id": "doc-u",
			"document_version_id": "doc-u:v1",
			"library_id": "lib-u",
			"table_id": "t9",
			"title": "报价表",
			"headers": headers,
			"rows": rows,
			"row_start": 0,
			"row_end": 1,
			"table_row_count": 2,
			"score": 0.9,
			"body": "甲 | 120000",
		}
	]

	def _retrieve(query, library_id, top_k, filters=None):
		_ = query, library_id, top_k
		rt = str((filters or {}).get("record_type") or "chunk")
		if rt == "table_summary":
			return [
				{
					"id": "sum9",
					"index": 1,
					"record_type": "table_summary",
					"table_id": "t9",
					"doc_id": "doc-u",
					"document_version_id": "doc-u:v1",
					"title": "报价表",
					"score": 0.91,
					"body": "报价表摘要",
					"text": "报价表摘要",
					"snippet": "报价表摘要",
				}
			]
		if rt == "table":
			return [dict(groups[0])]
		return [
			{
				"id": "c1",
				"index": 1,
				"record_type": "chunk",
				"title": "其它",
				"score": 0.4,
				"body": "无关",
				"text": "无关",
				"snippet": "无关",
			}
		]

	# 「数额最大」带数值意图但不含表格表面词 → 阶段1走 fast
	question = "数额最大是多少？"
	assert looks_like_high_confidence_table_shortcircuit(question) is False

	graph = build_ask_graph(
		settings=Settings(ask_mode="stub"),
		retrieve_fn=_retrieve,
		generate_fn=stub_generate,
		mode="stub",
		load_table_groups_fn=lambda **_kwargs: groups,
	)
	state = graph.invoke(
		{
			"session_id": "s-upgrade",
			"question": question,
			"library_id": "lib-u",
			"history": [],
			"retrieval_debug": {},
		}
	)
	debug = state["retrieval_debug"]
	assert state.get("upgrade") == "precise"
	assert state.get("upgrade_reason")
	assert "table_summary" in str(state.get("upgrade_reason"))
	assert debug.get("upgrade") == "precise"
	assert debug.get("upgrade_reason")
	assert debug.get("route") == "fast"
	assert state["retrieval_plan"]["path"] == "precise"
	assert state["retrieval_plan"]["precise_kind"] == "table"


def test_ask_graph_must_compute_refuses_without_llm_estimate() -> None:
	"""必须算数但 store 不完整 → 拒答，不降级估数。"""

	def _retrieve(query, library_id, top_k, filters=None):
		_ = query, library_id, top_k
		rt = str((filters or {}).get("record_type") or "chunk")
		if rt in {"table", "table_summary"}:
			return [
				{
					"id": "t-incomplete",
					"index": 1,
					"record_type": "table",
					"table_id": "t-missing",
					"doc_id": "doc-x",
					"document_version_id": "doc-x:v1",
					"title": "残表",
					"headers": ["供应商", "总价"],
					"rows": [["甲", "1"]],
					"row_start": 0,
					"row_end": 0,
					"table_row_count": 10,
					"score": 0.9,
					"body": "残缺",
					"text": "残缺",
					"snippet": "残缺",
				}
			]
		return []

	graph = build_ask_graph(
		settings=Settings(ask_mode="stub"),
		retrieve_fn=_retrieve,
		generate_fn=stub_generate,
		mode="stub",
		load_table_groups_fn=lambda **_kwargs: [],  # store 空 → incomplete
	)
	state = graph.invoke(
		{
			"session_id": "s-refuse",
			"question": "表格里最低报价是多少？",
			"library_id": "lib-x",
			"history": [],
			"retrieval_debug": {},
		}
	)
	assert state.get("refused") is True
	assert state.get("refuse_reason") in {"table_incomplete", "table_unclear"}
	assert state["retrieval_debug"].get("precise_gate") == "refuse"
	assert state.get("downgrade_reason") is None


def test_ask_graph_overview_downgrade_records_reason() -> None:
	"""不需精确算 → 概述降级，上下文用 summary + 有界预览。"""
	headers = ["供应商", "总价"]
	rows = [[f"供应商{i}", str(i * 1000)] for i in range(20)]
	groups = [
		{
			"id": "g0",
			"record_type": "table",
			"doc_id": "doc-o",
			"document_version_id": "doc-o:v1",
			"library_id": "lib-o",
			"table_id": "t-o",
			"title": "大表",
			"headers": headers,
			"rows": rows,
			"row_start": 0,
			"row_end": 19,
			"table_row_count": 20,
			"score": 0.9,
			"body": "大表",
		}
	]

	def _retrieve(query, library_id, top_k, filters=None):
		_ = query, library_id, top_k
		rt = str((filters or {}).get("record_type") or "chunk")
		if rt == "table_summary":
			return [
				{
					"id": "sum-o",
					"index": 1,
					"record_type": "table_summary",
					"table_id": "t-o",
					"doc_id": "doc-o",
					"document_version_id": "doc-o:v1",
					"title": "大表",
					"score": 0.93,
					"body": "本表收录供应商报价明细共20行",
					"text": "本表收录供应商报价明细共20行",
					"snippet": "本表收录",
				}
			]
		if rt == "table":
			return [dict(groups[0])]
		return []

	graph = build_ask_graph(
		settings=Settings(ask_mode="stub"),
		retrieve_fn=_retrieve,
		generate_fn=stub_generate,
		mode="stub",
		load_table_groups_fn=lambda **_kwargs: groups,
	)
	state = graph.invoke(
		{
			"session_id": "s-overview",
			"question": "表格里大概讲了什么？",
			"library_id": "lib-o",
			"history": [],
			"retrieval_debug": {},
		}
	)
	assert state.get("refused") is not True
	assert state.get("downgrade_reason")
	assert state["retrieval_debug"].get("precise_gate") == "overview"
	assert state["retrieval_debug"].get("downgrade_reason")
	# 有界预览：不得把 20 行整表塞进 citation rows
	table_cites = [
		c
		for c in (state.get("citations") or [])
		if str(c.get("record_type") or "") == "table"
	]
	assert table_cites
	assert len(table_cites[0].get("rows") or []) <= 8


def test_citations_for_table_overview_bounds_rows() -> None:
	merged = {
		"headers": ["A", "B"],
		"rows": [[str(i), str(i)] for i in range(30)],
		"table_id": "t1",
		"doc_id": "d1",
		"row_offset": 0,
	}
	cites = citations_for_table_overview(
		[
			{
				"id": "s1",
				"record_type": "table_summary",
				"table_id": "t1",
				"body": "摘要",
				"score": 0.9,
				"title": "t",
			}
		],
		merged=merged,
		preview_rows=5,
	)
	assert any(c.get("record_type") == "table_summary" for c in cites)
	preview = next(c for c in cites if c.get("record_type") == "table")
	assert len(preview["rows"]) == 5
	assert "仅预览前 5 行" in preview["body"]


def test_unified_fast_merge_renumbers_citation_indexes_unique() -> None:
	"""chunk + table_summary 双路各自从 1 编号时，合并后须稳定唯一 1..N。"""

	def _retrieve(query, library_id, top_k, filters=None):
		_ = query, library_id, top_k
		rt = str((filters or {}).get("record_type") or "chunk")
		if rt == "table_summary":
			# 故意复用与 chunk 路重叠的 index，复现合并未重编号缺陷
			return [
				{
					"id": "sum-1",
					"index": 1,
					"record_type": "table_summary",
					"record_id": "sum-1",
					"table_id": "t-a",
					"title": "表摘要A",
					# 分数需过 citation_adjudicate semantic_floor，否则双路合并测不到 table_summary
					"score": 0.82,
					"body": "报价有效期说明摘要",
					"text": "报价有效期说明摘要",
					"snippet": "报价有效期说明摘要",
				},
				{
					"id": "sum-2",
					"index": 2,
					"record_type": "table_summary",
					"record_id": "sum-2",
					"table_id": "t-b",
					"title": "表摘要B",
					"score": 0.76,
					"body": "其它表摘要",
					"text": "其它表摘要",
					"snippet": "其它表摘要",
				},
			]
		return [
			{
				"id": f"chunk-{i}",
				"index": i,
				"record_type": "chunk",
				"record_id": f"chunk-{i}",
				"title": f"正文{i}",
				"score": 0.9 - i * 0.05,
				"body": f"报价有效期正文片段{i}",
				"text": f"报价有效期正文片段{i}",
				"snippet": f"报价有效期正文片段{i}",
			}
			for i in range(1, 7)
		]

	graph = build_ask_graph(
		settings=Settings(ask_mode="stub"),
		retrieve_fn=_retrieve,
		generate_fn=stub_generate,
		mode="stub",
	)
	state = graph.invoke(
		{
			"session_id": "s-cite-index",
			"question": "公司的差旅报销额度是多少？",
			"library_id": "lib-cite-index",
			"history": [],
			"retrieval_debug": {},
		}
	)
	citations = list(state.get("citations") or [])
	assert len(citations) >= 4
	indexes = [int(c["index"]) for c in citations]
	assert indexes == list(range(1, len(citations) + 1)), indexes
	assert len(set(indexes)) == len(indexes)
	# 双路都应进入合并结果（未升级 precise 时）
	rts = {str(c.get("record_type") or "") for c in citations}
	assert "chunk" in rts
	assert "table_summary" in rts
	assert str((state.get("retrieval_plan") or {}).get("path") or "") == "fast"
