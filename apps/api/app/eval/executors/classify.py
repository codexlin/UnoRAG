"""Classify executor — query_type + retrieval_plan checks."""

from __future__ import annotations

from app.eval.assertions import check_expect
from app.eval.schemas import EvalCase, EvalCaseResult
from app.services.query_router import classify_query
from app.services.retrieval_plan import build_retrieval_plan


def run_classify(case: EvalCase) -> EvalCaseResult:
	query_type, reason = classify_query(case.question, history=case.history or None)
	plan = build_retrieval_plan(
		query_type=query_type,
		route_reason=reason,
		library_id=case.library_id,
		top_k=6,
		hybrid_enabled=False,
		rerank_enabled=False,
		question=case.question,
	)
	observed = {
		"query_type": query_type,
		"route_reason": reason,
		"retrieval_plan": plan,
	}
	errors = check_expect(case.expect, observed)
	return EvalCaseResult(
		id=case.id,
		ok=not errors,
		kind=case.kind,
		errors=errors,
		observed=observed,
	)
