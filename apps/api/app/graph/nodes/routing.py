"""AskGraph routing: query_router, build_plan, clarify, route helpers."""

from __future__ import annotations

import time
from types import SimpleNamespace
from typing import Any, Literal

from app.graph.context import AskGraphContext
from app.graph.nodes.common import _library_label, _merge_debug
from app.graph.state import AskState
from app.services.answer_copy import clarify_answer
from app.services.ask_trace import append_stage
from app.services.query_router import route_query
from app.services.retrieval_plan import build_retrieval_plan


def build_routing_nodes(ctx: AskGraphContext, *, min_score: float) -> SimpleNamespace:
	def query_router_node(state: AskState) -> AskState:
		"""规则分类；summary/table/ambiguous 等仅落盘，不建子图。"""
		routed = route_query(
			state["question"],
			history=state.get("history") or [],
			library_id=state.get("library_id"),
		)
		query_type = str(routed["query_type"])
		route_reason = str(routed["reason"])
		return {
			"query_type": query_type,
			"route_reason": route_reason,
			"retrieval_attempts": 0,
			"refused": False,
			"refuse_reason": None,
			"retrieval_debug": _merge_debug(
				state,
				query_type=query_type,
				route_reason=route_reason,
				mode=ctx.mode,
				answer_min_score=min_score,
				rerank_enabled=bool(ctx.settings.rerank_enabled),
				tenant_id=ctx.scope.tenant_id,
				workspace_id=ctx.scope.workspace_id,
			),
		}
	def build_plan_node(state: AskState) -> AskState:
		t0 = time.perf_counter()
		query_type = str(state.get("query_type") or "fact")
		route_reason = str(state.get("route_reason") or "default_fact")
		plan = build_retrieval_plan(
			query_type=query_type,
			route_reason=route_reason,
			library_id=state.get("library_id"),
			top_k=ctx.settings.retrieve_top_k,
			hybrid_enabled=bool(ctx.settings.hybrid_enabled),
			rerank_enabled=bool(ctx.settings.rerank_enabled),
			tenant_id=ctx.scope.tenant_id,
			workspace_id=ctx.scope.workspace_id,
			question=state.get("question"),
		)
		debug = _merge_debug(
			state,
			retrieval_plan=plan,
			route=plan.get("route"),
			path=plan.get("path"),
			precise_kind=plan.get("precise_kind"),
			upgrade=None,
			upgrade_reason=None,
			downgrade_reason=None,
		)
		append_stage(
			debug,
			name="route",
			duration_ms=(time.perf_counter() - t0) * 1000,
			detail={
				"path": plan.get("path"),
				"route": plan.get("route"),
				"decision_reason": plan.get("reason") or route_reason,
			},
		)
		return {
			"retrieval_plan": plan,
			"upgrade": None,
			"upgrade_reason": None,
			"downgrade_reason": None,
			"retrieval_debug": debug,
		}
	def route_after_plan(state: AskState) -> Literal["clarify", "rewrite"]:
		"""Clarify short-circuits; all retrieval paths rewrite first (incl. table)."""
		plan = state.get("retrieval_plan") or {}
		path = str(plan.get("path") or "")
		execute_path = str(plan.get("execute_path") or "short")
		if path == "clarify" or execute_path == "clarify":
			return "clarify"
		return "rewrite"
	def route_after_rewrite(state: AskState) -> Literal["retrieve", "table"]:
		plan = state.get("retrieval_plan") or {}
		if str(plan.get("path") or "") == "precise" and plan.get("precise_kind") == "table":
			return "table"
		if str(plan.get("execute_path") or "") == "table":
			return "table"
		return "retrieve"
	def clarify_node(state: AskState) -> AskState:
		library_name = _library_label(state.get("library_id"))
		judgement = {
			"sufficient": False,
			"action": "clarify",
			"reason": "ambiguous",
			"can_retry": False,
		}
		return {
			"answer": clarify_answer(library_name=library_name),
			"citations": [],
			"refused": True,
			"refuse_reason": "ambiguous",
			"judgement": judgement,
			"retrieval_debug": _merge_debug(
				state,
				judgement=judgement,
				generate="clarify",
				refuse_reason="ambiguous",
			),
		}
	return SimpleNamespace(
		query_router=query_router_node,
		build_plan=build_plan_node,
		clarify=clarify_node,
		route_after_plan=route_after_plan,
		route_after_rewrite=route_after_rewrite,
	)
