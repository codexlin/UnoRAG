"""Ablation skeleton unit tests."""

from __future__ import annotations

from app.eval.ablation import runnable_variants, variant_by_id
from app.eval.runner import _check_expect, _resolve_ablation
from app.eval.schemas import EvalCase, EvalExpect


def test_runnable_excludes_hooks_and_not_evaluable() -> None:
	ids = {v.id for v in runnable_variants()}
	assert "A0_full" in ids
	assert "A5_no_retry" in ids
	assert "A6_no_adjudication" in ids
	assert "A3_dense_only" not in ids
	assert "A4_no_rerank" not in ids
	assert "A1_no_rewrite" not in ids


def test_a3_a4_marked_not_evaluable() -> None:
	assert variant_by_id("A3_dense_only").not_evaluable is True
	assert variant_by_id("A4_no_rerank").not_evaluable is True


def test_resolve_ablation_a6() -> None:
	case = EvalCase(id="x", kind="ask", question="q", policy_variant="A6_no_adjudication")
	overrides, env, skip = _resolve_ablation(case)
	assert skip is None
	assert overrides["citation_adjudicate_enabled"] is False
	assert env["MAX_RETRIEVE_RETRIES"] == "1"


def test_gold_chunk_missing_observed_fails() -> None:
	expect = EvalExpect(gold_chunk_ids=["chunk-1"])
	errors = _check_expect(expect, {"answer": "ok", "citations": []})
	assert any("no chunk_id" in e for e in errors)


def test_gold_chunk_wrong_id_fails() -> None:
	expect = EvalExpect(gold_chunk_ids=["chunk-1"])
	errors = _check_expect(expect, {"citations": [{"chunk_id": "chunk-2"}]})
	assert any("gold_chunk_ids miss" in e for e in errors)


def test_gold_chunk_hit_passes() -> None:
	expect = EvalExpect(gold_chunk_ids=["chunk-1"])
	assert _check_expect(expect, {"citations": [{"chunk_id": "chunk-1"}]}) == []
