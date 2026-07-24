"""Citation gate: wide recall → relevance filter → context/citations 同源."""

from __future__ import annotations

from app.graph.ask_graph import AskGraphService, _format_context, stub_generate
from app.services.citation_gate import (
	apply_citation_gate,
	wide_recall_limit,
)
from app.settings import Settings


def _hit(i: int, score: float, *, text: str | None = None, bm25: float | None = None) -> dict:
	body = text or f"噪声段落 {i} 与问题无关的填充内容"
	item = {
		"id": f"c{i}",
		"index": i,
		"title": f"doc-{i}",
		"snippet": body[:80],
		"score": score,
		"text": body,
		"body": body,
		"record_type": "chunk",
	}
	if bm25 is not None:
		item["bm25_score"] = bm25
	return item


def test_wide_recall_limit_formula() -> None:
	settings = Settings(_env_file=None, rerank_enabled=False)
	assert wide_recall_limit(6, settings) == min(50, max(18, 14))  # 18
	assert wide_recall_limit(2, settings) == 10  # max(6, 10)=10 → min 50
	settings_rr = Settings(_env_file=None, rerank_enabled=True, rerank_top_k=24)
	assert wide_recall_limit(6, settings_rr) == 24


def test_semantic_floor_filters_low_tail() -> None:
	settings = Settings(
		_env_file=None,
		citation_gate_enabled=True,
		citation_gate_absolute_floor=0.35,
		citation_gate_ratio=0.68,
		answer_min_score=0.4,
	)
	# Pure semantic: no lexical overlap with query
	candidates = [
		_hit(1, 0.90, text="报价有效期为三十个自然日，自发出之日起计算。"),
		_hit(2, 0.72, text="报价有效期条款详见合同附件。"),
		_hit(3, 0.55, text="本页为目录与修订记录，无实质条款。"),
		_hit(4, 0.42, text="页眉页脚示例文本 abc xyz。"),
		_hit(5, 0.38, text="完全无关的附录排版说明。"),
	]
	# Pure-English query → no CJK lexical signal; rely on semantic_floor
	result = apply_citation_gate(
		"zzpolicy duration alphaunique",
		candidates,
		top_k=8,
		settings=settings,
	)
	# top=0.90 → floor = max(0.35, 0.612)=0.612 → keep 0.90, 0.72; drop rest
	assert result.candidates_count == 5
	assert result.filtered_irrelevant >= 2
	assert all(float(c["score"]) >= 0.612 for c in result.citations)
	assert {c["id"] for c in result.citations} == {"c1", "c2"}
	assert result.citation_gate["mode"] == "semantic_floor"


def test_context_and_citations_same_source() -> None:
	def fake_retrieve(_q, _lib, top_k, _filters=None):
		# Return a wide pool; gate should trim
		pool = [
			_hit(1, 0.88, text="病假须于返岗后三个工作日内补交证明材料。"),
			_hit(2, 0.80, text="病假证明由直属主管确认后交人力资源部。"),
			_hit(3, 0.50, text="公司食堂开放时间表。"),
			_hit(4, 0.45, text="停车位申请流程说明。"),
			_hit(5, 0.40, text="打印耗材领用须知。"),
			_hit(6, 0.39, text="访客登记台账模板。"),
			_hit(7, 0.38, text="会议室预约系统账号。"),
			_hit(8, 0.37, text="前台快递代收说明。"),
		]
		return pool[:top_k]

	captured: dict = {}

	def capture_generate(question: str, citations: list[dict]) -> str:
		captured["citations"] = list(citations)
		captured["context"] = _format_context(citations)
		return stub_generate(question, citations)

	service = AskGraphService(
		Settings(
			_env_file=None,
			citation_gate_enabled=True,
			ask_mode="stub",
			answer_min_score=0.4,
			max_retrieve_retries=0,
			retrieve_top_k=6,
		),
		retrieve_fn=fake_retrieve,
		generate_fn=capture_generate,
	)
	result = service.ask(question="病假证明怎么交？", library_id="lib-gate")
	assert result.refused is False
	assert len(result.citations) >= 1
	assert len(result.citations) < 8
	# 同源：返回 citations 与进 LLM 的集合一致
	assert [c.id for c in result.citations] == [c["id"] for c in captured["citations"]]
	for c in result.citations:
		assert f"[{c.index}]" in captured["context"]
	debug = result.retrieval_debug or {}
	assert "candidates_count" in debug
	assert "filtered_irrelevant" in debug
	assert "relevant_count" in debug
	assert "citation_gate" in debug


def test_weak_match_still_refuses() -> None:
	settings = Settings(
		_env_file=None,
		ask_mode="stub",
		answer_min_score=0.5,
		max_retrieve_retries=0,
		citation_gate_enabled=True,
		citation_gate_absolute_floor=0.35,
	)

	def fake_retrieve(_q, _lib, _top_k, _filters=None):
		return [_hit(1, 0.22, text="无关附录排版示例。")]

	service = AskGraphService(
		settings,
		retrieve_fn=fake_retrieve,
		generate_fn=stub_generate,
	)
	result = service.ask(question="anything", library_id="lib-weak-gate")
	assert result.refused is True
	assert result.refuse_reason == "weak_match"
	assert len(result.citations) >= 1


def test_renumber_indexes_unique_1_to_n() -> None:
	settings = Settings(
		_env_file=None,
		citation_gate_enabled=True,
		citation_gate_absolute_floor=0.35,
		citation_gate_ratio=0.68,
	)
	candidates = [
		_hit(10, 0.91, text="报价有效期三十天。"),
		_hit(20, 0.85, text="报价有效期自发出日起算。"),
		_hit(30, 0.40, text="无关页脚。"),
	]
	result = apply_citation_gate(
		"zzquote validity alphaunique",
		candidates,
		top_k=6,
		settings=settings,
	)
	# Simulate graph renumber
	from app.graph.ask_graph import _renumber_citation_indexes

	renumbered = _renumber_citation_indexes(list(result.citations))
	indexes = [int(c["index"]) for c in renumbered]
	assert indexes == list(range(1, len(renumbered) + 1))
	assert len(set(indexes)) == len(indexes)


def test_gate_disabled_passthrough() -> None:
	settings = Settings(_env_file=None, citation_gate_enabled=False)
	candidates = [_hit(i, 0.9 - i * 0.05) for i in range(1, 9)]
	result = apply_citation_gate("q", candidates, top_k=6, settings=settings)
	assert result.citation_gate["mode"] == "passthrough"
	assert len(result.citations) == 6
