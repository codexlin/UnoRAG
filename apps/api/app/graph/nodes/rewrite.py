"""AskGraph multi-turn rewrite + structured retrieval plan request."""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

from app.graph.context import AskGraphContext
from app.graph.messages import history_for_generate, rewrite_with_history
from app.graph.nodes.common import _merge_debug
from app.graph.state import AskState
from app.services.llm import llm_inflight_slot
from app.services.retrieval_plan_contract import (
	build_retrieval_plan_messages,
	merge_plan_filters,
	resolve_structured_retrieval_plan,
)
from app.settings import Settings

logger = logging.getLogger(__name__)


def _request_structured_retrieval_plan_json(
	settings: Settings,
	*,
	question: str,
	fallback_semantic_query: str,
) -> str:
	"""Live 路径：轻量 LLM JSON 计划；失败由调用方降级。"""
	from openai import OpenAI

	messages = build_retrieval_plan_messages(
		question=question,
		fallback_semantic_query=fallback_semantic_query,
	)
	client = OpenAI(
		api_key=settings.llm_api_key,
		base_url=settings.llm_base_url,
	)
	with llm_inflight_slot(settings):
		response = client.chat.completions.create(
			model=settings.chat_model,
			messages=messages,
			temperature=0.0,
		)
	content = ""
	if response.choices:
		content = response.choices[0].message.content or ""
	return str(content).strip()


def build_rewrite_nodes(ctx: AskGraphContext, *, min_score: float) -> SimpleNamespace:
	def rewrite_node(state: AskState) -> AskState:
		question = state["question"].strip()
		history = state.get("history") or []
		rewritten, rewrite_mode = rewrite_with_history(question, history)
		gen_history = history_for_generate(history)

		# Phase 3：结构化 RetrievalPlan（LLM JSON → Pydantic）；失败降级纯语义
		raw_plan: str | dict[str, Any] | None = None
		from_llm = False
		llm_error: str | None = None
		if ctx.mode == "live" and bool(getattr(ctx.settings, "has_llm_key", False)):
			from_llm = True
			try:
				# Late-bind via ask_graph so tests can monkeypatch
				# app.graph.ask_graph._request_structured_retrieval_plan_json.
				from app.graph import ask_graph as _ask_graph_mod

				raw_plan = _ask_graph_mod._request_structured_retrieval_plan_json(
					ctx.settings,
					question=question,
					fallback_semantic_query=rewritten,
				)
			except Exception as exc:
				llm_error = str(exc)[:240]
				logger.warning(
					"retrieval_plan.llm_failed error=%s",
					llm_error,
				)
				raw_plan = None
		structured = resolve_structured_retrieval_plan(
			raw=raw_plan,
			fallback_semantic_query=rewritten,
			from_llm=from_llm,
			llm_error=llm_error,
		)
		route_plan = dict(state.get("retrieval_plan") or {})
		merged_filters = merge_plan_filters(
			route_plan.get("filters") if isinstance(route_plan.get("filters"), dict) else {},
			structured,
		)
		route_plan["filters"] = merged_filters
		# Strategy A：检索 query 保留 history rewrite；plan 只贡献 filters（及 debug 中的 semantic_query）
		retrieval_query = rewritten
		route_plan["rewritten_queries"] = [retrieval_query]
		if (
			not structured.degraded
			and structured.applied_filters.get("record_type")
			and not route_plan.get("record_type")
		):
			route_plan["record_type"] = structured.applied_filters["record_type"]

		return {
			"rewritten_question": retrieval_query,
			"retrieval_plan": route_plan,
			"retrieval_attempts": 0,
			"refused": False,
			"refuse_reason": None,
			"retrieval_debug": _merge_debug(
				state,
				rewrite=rewrite_mode,
				# Loaded history messages (user+assistant); rewrite uses last turn only.
				history_turns=len(history),
				# Messages injected into generate (after turn/char trim).
				generate_history_turns=len(gen_history),
				mode=ctx.mode,
				answer_min_score=min_score,
				rerank_enabled=bool(ctx.settings.rerank_enabled),
				structured_retrieval_plan=structured.debug_fields(),
				retrieval_plan=route_plan,
				retrieval_query=retrieval_query,
				retrieval_query_source="history_rewrite",
				plan_semantic_query=structured.plan.semantic_query,
			),
		}
	return SimpleNamespace(rewrite=rewrite_node)
