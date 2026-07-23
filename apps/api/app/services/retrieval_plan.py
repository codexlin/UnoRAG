"""RetrievalPlan — Phase 1：结构化召回策略描述（状态 / debug，不拆复杂 retriever）。"""

from __future__ import annotations

from typing import Any, Literal

from app.services.query_router import QueryType

ExecutePath = Literal["short", "clarify"]


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
	"""按 query_type 生成 plan；非 fact 类型 Phase 1 仅记录，执行仍 short 或 clarify。"""
	qt = str(query_type or "fact")
	mode = "hybrid" if hybrid_enabled else "dense"

	# Phase 1 契约：fact / follow_up → short；ambiguous → clarify；其余只记 plan，执行仍 short
	if qt == "ambiguous":
		execute_path: ExecutePath = "clarify"
		reason = f"ambiguous:{route_reason};phase1_clarify"
	elif qt in {"summary", "compare", "table"}:
		execute_path = "short"
		reason = f"{qt}:{route_reason};phase1_record_only_no_subgraph"
	elif qt == "follow_up":
		execute_path = "short"
		reason = f"follow_up:{route_reason};short_path"
	else:
		execute_path = "short"
		reason = f"fact:{route_reason};short_path"

	# Phase 1 的非 fact plan 只记录，不改变现有短路径执行参数。
	# query_type 驱动 top_k / 多路召回要等 retrieval eval 建立后再启用。
	plan_top_k = int(top_k)

	filters: dict[str, Any] = {
		"tenant_id": tenant_id,
		"workspace_id": workspace_id,
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
		"reason": reason,
		"execute_path": execute_path,
		"rewritten_queries": [question.strip()] if question and question.strip() else [],
		"evidence_policy": "multi_source" if qt in {"summary", "compare"} else "top_chunk",
	}
	return plan
