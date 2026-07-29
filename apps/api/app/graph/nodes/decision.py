"""AskGraph decision: judge, retry, refuse + related route helpers."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Literal

from app.graph.context import AskGraphContext
from app.graph.nodes.common import _library_label, _merge_debug
from app.graph.state import AskState
from app.services.answer_copy import no_match_answer, weak_match_answer


def build_decision_nodes(
	ctx: AskGraphContext,
	*,
	min_score: float,
	max_retries: int,
) -> SimpleNamespace:
	"""Build judge/retry/refuse callables closed over ctx + score thresholds."""
	_ = ctx

	def judge_node(state: AskState) -> AskState:
		citations = state.get("citations") or []
		attempts = int(state.get("retrieval_attempts") or 0)
		library_name = _library_label(state.get("library_id"))
		table_execution = state.get("table_execution") or {}
		query_type = str(state.get("query_type") or "")

		# 表格结构化执行成功：证据充分，跳过 dense score 阈值
		if (
			query_type == "table"
			and table_execution.get("ok")
			and (state.get("table_query_plan") or {}).get("confident")
		):
			judgement = {
				"sufficient": True,
				"action": "generate",
				"reason": "table_exec_ok",
				"top_score": float(citations[0].get("score") or 1.0) if citations else 1.0,
				"min_score": min_score,
			}
			return {
				"judgement": judgement,
				"refuse_reason": None,
				"retrieval_debug": _merge_debug(
					state, judgement=judgement, library_name=library_name
				),
			}

		if not citations:
			can_retry = attempts <= max_retries
			judgement = {
				"sufficient": False,
				"action": "retry" if can_retry else "refuse",
				"reason": "no_hit",
				"can_retry": can_retry,
			}
		else:
			top_score = float(citations[0].get("score") or 0.0)
			# 低于阈值必须走正式 refuse（refused=true），禁止落到 generate 再靠模型口头「未覆盖」
			weak = min_score > 0 and top_score < min_score
			# table fallback（软问法）：有命中即生成，不因分数卡死 stub/结构化表
			if query_type == "table" and not weak:
				judgement = {
					"sufficient": True,
					"action": "generate",
					"reason": "table_fallback_llm",
					"top_score": top_score,
					"min_score": min_score,
				}
			elif weak:
				can_retry = attempts <= max_retries
				judgement = {
					"sufficient": False,
					"action": "retry" if can_retry else "refuse",
					"reason": "weak_match",
					"top_score": top_score,
					"min_score": min_score,
					"can_retry": can_retry,
				}
			else:
				judgement = {
					"sufficient": True,
					"action": "generate",
					"reason": "ok",
					"top_score": top_score,
					"min_score": min_score,
				}

		# Attach human-facing refuse reason early for refuse path.
		refuse_reason = None
		if judgement["action"] == "refuse":
			refuse_reason = judgement["reason"]

		return {
			"judgement": judgement,
			"refuse_reason": refuse_reason,
			"retrieval_debug": _merge_debug(state, judgement=judgement, library_name=library_name),
		}
	def route_after_judge(state: AskState) -> Literal["retry", "generate", "refuse"]:
		action = (state.get("judgement") or {}).get("action") or "generate"
		if action == "retry":
			return "retry"
		if action == "refuse":
			return "refuse"
		return "generate"
	def route_after_retry(state: AskState) -> Literal["retrieve", "table_retrieve"]:
		plan = state.get("retrieval_plan") or {}
		if (
			str(state.get("query_type") or "") == "table"
			or plan.get("path") == "precise"
			or state.get("upgrade") == "precise"
		):
			return "table_retrieve"
		return "retrieve"
	def retry_node(state: AskState) -> AskState:
		"""Broaden query once, then re-enter retrieve."""
		base = state.get("rewritten_question") or state["question"]
		reason = (state.get("judgement") or {}).get("reason")
		if reason == "weak_match":
			broadened = f"{base} 相关制度 条款 规定"
		else:
			broadened = f"{base} 关键词 概要"
		return {
			"rewritten_question": broadened,
			"retrieval_debug": _merge_debug(
				state,
				retry={"from": base, "to": broadened, "reason": reason},
			),
		}
	def refuse_node(state: AskState) -> AskState:
		reason = (
			(state.get("judgement") or {}).get("reason")
			or state.get("refuse_reason")
			or "no_hit"
		)
		library_name = _library_label(state.get("library_id"))
		if reason == "weak_match":
			answer = weak_match_answer(library_name=library_name)
		else:
			answer = no_match_answer(library_name=library_name)
		return {
			"answer": answer,
			# “引用”只代表支持最终答案的证据；弱召回候选留在 debug，
			# 不作为支持证据返回给用户或写入归档。
			"citations": [],
			"refused": True,
			"refuse_reason": reason,
			"retrieval_debug": _merge_debug(
				state,
				generate="refuse",
				refuse_reason=reason,
				retrieved_candidate_count=len(state.get("citations") or []),
			),
		}
	return SimpleNamespace(
		judge=judge_node,
		retry=retry_node,
		refuse=refuse_node,
		route_after_judge=route_after_judge,
		route_after_retry=route_after_retry,
	)
