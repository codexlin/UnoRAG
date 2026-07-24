"""L7 quality release gates — layered metrics and hard fuses."""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Literal

from app.eval.schemas import EvalCase, EvalCaseResult

Layer = Literal["ingestion", "retrieval", "answer", "routing"]

KIND_LAYER: dict[str, Layer] = {
	"ingest_chunk": "ingestion",
	"ingest_http": "ingestion",
	"retrieval": "retrieval",
	"ask": "answer",
	"classify": "routing",
}

# Tags that trip the release fuse when any matching case fails.
FUSE_TAGS = frozenset(
	{
		"fuse",
		"acl",
		"isolation",
		"tenant_leak",
		"inactive_generation",
		"deleted_generation",
	}
)


def case_layer(case: EvalCase) -> Layer:
	return KIND_LAYER.get(case.kind, "answer")


def is_fuse_case(case: EvalCase) -> bool:
	tags = set(case.tags or [])
	if tags & FUSE_TAGS:
		return True
	# Refusal / no-hit contracts are hard product promises.
	if case.kind == "ask" and case.expect.refused is True:
		return True
	return False


def layer_metrics(
	cases: list[EvalCase],
	results: list[EvalCaseResult],
) -> dict[str, dict[str, float | int]]:
	by_id = {case.id: case for case in cases}
	totals: dict[str, list[bool]] = defaultdict(list)
	for result in results:
		case = by_id.get(result.id)
		layer = case_layer(case) if case else KIND_LAYER.get(result.kind, "answer")
		totals[layer].append(bool(result.ok))
	metrics: dict[str, dict[str, float | int]] = {}
	for layer, flags in sorted(totals.items()):
		passed = sum(1 for ok in flags if ok)
		total = len(flags)
		metrics[layer] = {
			"total": total,
			"passed": passed,
			"failed": total - passed,
			"pass_rate": (passed / total) if total else 1.0,
		}
	return metrics


def evaluate_fuses(
	cases: list[EvalCase],
	results: list[EvalCaseResult],
) -> dict[str, Any]:
	by_id = {case.id: case for case in cases}
	fuse_failures: list[dict[str, Any]] = []
	fuse_total = 0
	for result in results:
		case = by_id.get(result.id)
		if case is None or not is_fuse_case(case):
			continue
		fuse_total += 1
		if result.ok:
			continue
		fuse_failures.append(
			{
				"id": result.id,
				"kind": result.kind,
				"tags": list(case.tags or []),
				"errors": list(result.errors),
			}
		)
	return {
		"fuse_total": fuse_total,
		"fuse_failures": fuse_failures,
		"tripped": bool(fuse_failures),
	}


def compare_to_baseline(
	metrics: dict[str, dict[str, float | int]],
	baseline: dict[str, Any],
	*,
	allow_regression: bool = False,
) -> dict[str, Any]:
	"""Fail when any layer pass_rate drops below baseline floor."""
	floors = baseline.get("layer_pass_rate_floors") or {}
	regressions: list[dict[str, Any]] = []
	for layer, floor in floors.items():
		observed = float((metrics.get(layer) or {}).get("pass_rate") or 0.0)
		required = float(floor)
		if observed + 1e-9 < required:
			regressions.append(
				{
					"layer": layer,
					"observed_pass_rate": observed,
					"baseline_floor": required,
				}
			)
	hard = baseline.get("hard") or {}
	hard_failures: list[str] = []
	if hard.get("fuse_failures_max", 0) == 0 and metrics:
		# fuse check is separate; placeholder for schema completeness
		pass
	return {
		"regressions": regressions,
		"hard_failures": hard_failures,
		"blocked": bool(regressions) and not allow_regression,
		"allow_regression": allow_regression,
	}


def filter_cases_for_mode(
	cases: list[EvalCase],
	mode: Literal["ci", "release"],
) -> list[EvalCase]:
	"""ci = deterministic contract subset; release = full golden set."""
	if mode == "release":
		return list(cases)
	selected = [case for case in cases if "ci" in (case.tags or [])]
	# Fallback: if dataset has not been tagged yet, use non-live kinds.
	if not selected:
		selected = [
			case
			for case in cases
			if case.kind in {"classify", "ask", "ingest_chunk"}
			and "live" not in (case.tags or [])
		]
	return selected
