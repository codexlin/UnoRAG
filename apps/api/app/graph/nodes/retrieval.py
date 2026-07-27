"""AskGraph ordinary retrieve + post-retrieve routing."""

from __future__ import annotations

import time
from types import SimpleNamespace
from typing import Any, Literal

from app.graph.context import AskGraphContext
from app.graph.nodes.common import _merge_debug, _renumber_citation_indexes
from app.graph.state import AskState
from app.services.ask_route import should_upgrade_fast_to_precise_table
from app.services.ask_trace import append_stage, citation_retrieve_detail
from app.services.citation_adjudicate import (
	adjudicate_debug_fields,
	apply_citation_adjudicate,
	wide_recall_limit,
)


def build_retrieval_nodes(ctx: AskGraphContext) -> SimpleNamespace:
	def retrieve_node(state: AskState) -> AskState:
		t0 = time.perf_counter()
		query = state.get("rewritten_question") or state["question"]
		attempts = int(state.get("retrieval_attempts") or 0) + 1
		plan = dict(state.get("retrieval_plan") or {})
		top_k = int(plan.get("top_k") or ctx.settings.retrieve_top_k)
		# 宽召回：裁决前多取候选；display/context 再截到 top_k
		candidate_k = wide_recall_limit(top_k, ctx.settings)
		filters = dict(plan.get("filters") or {})
		plan_rt = str(plan.get("record_type") or filters.get("record_type") or "chunk")
		unified_fast = plan_rt == "chunk+table_summary" or (
			str(plan.get("path") or "") == "fast"
			and plan_rt not in {"section", "table", "table_summary"}
		)

		if unified_fast:
			chunk_filters = dict(filters)
			chunk_filters["record_type"] = "chunk"
			citations = ctx.retrieve(
				query, state.get("library_id"), candidate_k, chunk_filters
			)
			summary_filters = dict(filters)
			summary_filters["record_type"] = "table_summary"
			summaries = ctx.retrieve(
				query,
				state.get("library_id"),
				min(4, candidate_k),
				summary_filters,
			)
			combined = [*summaries, *citations]
			deduped: list[dict[str, Any]] = []
			seen: set[str] = set()
			for item in sorted(
				combined,
				key=lambda value: float(value.get("score") or 0),
				reverse=True,
			):
				key = str(
					item.get("record_id")
					or item.get("id")
					or (
						item.get("doc_id"),
						item.get("table_id"),
						item.get("record_type"),
						item.get("chunk_index"),
					)
				)
				if key in seen:
					continue
				seen.add(key)
				deduped.append(item)
			# 裁决前暂不硬截 top_k；保留宽池供 citation_adjudicate
			citations = deduped[: max(candidate_k, top_k + min(4, top_k))]
			filters = {**filters, "record_type": "chunk+table_summary"}
			resolved_rt = "chunk+table_summary"
		else:
			if plan.get("record_type") and "record_type" not in filters:
				filters["record_type"] = plan["record_type"]
			citations = ctx.retrieve(
				query, state.get("library_id"), candidate_k, filters
			)
			resolved_rt = str(filters.get("record_type") or plan_rt)

		# 文本引用裁决（table precise 路径不走本节点）
		adjudicate_result = apply_citation_adjudicate(
			query,
			citations,
			top_k=top_k,
			settings=ctx.settings,
		)
		citations = adjudicate_result.citations

		# 薄 citation_check：section 命中应能回溯 source_chunk_ids
		citation_check = {"ok": True, "missing_source_chunk_ids": 0}
		if resolved_rt == "section":
			missing = sum(
				1
				for item in citations
				if not (item.get("source_chunk_ids") or [])
			)
			citation_check = {
				"ok": missing == 0,
				"missing_source_chunk_ids": missing,
			}
		debug_extra: dict[str, Any] = {
			"record_type": resolved_rt,
			"filters": filters,
			"citation_check": citation_check,
			**adjudicate_debug_fields(adjudicate_result),
		}
		tool_trace: list[dict[str, Any]] = []
		# TOOL_ASK：默认仍短路径；仅规范化 citation + 记录 search_docs 轨迹（多跳工具后续扩展）
		if ctx.settings.tool_ask:
			from app.services.ingest.tools import quote_source

			citations = [quote_source(item) for item in citations]
			tool_trace.append(
				{
					"tool": "search_docs",
					"query": query,
					"hit_count": len(citations),
				}
			)
		# 最终保障：多路合并 / quote_source / 裁决后 index 仍为唯一连续 1..N
		citations = _renumber_citation_indexes(citations)
		top_score = float(citations[0]["score"]) if citations else None
		used_rerank = bool(citations and citations[0].get("used_rerank"))
		retrieve_ms = (time.perf_counter() - t0) * 1000
		retrieve_detail = citation_retrieve_detail(citations)

		# 阶段2：fast → precise 升级（写死条件 + upgrade_reason）
		t_adjudicate0 = time.perf_counter()
		upgrade: str | None = None
		upgrade_reason: str | None = None
		out_plan = plan
		out_query_type = str(state.get("query_type") or plan.get("query_type") or "fact")
		if str(plan.get("path") or "fast") == "fast" and resolved_rt != "section":
			do_upgrade, reason = should_upgrade_fast_to_precise_table(
				state.get("question") or query,
				citations,
			)
			if do_upgrade:
				upgrade = "precise"
				upgrade_reason = reason
				out_query_type = "table"
				out_plan = {
					**plan,
					"path": "precise",
					"precise_kind": "table",
					"execute_path": "table",
					"record_type": "table",
					"query_type": "table",
					"route": plan.get("route") or "fast",
					"reason": f"upgrade:{reason}",
				}
				filters_up = dict(out_plan.get("filters") or {})
				filters_up["record_type"] = "table"
				out_plan["filters"] = filters_up
		adjudicate_ms = (time.perf_counter() - t_adjudicate0) * 1000

		debug = _merge_debug(
			state,
			retrieve=ctx.mode,
			library_id=state.get("library_id"),
			hit_count=len(citations),
			top_score=top_score,
			used_rerank=used_rerank,
			retrieval_attempts=attempts,
			query=query,
			tool_ask=bool(ctx.settings.tool_ask),
			tool_trace=tool_trace,
			retrieval_plan=out_plan,
			route=out_plan.get("route") or plan.get("route"),
			path=out_plan.get("path"),
			precise_kind=out_plan.get("precise_kind"),
			upgrade=upgrade,
			upgrade_reason=upgrade_reason,
			**debug_extra,
		)
		append_stage(
			debug,
			name="retrieve",
			duration_ms=retrieve_ms,
			detail=retrieve_detail,
		)
		append_stage(
			debug,
			name="adjudicate",
			duration_ms=adjudicate_ms,
			detail={
				"decision": "upgrade" if upgrade else "keep",
				"decision_reason": upgrade_reason,
				"upgrade_to": upgrade,
			},
		)
		return {
			"citations": citations,
			"retrieval_attempts": attempts,
			"retrieval_plan": out_plan,
			"query_type": out_query_type,
			"upgrade": upgrade,
			"upgrade_reason": upgrade_reason,
			"retrieval_debug": debug,
		}
	def route_after_retrieve(
		state: AskState,
	) -> Literal["upgrade_precise", "judge"]:
		if state.get("upgrade") == "precise":
			return "upgrade_precise"
		return "judge"
	return SimpleNamespace(
		retrieve=retrieve_node,
		route_after_retrieve=route_after_retrieve,
	)
