"""Characterization — Eval runner dispatch / executors / assertions (no behavior change)."""

from __future__ import annotations

from app.eval.executors import EXECUTORS, run_case
from app.eval.runner import (
	_check_expect,
	_resolve_ablation,
	load_eval_cases,
	run_eval_cases,
)
from app.eval.schemas import EvalCase, EvalExpect


def test_executors_registry_covers_all_kinds() -> None:
	assert set(EXECUTORS) == {
		"ask",
		"classify",
		"ingest_chunk",
		"retrieval",
		"ingest_http",
	}


def test_runner_reexports_private_helpers() -> None:
	"""过渡期：tests / ablation 仍从 runner 导入私有符号。"""
	expect = EvalExpect(gold_chunk_ids=["chunk-1"])
	assert _check_expect(expect, {"citations": [{"chunk_id": "chunk-1"}]}) == []
	case = EvalCase(id="x", kind="ask", question="q")
	overrides, env, skip = _resolve_ablation(case)
	assert skip is None
	assert overrides["hybrid_enabled"] is False
	assert env["MAX_RETRIEVE_RETRIES"] == "0"


def test_run_case_dispatches_classify() -> None:
	case = EvalCase(
		id="char-classify",
		kind="classify",
		question="病假需要几天内补交证明？",
		expect=EvalExpect(query_type="fact"),
	)
	result = run_case(case)
	assert result.kind == "classify"
	assert result.observed.get("query_type") == "fact"
	assert result.ok


def test_load_and_schedule_smoke_kinds(monkeypatch) -> None:
	"""Golden set still schedules every registered kind via EXECUTORS."""
	from pathlib import Path

	cases_path = Path(__file__).resolve().parent / "eval_cases.jsonl"
	cases = load_eval_cases(cases_path)
	kinds = {c.kind for c in cases}
	assert kinds <= set(EXECUTORS)
	assert kinds == set(EXECUTORS)

	monkeypatch.setenv("MAX_RETRIEVE_RETRIES", "9")
	results = run_eval_cases(cases_path)
	by_kind = {item.kind for item in results}
	assert by_kind == set(EXECUTORS)
	failed = [item for item in results if not item.ok]
	assert not failed, "; ".join(
		f"{item.id}: {', '.join(item.errors)}" for item in failed
	)
