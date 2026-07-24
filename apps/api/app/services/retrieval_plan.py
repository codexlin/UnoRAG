"""RetrievalPlan — path=fast|precise；表格精路径 precise_kind=table。"""

from __future__ import annotations

from typing import Any, Literal

from app.services.query_router import QueryType

# 兼容旧字段：short / section_short / table / clarify
ExecutePath = Literal["short", "clarify", "section_short", "table"]
RetrievalPath = Literal["fast", "precise", "clarify"]
PreciseKind = Literal["table"]


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
	"""按 query_type 生成 plan；强制 filters.record_type；写入 path / precise_kind。"""
	qt = str(query_type or "fact")
	mode = "hybrid" if hybrid_enabled else "dense"

	# fact/follow_up/compare → fast（chunk + 可读 table_summary）
	# summary/section_lookup → fast + section
	# table → precise / precise_kind=table
	# ambiguous → clarify
	precise_kind: PreciseKind | None = None
	if qt == "ambiguous":
		path: RetrievalPath = "clarify"
		execute_path: ExecutePath = "clarify"
		record_type: str | None = "chunk"
		route = "clarify"
		reason = f"ambiguous:{route_reason};phase1_clarify"
	elif qt in {"summary", "section_lookup"}:
		path = "fast"
		execute_path = "section_short"
		record_type = "section"
		route = "fast_section"
		reason = f"{qt}:{route_reason};section_retrieval"
	elif qt == "table":
		path = "precise"
		precise_kind = "table"
		execute_path = "table"
		record_type = "table"
		route = "precise_table"
		reason = f"table:{route_reason};precise_table"
	elif qt == "compare":
		path = "fast"
		execute_path = "short"
		record_type = "chunk+table_summary"
		route = "fast"
		reason = f"compare:{route_reason};fast_unified"
	elif qt == "follow_up":
		path = "fast"
		execute_path = "short"
		record_type = "chunk+table_summary"
		route = "fast"
		reason = f"follow_up:{route_reason};fast_unified"
	else:
		path = "fast"
		execute_path = "short"
		record_type = "chunk+table_summary"
		route = "fast"
		reason = f"fact:{route_reason};fast_unified"

	plan_top_k = int(top_k)
	# section 总结略抬 top_k
	if qt in {"summary", "section_lookup"} and plan_top_k < 8:
		plan_top_k = 8
	# table 略抬以便合并多分片 row group
	if qt == "table" and plan_top_k < 8:
		plan_top_k = 8

	filters: dict[str, Any] = {
		"tenant_id": tenant_id,
		"workspace_id": workspace_id,
	}
	# unified fast：retrieve 节点双路；filters 不写死单一 record_type
	if record_type and record_type != "chunk+table_summary":
		filters["record_type"] = record_type
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
		"path": path,
		"precise_kind": precise_kind,
		"route": route,
		"execute_path": execute_path,
		"rewritten_queries": [question.strip()] if question and question.strip() else [],
		"evidence_policy": (
			"multi_source"
			if qt in {"summary", "compare", "section_lookup", "table"}
			else "top_chunk"
		),
	}
	return plan
