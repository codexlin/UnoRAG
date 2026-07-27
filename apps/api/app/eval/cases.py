"""Eval case loading — JSONL → EvalCase list."""

from __future__ import annotations

import json
from pathlib import Path

from app.eval.schemas import EvalCase

DEFAULT_CASES = Path(__file__).resolve().parents[2] / "tests" / "eval" / "eval_cases.jsonl"


def load_eval_cases(path: Path | None = None) -> list[EvalCase]:
	resolved = path or DEFAULT_CASES
	cases: list[EvalCase] = []
	with resolved.open("r", encoding="utf-8") as handle:
		for line_no, line in enumerate(handle, start=1):
			text = line.strip()
			if not text or text.startswith("#"):
				continue
			try:
				raw = json.loads(text)
				cases.append(EvalCase.model_validate(raw))
			except Exception as exc:
				raise ValueError(f"invalid eval case at {resolved}:{line_no}: {exc}") from exc
	return cases
