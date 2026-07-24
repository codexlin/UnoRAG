#!/usr/bin/env python3
"""L7 quality release gates.

Modes:
  ci       — deterministic PR contract (cases tagged `ci`)
  release  — full golden set for release candidates

Examples:
  cd apps/api
  uv run python scripts/run_release_gates.py --mode ci
  uv run python scripts/run_release_gates.py --mode release \\
    --baseline tests/eval/baselines/release.json \\
    --report-out /tmp/meriknow-release-gate.json

  # Explicit approval to ship despite layer floor regression (never clears fuse trips):
  uv run python scripts/run_release_gates.py --mode release --allow-regression
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
	sys.path.insert(0, str(ROOT))

from app.eval.gates import (  # noqa: E402
	compare_to_baseline,
	evaluate_fuses,
	filter_cases_for_mode,
	layer_metrics,
)
from app.eval.report import build_release_report, write_report  # noqa: E402
from app.eval.runner import DEFAULT_CASES, load_eval_cases, run_eval_cases  # noqa: E402
from app.eval.schemas import EvalCase  # noqa: E402


def _write_filtered_cases(cases: list[EvalCase], path: Path) -> None:
	lines = [case.model_dump_json() for case in cases]
	path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--mode", choices=("ci", "release"), default="ci")
	parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
	parser.add_argument(
		"--baseline",
		type=Path,
		default=ROOT / "tests" / "eval" / "baselines" / "ci-deterministic.json",
	)
	parser.add_argument("--report-out", type=Path, default=None)
	parser.add_argument(
		"--allow-regression",
		action="store_true",
		help="allow layer floor regressions with explicit approval (fuses still hard-fail)",
	)
	args = parser.parse_args(argv)

	all_cases = load_eval_cases(args.cases)
	selected = filter_cases_for_mode(all_cases, args.mode)
	if not selected:
		print(f"[gate] no cases selected for mode={args.mode}", file=sys.stderr)
		return 2

	# Runner reads a jsonl path; materialize the filtered subset.
	filtered_path = ROOT / "tests" / "eval" / f".gate_{args.mode}_cases.jsonl"
	_write_filtered_cases(selected, filtered_path)
	results = run_eval_cases(filtered_path)

	metrics = layer_metrics(selected, results)
	fuses = evaluate_fuses(selected, results)
	baseline: dict = {}
	if args.baseline.exists():
		baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
	compare = compare_to_baseline(
		metrics,
		baseline,
		allow_regression=args.allow_regression,
	)

	report = build_release_report(
		mode=args.mode,
		cases_path=args.cases,
		cases=selected,
		results=results,
		layer_metrics=metrics,
		fuses=fuses,
		baseline_compare=compare,
		baseline_path=args.baseline if args.baseline.exists() else None,
	)
	if args.report_out:
		write_report(args.report_out, report)

	print(
		f"[gate] mode={args.mode} cases={len(results)} "
		f"passed={report['summary']['passed']} failed={report['summary']['failed']} "
		f"fuse_tripped={fuses['tripped']} regression_blocked={compare['blocked']} "
		f"gate_ok={report['gate_ok']}"
	)
	for layer, values in metrics.items():
		print(
			f"  layer={layer} pass_rate={values['pass_rate']:.3f} "
			f"({values['passed']}/{values['total']})"
		)
	for item in report["failures"]:
		print(f"  FAIL {item['id']}: {', '.join(item['errors'])}")
	for item in fuses["fuse_failures"]:
		print(f"  FUSE {item['id']}: {', '.join(item['errors'])}")
	for item in compare["regressions"]:
		print(
			f"  REGRESSION {item['layer']}: "
			f"{item['observed_pass_rate']:.3f} < floor {item['baseline_floor']:.3f}"
		)

	# Fuses never soft-pass.
	if fuses["tripped"]:
		return 1
	if compare["blocked"]:
		return 1
	if report["summary"]["failed"]:
		return 1
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
