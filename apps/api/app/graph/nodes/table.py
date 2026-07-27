"""AskGraph table retrieve / execute path."""

from __future__ import annotations

import time
from types import SimpleNamespace
from typing import Any, Literal

from app.graph.context import AskGraphContext
from app.graph.nodes.common import (
	_library_label,
	_merge_debug,
	_renumber_citation_indexes,
)
from app.graph.state import AskState
from app.services.answer_copy import table_unclear_answer
from app.services.ask_route import table_overview_downgrade_reason
from app.services.ask_trace import append_stage, citation_retrieve_detail
from app.services.query_router import looks_like_table_summary_lookup
from app.services.table_query import (
	build_dual_table_query_plan,
	build_table_query_plan,
	citations_for_table_overview,
	citations_with_dual_matched_evidence,
	citations_with_matched_evidence,
	execute_dual_table_query,
	execute_table_query,
	looks_like_numeric_table_query,
	prepare_dual_tables_for_execute,
	prepare_table_for_execute,
	table_instance_key,
)


def build_table_nodes(ctx: AskGraphContext) -> SimpleNamespace:
	def build_table_plan_node(state: AskState) -> AskState:
		"""轻量 TableQueryPlan；不确定则 fallback（retrieve 后仍可能 clarify）。"""
		question = state.get("question") or ""
		tq = build_table_query_plan(question)
		return {
			"table_query_plan": tq,
			"retrieval_debug": _merge_debug(state, table_query_plan=tq),
		}
	def table_retrieve_node(state: AskState) -> AskState:
		"""Retrieve table summaries for discovery plus row groups for evidence."""
		t0 = time.perf_counter()
		query = state.get("rewritten_question") or state["question"]
		attempts = int(state.get("retrieval_attempts") or 0) + 1
		plan = state.get("retrieval_plan") or {}
		top_k = int(plan.get("top_k") or ctx.settings.retrieve_top_k)
		filters = dict(plan.get("filters") or {})
		filters["record_type"] = "table"
		citations = ctx.retrieve(query, state.get("library_id"), top_k, filters)
		summary_filters = dict(filters)
		summary_filters["record_type"] = "table_summary"
		summaries = ctx.retrieve(
			query,
			state.get("library_id"),
			min(4, top_k),
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
					item.get("row_start"),
				)
			)
			if key in seen:
				continue
			seen.add(key)
			deduped.append(item)
		citations = _renumber_citation_indexes(deduped[: top_k + min(4, top_k)])
		citation_check = {
			"ok": all(item.get("table_id") for item in citations) if citations else True,
			"missing_table_id": sum(1 for item in citations if not item.get("table_id")),
		}
		top_score = float(citations[0]["score"]) if citations else None
		retrieve_detail = citation_retrieve_detail(citations)
		debug = _merge_debug(
			state,
			retrieve=ctx.mode,
			library_id=state.get("library_id"),
			hit_count=len(citations),
			top_score=top_score,
			retrieval_attempts=attempts,
			query=query,
			record_type="table+table_summary",
			filters=filters,
			citation_check=citation_check,
		)
		append_stage(
			debug,
			name="retrieve",
			duration_ms=(time.perf_counter() - t0) * 1000,
			detail=retrieve_detail,
		)
		return {
			"citations": citations,
			"retrieval_attempts": attempts,
			"retrieval_debug": debug,
		}
	def table_execute_node(state: AskState) -> AskState:
		"""定位表实例 → 全表加载 → 代码侧过滤/聚合；缺组/不确定 → clarify。

		MVP 双表：若同库两表可等值 join 且计划自信，则读两份 store 再算；
		否则回退既有单表路径。
		"""
		t_load0 = time.perf_counter()
		citations = list(state.get("citations") or [])
		question = state.get("question") or ""

		dual_payload = prepare_dual_tables_for_execute(
			citations,
			load_table_groups=ctx.load_table_groups,
			library_id=state.get("library_id"),
			question=question,
		)
		dual_plan: dict[str, Any] | None = None
		if dual_payload and dual_payload.get("complete"):
			dual_plan = build_dual_table_query_plan(
				question,
				left_headers=list(dual_payload["left"].get("headers") or []),
				right_headers=list(dual_payload["right"].get("headers") or []),
				join_left_column=str(dual_payload.get("join_left_column") or ""),
				join_right_column=str(dual_payload.get("join_right_column") or ""),
			)

		use_dual = bool(
			dual_payload
			and dual_payload.get("complete")
			and dual_plan
			and dual_plan.get("confident")
			and dual_plan.get("operation") == "join_lookup"
		)

		if use_dual and dual_payload is not None and dual_plan is not None:
			load_ms = (time.perf_counter() - t_load0) * 1000
			tq = dual_plan
			merged = {
				"complete": True,
				"reason": dual_payload.get("reason") or "dual_equi_join",
				"group_count": int(dual_payload["left"].get("group_count") or 0)
				+ int(dual_payload["right"].get("group_count") or 0),
				"load_source": "store",
				"doc_id": dual_payload["left"].get("doc_id"),
				"table_id": dual_payload["left"].get("table_id"),
				"document_version_id": dual_payload["left"].get("document_version_id"),
				"headers": list(dual_payload["left"].get("headers") or []),
				"rows": [],
				"table_quality": {},
				"mode": "dual",
				"left_table_id": dual_payload["left"].get("table_id"),
				"right_table_id": dual_payload["right"].get("table_id"),
			}
			table_complete = True
			t_exec0 = time.perf_counter()
			execution = execute_dual_table_query(
				tq,
				left=dual_payload["left"],
				right=dual_payload["right"],
				collect_evidence_indices=True,
			)
			exec_ms = (time.perf_counter() - t_exec0) * 1000
			# 双表临时证据字段：选完 citation 后再丢弃
			_ = execution.pop("_evidence_row_indices", None)
			left_evidence = list(execution.pop("_evidence_left_row_indices", []) or [])
			right_evidence = list(execution.pop("_evidence_right_row_indices", []) or [])
			# 供 citations helper 从 matched_rows 恢复两侧行号
			execution["_evidence_left_row_indices"] = left_evidence
			execution["_evidence_right_row_indices"] = right_evidence

			def _with_table_stages(debug: dict[str, Any]) -> dict[str, Any]:
				append_stage(
					debug,
					name="table_load",
					duration_ms=load_ms,
					ok=True,
					detail={
						"load_source": "store",
						"complete": True,
						"mode": "dual",
						"left_table_id": dual_payload["left"].get("table_id"),
						"right_table_id": dual_payload["right"].get("table_id"),
						"join_left_column": dual_payload.get("join_left_column"),
						"join_right_column": dual_payload.get("join_right_column"),
					},
				)
				matched_count = execution.get("matched_count")
				if matched_count is None and isinstance(
					execution.get("matched_rows"), list
				):
					matched_count = len(execution["matched_rows"])
				append_stage(
					debug,
					name="table_execute",
					duration_ms=exec_ms,
					ok=bool(execution.get("ok")),
					detail={
						"operation": execution.get("operation"),
						"ok": bool(execution.get("ok")),
						"matched_count": matched_count,
						"mode": "dual",
						"table_count": 2,
					},
				)
				return debug

			enriched = [dict(item) for item in citations]
			for row in enriched:
				rt = str(row.get("record_type") or "")
				if rt not in {"table", "table_summary"}:
					row["record_type"] = "table"

			if execution.get("ok") and tq.get("confident"):
				enriched, evidence_meta = citations_with_dual_matched_evidence(
					enriched,
					left=dual_payload["left"],
					right=dual_payload["right"],
					execution=execution,
				)
				execution.update(evidence_meta)
			execution.pop("_evidence_left_row_indices", None)
			execution.pop("_evidence_right_row_indices", None)

			can_execute = bool(
				execution.get("ok") and tq.get("confident") and table_complete
			)
			must_compute = bool(
				looks_like_numeric_table_query(question)
				and not looks_like_table_summary_lookup(question)
			)
			table_load = {
				"complete": table_complete,
				"reason": merged.get("reason"),
				"group_count": merged.get("group_count"),
				"load_source": "store",
				"mode": "dual",
				"doc_id": merged.get("doc_id"),
				"table_id": merged.get("table_id"),
				"left_table_id": dual_payload["left"].get("table_id"),
				"right_table_id": dual_payload["right"].get("table_id"),
			}

			if can_execute:
				return {
					"table_query_plan": tq,
					"table_execution": execution,
					"citations": enriched,
					"downgrade_reason": None,
					"retrieval_debug": _with_table_stages(
						_merge_debug(
							state,
							table_query_plan=tq,
							table_execution=execution,
							table_load=table_load,
							downgrade_reason=None,
							precise_gate="execute",
						)
					),
				}

			# 双表尝试失败：不在此硬拒，落入下方单表路径再判定
			# （避免互补误判时误杀单表可答问题）

		merged = prepare_table_for_execute(
			citations,
			load_table_groups=ctx.load_table_groups,
			library_id=state.get("library_id"),
			question=question,
		)
		load_ms = (time.perf_counter() - t_load0) * 1000
		headers = list(merged.get("headers") or [])
		table_complete = bool(merged.get("complete"))
		table_quality = dict(merged.get("table_quality") or {})
		quality_executable = table_quality.get("executable", True) is not False
		# 用真实表头 refinement plan
		base_plan = dict(state.get("table_query_plan") or {})
		refined = build_table_query_plan(question, headers=headers or None)
		# 若初始已自信且 refinement 因缺 headers 仍自信，保留；否则用 refined
		tq = refined if headers else base_plan

		t_exec0 = time.perf_counter()
		if headers and table_complete and quality_executable:
			execution = execute_table_query(
				tq,
				headers=headers,
				rows=list(merged.get("rows") or []),
				row_offset=int(merged.get("row_offset") or 0),
				collect_evidence_indices=True,
				summary_rows=list(merged.get("summary_rows") or []),
			)
		elif headers and table_complete and not quality_executable:
			execution = {
				"ok": False,
				"operation": str(tq.get("operation") or "fallback"),
				"matched_rows": [],
				"reason": "table_quality_not_executable",
				"quality_report": table_quality,
			}
		elif headers and not table_complete:
			# fail closed：禁止在 top_k 子集上聚合后标 table_exec_ok
			execution = {
				"ok": False,
				"operation": str(tq.get("operation") or "fallback"),
				"matched_rows": [],
				"reason": f"table_incomplete:{merged.get('reason') or 'unknown'}",
				"group_count": merged.get("group_count"),
				"load_source": merged.get("load_source"),
			}
		else:
			execution = {
				"ok": False,
				"operation": "fallback",
				"matched_rows": [],
				"reason": "no_table_payload",
			}
		exec_ms = (time.perf_counter() - t_exec0) * 1000
		evidence_row_indices = list(
			execution.pop(
				"_evidence_row_indices",
				execution.get("matched_row_indices") or [],
			)
		)

		def _with_table_stages(debug: dict[str, Any]) -> dict[str, Any]:
			append_stage(
				debug,
				name="table_load",
				duration_ms=load_ms,
				ok=bool(merged.get("complete")),
				detail={
					"load_source": merged.get("load_source"),
					"complete": bool(merged.get("complete")),
					"table_id": merged.get("table_id"),
				},
			)
			matched_count = execution.get("matched_count")
			if matched_count is None and isinstance(execution.get("matched_rows"), list):
				matched_count = len(execution["matched_rows"])
			append_stage(
				debug,
				name="table_execute",
				duration_ms=exec_ms,
				ok=bool(execution.get("ok")),
				detail={
					"operation": execution.get("operation"),
					"ok": bool(execution.get("ok")),
					"matched_count": matched_count,
				},
			)
			return debug

		# 标注 citation 行范围 / 版本（供 UI）；仅同实例
		# 保留 table_summary 的 record_type，避免与行组混淆（store 才是可执行路径）。
		target_key = (
			table_instance_key(merged)
			if merged.get("table_id")
			else None
		)
		enriched: list[dict[str, Any]] = []
		for item in citations:
			row = dict(item)
			rt = str(row.get("record_type") or "")
			if rt not in {"table", "table_summary"}:
				row["record_type"] = "table"
			if target_key and table_instance_key(row) == target_key:
				row.setdefault("document_version_id", merged.get("document_version_id"))
			enriched.append(row)

		# 全表执行命中的行可能在向量 top_k 之外：用证据行组替换同实例 citation
		if (
			execution.get("ok")
			and tq.get("confident")
			and table_complete
			and (
				evidence_row_indices
				or execution.get("matched_rows")
			)
			and merged.get("groups")
		):
			enriched, evidence_meta = citations_with_matched_evidence(
				enriched,
				groups=list(merged.get("groups") or []),
				matched_rows=list(execution.get("matched_rows") or []),
				matched_row_indices=evidence_row_indices,
				target_key=target_key,
				seed_citation=merged.get("citation") or (citations[0] if citations else None),
			)
			execution.update(evidence_meta)

		# 精路径三岔门：能算则算 / 只能述则述 / 该拒则拒
		can_execute = bool(
			execution.get("ok") and tq.get("confident") and table_complete
		)
		must_compute = bool(
			looks_like_numeric_table_query(question)
			and not looks_like_table_summary_lookup(question)
		)
		table_load = {
			"complete": table_complete,
			"reason": merged.get("reason"),
			"group_count": merged.get("group_count"),
			"load_source": merged.get("load_source"),
			"doc_id": merged.get("doc_id"),
			"table_id": merged.get("table_id"),
		}

		if can_execute:
			return {
				"table_query_plan": tq,
				"table_execution": execution,
				"citations": enriched,
				"downgrade_reason": None,
				"retrieval_debug": _with_table_stages(
					_merge_debug(
						state,
						table_query_plan=tq,
						table_execution=execution,
						table_load=table_load,
						downgrade_reason=None,
						precise_gate="execute",
					)
				),
			}

		# 必须算数但 store/plan 不行 → 拒答（禁止 LLM 估数）
		if must_compute and citations:
			library_name = _library_label(state.get("library_id"))
			judgement = {
				"sufficient": False,
				"action": "clarify",
				"reason": "table_unclear" if table_complete else "table_incomplete",
				"can_retry": False,
			}
			refuse_reason = "table_unclear" if table_complete else "table_incomplete"
			return {
				"table_query_plan": tq,
				"table_execution": execution,
				"citations": enriched,
				"answer": table_unclear_answer(library_name=library_name),
				"refused": True,
				"refuse_reason": refuse_reason,
				"judgement": judgement,
				"downgrade_reason": None,
				"retrieval_debug": _with_table_stages(
					_merge_debug(
						state,
						table_query_plan=tq,
						table_execution=execution,
						table_load=table_load,
						judgement=judgement,
						generate="table_unclear",
						refuse_reason=refuse_reason,
						precise_gate="refuse",
						downgrade_reason=None,
					)
				),
			}

		# 不需精确算 / plan 不自信但表证据够 → LLM 概述（summary + 有界行预览）
		has_overview_evidence = bool(
			(headers and (table_complete or any(
				str(c.get("record_type") or "") == "table_summary" for c in enriched
			)))
			or any(str(c.get("record_type") or "") == "table_summary" for c in enriched)
		)
		downgrade = table_overview_downgrade_reason(
			plan_confident=bool(tq.get("confident")),
			must_compute=must_compute,
			table_complete=table_complete,
		)
		if has_overview_evidence and downgrade:
			overview_citations = citations_for_table_overview(
				enriched,
				merged=merged,
			)
			return {
				"table_query_plan": tq,
				"table_execution": execution,
				"citations": overview_citations,
				"downgrade_reason": downgrade,
				"retrieval_debug": _with_table_stages(
					_merge_debug(
						state,
						table_query_plan=tq,
						table_execution=execution,
						table_load=table_load,
						downgrade_reason=downgrade,
						precise_gate="overview",
					)
				),
			}

		return {
			"table_query_plan": tq,
			"table_execution": execution,
			"citations": enriched,
			"downgrade_reason": None,
			"retrieval_debug": _with_table_stages(
				_merge_debug(
					state,
					table_query_plan=tq,
					table_execution=execution,
					table_load=table_load,
					precise_gate="fallback_llm",
				)
			),
		}
	def route_after_table_execute(
		state: AskState,
	) -> Literal["judge", "end"]:
		if state.get("refuse_reason") in {"table_unclear", "table_incomplete"}:
			return "end"
		return "judge"
	return SimpleNamespace(
		build_table_plan=build_table_plan_node,
		table_retrieve=table_retrieve_node,
		table_execute=table_execute_node,
		route_after_table_execute=route_after_table_execute,
	)
