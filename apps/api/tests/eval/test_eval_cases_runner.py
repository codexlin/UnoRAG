"""黄金集 smoke — 本地可跑 eval_cases.jsonl。"""

from __future__ import annotations

import os
from pathlib import Path

from app.eval.runner import load_eval_cases, run_eval_cases

CASES = Path(__file__).resolve().parent / "eval_cases.jsonl"


def test_eval_cases_file_has_smoke_size() -> None:
	cases = load_eval_cases(CASES)
	assert 10 <= len(cases) <= 50
	kinds = {c.kind for c in cases}
	assert "ask" in kinds
	assert "classify" in kinds
	assert "ingest_chunk" in kinds
	assert "retrieval" in kinds
	tags = {tag for c in cases for tag in c.tags}
	assert "no_hit" in tags
	assert "weak_match" in tags
	assert any(
		(c.fixture or "").startswith("testdata/") for c in cases
	), "expected real testdata fixtures wired into golden set"


def test_eval_cases_runner_passes(monkeypatch) -> None:
	monkeypatch.setenv("MAX_RETRIEVE_RETRIES", "9")
	results = run_eval_cases(CASES)
	failed = [item for item in results if not item.ok]
	assert not failed, "; ".join(
		f"{item.id}: {', '.join(item.errors)}" for item in failed
	)
	assert os.environ["MAX_RETRIEVE_RETRIES"] == "9"
