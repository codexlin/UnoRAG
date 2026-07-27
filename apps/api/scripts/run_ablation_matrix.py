#!/usr/bin/env python3
"""Ask ablation matrix — experimental tool, NOT a release gate.

- Expands each base ask case × runnable variants (paired comparison).
- Writes expanded cases to a system temp file (deleted after run).
- Report is raw metrics only (no keep/delete decisions).
- Fails if a runnable variant has zero matching cases.

Examples:
  cd apps/api
  uv run python scripts/run_ablation_matrix.py \\
    --cases tests/eval/ablation_cases.jsonl \\
    --report-out /tmp/meriknow-ablation.json
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
	sys.path.insert(0, str(ROOT))

from app.eval.ablation import (  # noqa: E402
	ABLATION_VARIANTS,
	case_matches_focus,
	runnable_variants,
)
from app.eval.runner import load_eval_cases, run_eval_cases  # noqa: E402
from app.eval.schemas import EvalCase  # noqa: E402


def _expand_paired(base_cases: list[EvalCase]) -> list[EvalCase]:
	"""Every base ask case runs A0 + each applicable runnable variant (same question)."""
	variants = runnable_variants()
	ask_cases = [c for c in base_cases if c.kind == "ask"]
	if not ask_cases:
		raise SystemExit("[ablation] no kind=ask cases in input")

	# Validate each non-A0 runnable variant has at least one matching case.
	for variant in variants:
		if variant.id == "A0_full":
			continue
		matched = [c for c in ask_cases if case_matches_focus(c.category, variant)]
		if not matched:
			raise SystemExit(
				f"[ablation] runnable variant {variant.id} has no matching cases "
				f"(need category in {variant.focus_categories or 'any'})"
			)

	expanded: list[EvalCase] = []
	for case in ask_cases:
		# Always pair with A0 on the same question.
		for variant in variants:
			if variant.id != "A0_full" and not case_matches_focus(case.category, variant):
				continue
			payload = case.model_dump()
			payload["id"] = f"{case.id}__{variant.id}"
			payload["policy_variant"] = variant.id
			expanded.append(EvalCase.model_validate(payload))
	return expanded


def _p95(values: list[float]) -> float | None:
	if not values:
		return None
	ordered = sorted(values)
	idx = int(round(0.95 * (len(ordered) - 1)))
	return ordered[idx]


def _summarize(results: list, cases: list[EvalCase]) -> dict:
	by_variant: dict[str, list] = defaultdict(list)
	for result, case in zip(results, cases, strict=False):
		vid = result.policy_variant or case.policy_variant
		if not vid and "__" in result.id:
			vid = result.id.rsplit("__", 1)[-1]
		by_variant[str(vid or "unknown")].append(result)

	rows = []
	for variant in ABLATION_VARIANTS:
		group = by_variant.get(variant.id) or []
		skipped = [r for r in group if r.skipped]
		active = [r for r in group if not r.skipped]
		passed = sum(1 for r in active if r.ok)
		failed = [r for r in active if not r.ok]
		durations = [float(r.duration_ms) for r in active if r.duration_ms is not None]
		rows.append(
			{
				"variant": variant.id,
				"label": variant.label,
				"question": variant.question,
				"status": (
					"not_evaluable"
					if variant.not_evaluable
					else "requires_graph_hook"
					if variant.requires_graph_hook
					else "ran"
				),
				"note": variant.note,
				"passed": passed,
				"failed": len(failed),
				"total": len(active),
				"skipped": len(skipped),
				"pass_rate": (passed / len(active)) if active else None,
				"p95_ms": _p95(durations),
				"failed_ids": [r.id for r in failed[:20]],
			}
		)
	return {
		"schema_version": "meriknow.ablation.v1",
		"purpose": "experimental — not a release gate",
		"baseline_variant": "A0_full",
		"variants": rows,
		"case_count_expanded": len(cases),
		"result_count": len(results),
	}


def main(argv: list[str] | None = None) -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument(
		"--cases",
		type=Path,
		default=ROOT / "tests" / "eval" / "ablation_cases.jsonl",
	)
	parser.add_argument("--report-out", type=Path, default=None)
	args = parser.parse_args(argv)

	if not args.cases.exists():
		print(f"[ablation] missing cases file: {args.cases}", file=sys.stderr)
		return 2

	base = load_eval_cases(args.cases)
	try:
		expanded = _expand_paired(base)
	except SystemExit as exc:
		print(str(exc), file=sys.stderr)
		return 2

	with tempfile.NamedTemporaryFile(
		mode="w",
		suffix=".jsonl",
		prefix="meriknow-ablation-",
		delete=False,
		encoding="utf-8",
	) as handle:
		for case in expanded:
			handle.write(case.model_dump_json() + "\n")
		tmp_path = Path(handle.name)

	try:
		results = run_eval_cases(tmp_path)
	finally:
		tmp_path.unlink(missing_ok=True)

	summary = _summarize(results, expanded)
	text = json.dumps(summary, ensure_ascii=False, indent=2)
	if args.report_out:
		args.report_out.parent.mkdir(parents=True, exist_ok=True)
		args.report_out.write_text(text + "\n", encoding="utf-8")
		print(f"[ablation] wrote {args.report_out}")
	print(text)
	# Experimental tool: always exit 0 if it ran; variant failures are data.
	return 0


if __name__ == "__main__":
	sys.exit(main())
