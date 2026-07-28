#!/usr/bin/env python3
"""Emit standardized policy-parity JSON from Python policy_profiles.

Usage (from UnoRAG repo root):
  uv run --directory apps/api python ../../scripts/policy_parity_py.py
  uv run --directory apps/api python ../../scripts/policy_parity_py.py --out /tmp/py.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
API_ROOT = REPO_ROOT / "apps" / "api"
FIXTURES = REPO_ROOT / "tests" / "contracts" / "policy-parity" / "fixtures.json"

# Allow `python scripts/policy_parity_py.py` when PYTHONPATH includes apps/api.
if str(API_ROOT) not in sys.path:
	sys.path.insert(0, str(API_ROOT))

from app.services.ask_defaults import ASK_OVERRIDE_KEYS  # noqa: E402
from app.services.policy_profiles import (  # noqa: E402
	migrate_legacy_ask_to_public,
	resolve_ask_policy,
	resolve_document_policy,
)


def _stable(obj: Any) -> Any:
	"""Normalize for stable JSON (sorted keys; list order preserved)."""
	if isinstance(obj, dict):
		return {k: _stable(obj[k]) for k in sorted(obj)}
	if isinstance(obj, list):
		return [_stable(x) for x in obj]
	if isinstance(obj, tuple):
		return [_stable(x) for x in obj]
	return obj


def _run_case(case: dict[str, Any]) -> dict[str, Any]:
	kind = case["kind"]
	inp = case.get("input") or {}
	if kind == "ask_resolve":
		resolved = resolve_ask_policy(
			inp.get("raw"),
			question=inp.get("question"),
			policy_version=inp.get("policy_version"),
		)
		output = resolved.snapshot()
	elif kind == "ask_migrate":
		output = migrate_legacy_ask_to_public(inp.get("raw"))
	elif kind == "document_resolve":
		output = resolve_document_policy(
			document_profile=inp.get("document_profile"),
			scan_handling=inp.get("scan_handling"),
			parse_preference=inp.get("parse_preference"),
		).as_dict()
	elif kind == "override_keys":
		output = {"override_keys": list(ASK_OVERRIDE_KEYS)}
	else:
		raise ValueError(f"unknown kind: {kind}")
	return {"id": case["id"], "kind": kind, "output": _stable(output)}


def build_report(fixtures_path: Path = FIXTURES) -> dict[str, Any]:
	payload = json.loads(fixtures_path.read_text(encoding="utf-8"))
	results = [_run_case(case) for case in payload["cases"]]
	return _stable(
		{
			"version": payload.get("version", 1),
			"runtime": "python",
			"results": results,
		}
	)


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument(
		"--fixtures",
		type=Path,
		default=FIXTURES,
		help="Path to shared fixtures.json",
	)
	parser.add_argument(
		"--out",
		type=Path,
		default=None,
		help="Write JSON to file instead of stdout",
	)
	args = parser.parse_args()
	report = build_report(args.fixtures)
	text = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
	if args.out:
		args.out.write_text(text, encoding="utf-8")
	else:
		sys.stdout.write(text)
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
