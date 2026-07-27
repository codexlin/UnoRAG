#!/usr/bin/env python3
"""Run Python + JS policy runners and assert result equality.

Usage (from MeriKnow repo root):
  python3 scripts/compare_policy_parity.py

Exit 0 on match; non-zero on mismatch or runner failure.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
PY_RUNNER = REPO_ROOT / "scripts" / "policy_parity_py.py"
JS_RUNNER = REPO_ROOT / "scripts" / "policy_parity_js.mjs"
FIXTURES = REPO_ROOT / "tests" / "contracts" / "policy-parity" / "fixtures.json"


def _strip_runtime(report: dict[str, Any]) -> dict[str, Any]:
	out = dict(report)
	out.pop("runtime", None)
	return out


def _run_py(fixtures: Path, out: Path) -> None:
	api = REPO_ROOT / "apps" / "api"
	if shutil.which("uv"):
		cmd = [
			"uv",
			"run",
			"--directory",
			str(api),
			"python",
			str(PY_RUNNER),
			"--fixtures",
			str(fixtures),
			"--out",
			str(out),
		]
		proc = subprocess.run(cmd, cwd=REPO_ROOT, capture_output=True, text=True)
	else:
		env = os.environ.copy()
		prev = env.get("PYTHONPATH", "")
		env["PYTHONPATH"] = f"{api}{os.pathsep}{prev}" if prev else str(api)
		cmd = [
			sys.executable,
			str(PY_RUNNER),
			"--fixtures",
			str(fixtures),
			"--out",
			str(out),
		]
		proc = subprocess.run(
			cmd, cwd=REPO_ROOT, env=env, capture_output=True, text=True
		)
	if proc.returncode != 0:
		sys.stderr.write(proc.stdout)
		sys.stderr.write(proc.stderr)
		raise SystemExit(f"python runner failed ({proc.returncode})")


def _run_js(fixtures: Path, out: Path) -> None:
	proc = subprocess.run(
		[
			"node",
			str(JS_RUNNER),
			"--fixtures",
			str(fixtures),
			"--out",
			str(out),
		],
		cwd=REPO_ROOT,
		capture_output=True,
		text=True,
	)
	if proc.returncode != 0:
		sys.stderr.write(proc.stdout)
		sys.stderr.write(proc.stderr)
		raise SystemExit(f"js runner failed ({proc.returncode})")


def _canonical(report: dict[str, Any]) -> str:
	return (
		json.dumps(
			_strip_runtime(report), ensure_ascii=False, indent=2, sort_keys=True
		)
		+ "\n"
	)


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--fixtures", type=Path, default=FIXTURES)
	parser.add_argument(
		"--keep",
		action="store_true",
		help="Write canonical results under tmp/policy-parity/",
	)
	args = parser.parse_args()

	with tempfile.TemporaryDirectory(prefix="meriknow-policy-parity-") as tmp:
		tmp_path = Path(tmp)
		py_out = tmp_path / "py.json"
		js_out = tmp_path / "js.json"
		_run_py(args.fixtures, py_out)
		_run_js(args.fixtures, js_out)
		py_report = json.loads(py_out.read_text(encoding="utf-8"))
		js_report = json.loads(js_out.read_text(encoding="utf-8"))
		py_canon = _canonical(py_report)
		js_canon = _canonical(js_report)
		if args.keep:
			keep_dir = REPO_ROOT / "tmp" / "policy-parity"
			keep_dir.mkdir(parents=True, exist_ok=True)
			(keep_dir / "py.json").write_text(py_canon, encoding="utf-8")
			(keep_dir / "js.json").write_text(js_canon, encoding="utf-8")
			print(f"wrote {keep_dir / 'py.json'}")
			print(f"wrote {keep_dir / 'js.json'}")
		if py_canon != js_canon:
			sys.stderr.write("policy parity MISMATCH\n")
			py_by_id = {r["id"]: r for r in py_report.get("results", [])}
			js_by_id = {r["id"]: r for r in js_report.get("results", [])}
			for case_id in sorted(set(py_by_id) | set(js_by_id)):
				a = py_by_id.get(case_id)
				b = js_by_id.get(case_id)
				if a != b:
					sys.stderr.write(f"\n--- case {case_id} ---\n")
					sys.stderr.write(
						f"python: {json.dumps(a, sort_keys=True, ensure_ascii=False)}\n"
					)
					sys.stderr.write(
						f"js:     {json.dumps(b, sort_keys=True, ensure_ascii=False)}\n"
					)
			return 1
		print(f"policy parity OK ({len(py_report.get('results', []))} cases)")
		return 0


if __name__ == "__main__":
	raise SystemExit(main())
