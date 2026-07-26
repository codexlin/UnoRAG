"""Pydantic Phase 2：Ask generation / citations 对账契约。"""

from __future__ import annotations

import json

from app.services.generation_contract import (
	GenerationOutput,
	build_hit_allowlist,
	reconcile_generation_output,
	try_parse_structured_generation,
)


def _hit(
	*,
	cid: str,
	record_id: str,
	index: int = 1,
	title: str = "员工手册",
	body: str = "病假须于返岗后三个工作日内补交证明。",
	score: float = 0.9,
) -> dict:
	return {
		"id": cid,
		"record_id": record_id,
		"index": index,
		"title": title,
		"snippet": body[:40],
		"text": body,
		"body": body,
		"score": score,
		"record_type": "chunk",
		"doc_id": "doc-hr",
		"chunk_index": 0,
		"generation_id": "gen-1",
		"document_version_id": "ver-1",
	}


def test_legal_citations_pass_reconcile() -> None:
	hits = [
		_hit(cid="pt-1", record_id="chk:doc-hr:0", index=1),
		_hit(cid="pt-2", record_id="chk:doc-hr:1", index=2, body="旷工按制度处理。"),
	]
	result = reconcile_generation_output(
		answer="根据资料，须在三个工作日内补交证明。[1]",
		citations=hits,
		allowed_hits=hits,
	)
	assert result.from_structured is False
	assert result.dropped_ids == []
	assert len(result.citations) == 2
	assert {c.record_id for c in result.citations} == {
		"chk:doc-hr:0",
		"chk:doc-hr:1",
	}
	assert result.citations[0].index == 1
	assert result.citations[1].index == 2
	# 出口契约可再次 model_validate
	GenerationOutput.model_validate(result.output.model_dump())


def test_forged_chunk_id_is_dropped() -> None:
	hits = [_hit(cid="pt-1", record_id="chk:doc-hr:0", index=1)]
	forged = _hit(
		cid="evil-point",
		record_id="chk:forged:99",
		index=2,
		title="伪造资料",
		body="这是模型幻觉出来的引用。",
	)
	result = reconcile_generation_output(
		answer="看起来有两条来源。",
		citations=[hits[0], forged],
		allowed_hits=hits,
	)
	assert len(result.citations) == 1
	assert result.citations[0].record_id == "chk:doc-hr:0"
	assert result.citations[0].index == 1  # 重编号
	assert "evil-point" in result.dropped_ids or "chk:forged:99" in result.dropped_ids
	assert result.answer == "看起来有两条来源。"


def test_structured_json_validated_and_refs_resolved() -> None:
	hits = [
		_hit(cid="pt-1", record_id="chk:doc-hr:0", index=1),
		_hit(cid="pt-2", record_id="chk:doc-hr:1", index=2, body="逾期按事假处理。"),
	]
	payload = {
		"answer": "须三个工作日内补交。[1]",
		"citations": [{"record_id": "chk:doc-hr:0"}],
	}
	result = reconcile_generation_output(
		answer=json.dumps(payload, ensure_ascii=False),
		citations=None,
		allowed_hits=hits,
	)
	assert result.from_structured is True
	assert result.answer == "须三个工作日内补交。[1]"
	assert len(result.citations) == 1
	assert result.citations[0].id == "pt-1"
	assert result.citations[0].record_id == "chk:doc-hr:0"
	assert result.citations[0].body.startswith("病假")


def test_structured_json_forged_ref_dropped_answer_kept() -> None:
	hits = [_hit(cid="pt-1", record_id="chk:doc-hr:0", index=1)]
	payload = {
		"answer": "答案仍可用。",
		"citations": [
			{"id": "pt-1"},
			{"record_id": "chk:hallucinated:0"},
			{"id": "not-in-hits"},
		],
	}
	result = reconcile_generation_output(
		answer=payload,
		allowed_hits=hits,
	)
	assert result.from_structured is True
	assert result.answer == "答案仍可用。"
	assert len(result.citations) == 1
	assert result.citations[0].id == "pt-1"
	assert "chk:hallucinated:0" in result.dropped_ids
	assert "not-in-hits" in result.dropped_ids


def test_allowlist_uses_id_and_record_id() -> None:
	hits = [_hit(cid="pt-1", record_id="chk:doc-hr:0")]
	allowed = build_hit_allowlist(hits)
	assert "pt-1" in allowed
	assert "chk:doc-hr:0" in allowed


def test_free_text_not_mistaken_for_structured() -> None:
	assert try_parse_structured_generation("普通中文答案，无 JSON。") is None
	assert try_parse_structured_generation("{not json") is None
