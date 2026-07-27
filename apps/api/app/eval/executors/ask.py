"""Ask executor — stub AskGraph with optional ablation variants."""

from __future__ import annotations

from app.eval.assertions import check_expect
from app.eval.environment import isolated_ask_settings, resolve_ablation
from app.eval.schemas import EvalCase, EvalCaseResult


def run_ask(case: EvalCase) -> EvalCaseResult:
	import time

	ask_overrides, env_overrides, skip_reason = resolve_ablation(case)
	if skip_reason and case.policy_variant:
		from app.eval.ablation import variant_by_id

		try:
			variant = variant_by_id(case.policy_variant)
		except KeyError:
			variant = None
		if variant and (variant.requires_graph_hook or variant.not_evaluable):
			return EvalCaseResult(
				id=case.id,
				ok=True,
				kind=case.kind,
				errors=[],
				observed={"skipped": True},
				policy_variant=case.policy_variant,
				category=case.category,
				skipped=True,
				skip_reason=skip_reason,
			)

	t0 = time.perf_counter()
	with isolated_ask_settings(env_overrides) as service:
		# history 样例直接调用图，避免依赖持久化 session memory。
		if case.history:
			ask_settings = service._ask_settings_for_request(ask_overrides)
			graph = service._graph_for_settings(ask_settings)
			state = graph.invoke(
				{
					"session_id": case.session_id or f"eval-{case.id}",
					"question": case.question,
					"library_id": case.library_id,
					"history": case.history,
					"retrieval_debug": {},
				}
			)
			debug = state.get("retrieval_debug") or {}
			observed = {
				"query_type": state.get("query_type") or debug.get("query_type"),
				"refused": bool(state.get("refused")),
				"refuse_reason": state.get("refuse_reason"),
				"answer": state.get("answer") or "",
				"judge": state.get("judgement") or debug.get("judgement"),
				"retrieval_plan": state.get("retrieval_plan") or debug.get("retrieval_plan"),
				"citations": state.get("citations") or debug.get("citations") or [],
				"ask_overrides": ask_overrides,
			}
		else:
			resp = service.ask(
				question=case.question,
				library_id=case.library_id,
				ask_overrides=ask_overrides,
			)
			debug = resp.retrieval_debug or {}
			observed = {
				"query_type": debug.get("query_type"),
				"refused": resp.refused,
				"refuse_reason": resp.refuse_reason,
				"answer": resp.answer,
				"judge": debug.get("judgement"),
				"retrieval_plan": debug.get("retrieval_plan"),
				"citations": getattr(resp, "citations", None) or debug.get("citations") or [],
				"ask_overrides": ask_overrides,
			}
	duration_ms = (time.perf_counter() - t0) * 1000.0
	errors = check_expect(case.expect, observed)
	return EvalCaseResult(
		id=case.id,
		ok=not errors,
		kind=case.kind,
		errors=errors,
		observed=observed,
		policy_variant=case.policy_variant,
		category=case.category,
		duration_ms=duration_ms,
	)
