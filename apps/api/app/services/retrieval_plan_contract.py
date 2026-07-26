"""Ask 结构化 RetrievalPlan 契约（Pydantic Phase 3）。

提问 → JSON → ``RetrievalPlan.model_validate``；用于语义检索 + 元数据过滤。

策略（fail-safe，与 Phase 2 citation_reconcile / 现网 ask 一致：不因坏 plan 整答 500）：
- LLM JSON / 草稿 dict → 剥离非法 filter key → ``model_validate``
- 校验失败或 LLM 不可用 → 降级为纯语义（fallback semantic_query，无额外 filter）
- 可执行 filter key ⊆ Phase 1 ``FILTER_PAYLOAD_FIELDS`` ∩ 现网 retrieve 已接线字段
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from app.services.ingest.qdrant_payload import FILTER_PAYLOAD_FIELDS

logger = logging.getLogger(__name__)

# 现网 retrieve / Qdrant search 能真正 assembles 进 query filter 的计划字段
# （library_id 由 ask 入参强制；tenant/workspace/lifecycle/generation/acl 由门禁组装，不接受 LLM 覆盖）
EXECUTABLE_PLAN_FILTER_KEYS: frozenset[str] = frozenset(
	{
		"record_type",
		"doc_id",
		"table_id",
		"document_version_id",
	}
)

# 契约允许出现在 filters 里的 key：必须 ⊆ Phase 1 ∩ 可执行集
ALLOWED_PLAN_FILTER_KEYS: frozenset[str] = (
	EXECUTABLE_PLAN_FILTER_KEYS & FILTER_PAYLOAD_FIELDS
)

RecordTypeFilter = Literal[
	"chunk",
	"section",
	"document",
	"table",
	"table_summary",
	"chunk+table_summary",
]

_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


class RetrievalFilters(BaseModel):
	"""元数据过滤；仅允许 retrieve 已支持的 Phase 1 filter key。"""

	model_config = ConfigDict(extra="forbid")

	record_type: RecordTypeFilter | None = None
	doc_id: str | None = None
	table_id: str | None = None
	document_version_id: str | None = None

	@field_validator("doc_id", "table_id", "document_version_id", mode="before")
	@classmethod
	def _blank_to_none(cls, value: Any) -> str | None:
		if value is None:
			return None
		text = str(value).strip()
		return text or None


class RetrievalPlan(BaseModel):
	"""提问 → 混合检索计划：语义查询 + 可选元数据过滤。"""

	model_config = ConfigDict(extra="forbid")

	semantic_query: str = Field(min_length=1)
	filters: RetrievalFilters = Field(default_factory=RetrievalFilters)

	@field_validator("semantic_query", mode="before")
	@classmethod
	def _strip_query(cls, value: Any) -> str:
		text = str(value or "").strip()
		if not text:
			raise ValueError("semantic_query must be non-empty")
		return text


@dataclass(slots=True)
class RetrievalPlanResolveResult:
	plan: RetrievalPlan
	degraded: bool = False
	degrade_reason: str | None = None
	from_llm: bool = False
	stripped_filter_keys: list[str] = field(default_factory=list)
	applied_filters: dict[str, Any] = field(default_factory=dict)
	# 契约校验通过但不进 Qdrant 的键（本阶段应为空；预留给系统门禁字段）
	validated_not_executed: dict[str, Any] = field(default_factory=dict)

	def debug_fields(self) -> dict[str, Any]:
		return {
			"degraded": self.degraded,
			"degrade_reason": self.degrade_reason,
			"from_llm": self.from_llm,
			"semantic_query": self.plan.semantic_query,
			"filters": dict(self.applied_filters),
			"stripped_filter_keys": list(self.stripped_filter_keys),
			"validated_not_executed": dict(self.validated_not_executed),
			"executable_filter_keys": sorted(EXECUTABLE_PLAN_FILTER_KEYS),
		}


def _degraded_plan(
	*,
	fallback_semantic_query: str,
	reason: str,
	from_llm: bool = False,
	stripped: list[str] | None = None,
) -> RetrievalPlanResolveResult:
	query = (fallback_semantic_query or "").strip() or " "
	plan = RetrievalPlan(semantic_query=query, filters=RetrievalFilters())
	return RetrievalPlanResolveResult(
		plan=plan,
		degraded=True,
		degrade_reason=reason,
		from_llm=from_llm,
		stripped_filter_keys=list(stripped or []),
		applied_filters={},
		validated_not_executed={},
	)


def try_parse_retrieval_plan_raw(raw: str | dict[str, Any] | None) -> dict[str, Any] | None:
	"""从 LLM 文本或 dict 提取 plan 草稿；失败返回 None（不抛）。"""
	if raw is None:
		return None
	if isinstance(raw, dict):
		return dict(raw)
	text = str(raw).strip()
	if not text:
		return None
	# 允许 ```json ... ``` 包裹
	if text.startswith("```"):
		lines = text.split("\n")
		inner = "\n".join(
			line for line in lines if not line.strip().startswith("```")
		).strip()
		text = inner or text
	try:
		parsed = json.loads(text)
		if isinstance(parsed, dict):
			return parsed
	except json.JSONDecodeError:
		pass
	match = _JSON_BLOCK.search(text)
	if not match:
		return None
	try:
		parsed = json.loads(match.group(0))
	except json.JSONDecodeError:
		return None
	return parsed if isinstance(parsed, dict) else None


def _strip_unknown_filter_keys(
	filters: dict[str, Any] | None,
) -> tuple[dict[str, Any], list[str]]:
	"""剥离非法 filter key；合法键保留原值供后续 model_validate。"""
	if not filters:
		return {}, []
	if not isinstance(filters, dict):
		return {}, ["<filters_not_object>"]
	kept: dict[str, Any] = {}
	stripped: list[str] = []
	for key, value in filters.items():
		name = str(key)
		if name in ALLOWED_PLAN_FILTER_KEYS:
			kept[name] = value
		else:
			stripped.append(name)
	return kept, stripped


def applied_filters_from_plan(plan: RetrievalPlan) -> dict[str, Any]:
	"""导出非空、可执行的 filter dict（供 retrieve / debug）。"""
	data = plan.filters.model_dump(exclude_none=True)
	return {
		key: value
		for key, value in data.items()
		if key in EXECUTABLE_PLAN_FILTER_KEYS and value is not None
	}


def resolve_structured_retrieval_plan(
	*,
	raw: str | dict[str, Any] | None,
	fallback_semantic_query: str,
	from_llm: bool = False,
	llm_error: str | None = None,
) -> RetrievalPlanResolveResult:
	"""校验并对齐结构化检索计划；失败则纯语义降级。"""
	if llm_error and raw is None:
		return _degraded_plan(
			fallback_semantic_query=fallback_semantic_query,
			reason=f"llm_error:{llm_error}",
			from_llm=True,
		)
	if raw is None:
		return _degraded_plan(
			fallback_semantic_query=fallback_semantic_query,
			reason="llm_unavailable" if not from_llm else "empty_llm_output",
			from_llm=from_llm,
		)

	draft = try_parse_retrieval_plan_raw(raw)
	if draft is None:
		return _degraded_plan(
			fallback_semantic_query=fallback_semantic_query,
			reason="invalid_json",
			from_llm=from_llm,
		)

	filters_raw = draft.get("filters")
	cleaned_filters, stripped = _strip_unknown_filter_keys(
		filters_raw if isinstance(filters_raw, dict) else None
	)
	if filters_raw is not None and not isinstance(filters_raw, dict):
		return _degraded_plan(
			fallback_semantic_query=fallback_semantic_query,
			reason="filters_not_object",
			from_llm=from_llm,
			stripped=stripped,
		)

	payload = {
		"semantic_query": draft.get("semantic_query"),
		"filters": cleaned_filters,
	}
	try:
		plan = RetrievalPlan.model_validate(payload)
	except ValidationError as exc:
		logger.warning(
			"retrieval_plan.validate_failed errors=%s from_llm=%s",
			exc.error_count(),
			from_llm,
		)
		return _degraded_plan(
			fallback_semantic_query=fallback_semantic_query,
			reason="validation_error",
			from_llm=from_llm,
			stripped=stripped,
		)

	applied = applied_filters_from_plan(plan)
	if stripped:
		logger.info(
			"retrieval_plan.stripped_keys keys=%s from_llm=%s",
			stripped,
			from_llm,
		)
	return RetrievalPlanResolveResult(
		plan=plan,
		degraded=False,
		degrade_reason=None,
		from_llm=from_llm,
		stripped_filter_keys=stripped,
		applied_filters=applied,
		validated_not_executed={},
	)


def merge_plan_filters(
	route_filters: dict[str, Any] | None,
	structured: RetrievalPlanResolveResult,
) -> dict[str, Any]:
	"""合并路由 plan filters 与结构化 plan；不覆盖系统作用域字段。"""
	merged = dict(route_filters or {})
	if structured.degraded:
		return merged
	applied = structured.applied_filters
	# record_type：路由已指定时保留路由（section/table 路径一致性）
	for key, value in applied.items():
		if key == "record_type" and merged.get("record_type"):
			continue
		merged[key] = value
	return merged


RETRIEVAL_PLAN_SYSTEM_PROMPT = (
	"你是检索计划助手。根据用户问题输出**仅 JSON**（不要 markdown），形状为："
	'{"semantic_query":"...","filters":{...}}。'
	"semantic_query 可对原问做检索友好改写；无把握则原样。"
	"filters 只允许这些键（没有就省略）：record_type, doc_id, table_id, document_version_id。"
	"record_type 仅可为：chunk, section, document, table, table_summary, chunk+table_summary。"
	"不要编造 doc_id/table_id；不确定时不要写 filters。"
	"不要输出 tenant_id/workspace_id/library_id/lifecycle/generation/acl 等系统字段。"
)


def build_retrieval_plan_messages(
	*,
	question: str,
	fallback_semantic_query: str,
) -> list[dict[str, str]]:
	return [
		{"role": "system", "content": RETRIEVAL_PLAN_SYSTEM_PROMPT},
		{
			"role": "user",
			"content": (
				f"原问题：{question.strip()}\n"
				f"已有改写（可参考）：{fallback_semantic_query.strip()}\n"
				"请输出 JSON。"
			),
		},
	]
