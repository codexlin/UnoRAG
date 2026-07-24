"""Unit tests for L7 release gate helpers."""

from __future__ import annotations

from app.eval.gates import (
	compare_to_baseline,
	evaluate_fuses,
	filter_cases_for_mode,
	layer_metrics,
)
from app.eval.schemas import EvalCase, EvalCaseResult, EvalExpect


def _case(case_id: str, kind: str, *, tags: list[str] | None = None, refused: bool | None = None) -> EvalCase:
	return EvalCase(
		id=case_id,
		kind=kind,  # type: ignore[arg-type]
		question="q",
		tags=tags or [],
		expect=EvalExpect(refused=refused),
	)


def test_filter_cases_for_mode_prefers_ci_tag() -> None:
	cases = [
		_case("a", "classify", tags=["ci"]),
		_case("b", "ingest_http", tags=["ingest_http"]),
		_case("c", "retrieval", tags=["ci", "recall"]),
	]
	assert [case.id for case in filter_cases_for_mode(cases, "ci")] == ["a", "c"]
	assert [case.id for case in filter_cases_for_mode(cases, "release")] == ["a", "b", "c"]


def test_layer_metrics_and_fuses() -> None:
	cases = [
		_case("route", "classify", tags=["ci"]),
		_case("refuse", "ask", tags=["ci", "fuse"], refused=True),
		_case("ret", "retrieval", tags=["ci", "isolation", "fuse"]),
	]
	results = [
		EvalCaseResult(id="route", ok=True, kind="classify"),
		EvalCaseResult(id="refuse", ok=False, kind="ask", errors=["refused mismatch"]),
		EvalCaseResult(id="ret", ok=True, kind="retrieval"),
	]
	metrics = layer_metrics(cases, results)
	assert metrics["routing"]["pass_rate"] == 1.0
	assert metrics["answer"]["failed"] == 1
	fuses = evaluate_fuses(cases, results)
	assert fuses["tripped"] is True
	assert fuses["fuse_failures"][0]["id"] == "refuse"


def test_baseline_compare_blocks_regression_unless_allowed() -> None:
	metrics = {
		"answer": {"total": 2, "passed": 1, "failed": 1, "pass_rate": 0.5},
		"routing": {"total": 1, "passed": 1, "failed": 0, "pass_rate": 1.0},
	}
	baseline = {"layer_pass_rate_floors": {"answer": 1.0, "routing": 1.0}}
	blocked = compare_to_baseline(metrics, baseline, allow_regression=False)
	assert blocked["blocked"] is True
	allowed = compare_to_baseline(metrics, baseline, allow_regression=True)
	assert allowed["blocked"] is False
	assert allowed["regressions"]
