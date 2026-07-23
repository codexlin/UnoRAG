"""RetrievalPlan — Phase 2A：plan.filters.record_type 真正驱动检索粒度。"""

from __future__ import annotations

from typing import Any, Literal

from app.services.query_router import QueryType

ExecutePath = Literal["short", "clarify", "section_short"]


def build_retrieval_plan(
	*,
	query_type: QueryType | str,
	route_reason: str,
	library_id: str | None,
	top_k: int,
	hybrid_enabled: bool,
	rerank_enabled: bool,
	tenant_id: str = "default",
	workspace_id: str = "default",
	question: str | None = None,
) -> dict[str, Any]:
	"""按 query_type 生成 plan；fact 查 chunk，summary/section_lookup 查 section。"""
	qt = str(query_type or "fact")
	mode = "hybrid" if hybrid_enabled else "dense"

	# Phase 2A：fact/follow_up → chunk；summary/section_lookup → section；
	# table/compare 仍走 chunk 短路径（不做 table agent）；ambiguous → clarify
	if qt == "ambiguous":
		execute_path: ExecutePath = "clarify"
		record_type = "chunk"
		reason = f"ambiguous:{route_reason};phase1_clarify"
	elif qt in {"summary", "section_lookup"}:
		execute_path = "section_short"
		record_type = "section"
		reason = f"{qt}:{route_reason};section_retrieval"
	elif qt in {"table", "compare"}:
		execute_path = "short"
		record_type = "chunk"
		reason = f"{qt}:{route_reason};phase1_record_only_chunk_path"
	elif qt == "follow_up":
		execute_path = "short"
		record_type = "chunk"
		reason = f"follow_up:{route_reason};short_path"
	else:
		execute_path = "short"
		record_type = "chunk"
		reason = f"fact:{route_reason};short_path"

	plan_top_k = int(top_k)
	# section 总结略抬 top_k，仍由 plan 控制（与 Phase1「非 fact 不抬」不同：此处真正改执行）
	if qt in {"summary", "section_lookup"} and plan_top_k < 8:
		plan_top_k = 8

	filters: dict[str, Any] = {
		"tenant_id": tenant_id,
		"workspace_id": workspace_id,
		"record_type": record_type,
	}
	if library_id:
		filters["library_id"] = library_id

	plan: dict[str, Any] = {
		"query_type": qt,
		"mode": mode,
		"top_k": plan_top_k,
		"hybrid": bool(hybrid_enabled),
		"rerank": bool(rerank_enabled),
		"filters": filters,
		"record_type": record_type,
		"reason": reason,
		"execute_path": execute_path,
		"rewritten_queries": [question.strip()] if question and question.strip() else [],
		"evidence_policy": "multi_source" if qt in {"summary", "compare", "section_lookup"} else "top_chunk",
	}
	return plan
