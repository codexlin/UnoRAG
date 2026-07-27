"""Eval executors registry — kind → runner fn (replaces large if/elif)."""

from __future__ import annotations

from collections.abc import Callable

from app.eval.executors.ask import run_ask
from app.eval.executors.classify import run_classify
from app.eval.executors.ingest_chunk import run_ingest_chunk
from app.eval.executors.ingest_http import run_ingest_http
from app.eval.executors.retrieval import run_retrieval
from app.eval.schemas import EvalCase, EvalCaseResult

ExecutorFn = Callable[[EvalCase], EvalCaseResult]

EXECUTORS: dict[str, ExecutorFn] = {
	"classify": run_classify,
	"ingest_chunk": run_ingest_chunk,
	"retrieval": run_retrieval,
	"ingest_http": run_ingest_http,
	"ask": run_ask,
}


def run_case(case: EvalCase) -> EvalCaseResult:
	"""Dispatch by case.kind; unknown kinds raise (fail-closed)."""
	try:
		executor = EXECUTORS[case.kind]
	except KeyError as exc:
		known = ", ".join(sorted(EXECUTORS))
		raise ValueError(
			f"unknown eval executor kind {case.kind!r}; known: {known}"
		) from exc
	return executor(case)


__all__ = ["EXECUTORS", "ExecutorFn", "run_case"]
