"""Qdrant IndexRecord payload 强类型契约（Pydantic Phase 1）。

DocumentIR 仍是解析账本；**入库与混合检索过滤以本模块字段为准**。

分层：
- ``IndexWritePayload``：chunk 管道 / ``index_record_to_payload`` 产出的写入前 dict
  （含 ``embed_text``、``_point_id`` 等传输字段，不落库）
- ``QdrantIndexPayload``：真正 upsert 进 Qdrant 的 payload（``extra=forbid``）
- ``QdrantIndexPayloadRead``：读路径兼容旧点（``extra=ignore`` + 更多 optional）

写入失败 fail-closed：校验错误转为 ``ValueError``（lifecycle worker 归类为
``invalid_document``，不重试吞掉）。
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

logger = logging.getLogger(__name__)

# 与 index_record.RecordType 对齐（避免循环 import）
RecordType = Literal["chunk", "section", "document", "table", "table_summary"]
LifecycleVisibility = Literal["staging", "active", "inactive"]
AclScopeValue = Literal["workspace", "restricted"]

# 混合检索 / ACL / generation 门禁实际用到的 filter 键（写入必须类型正确）
FILTER_PAYLOAD_FIELDS: frozenset[str] = frozenset(
	{
		"tenant_id",
		"workspace_id",
		"library_id",
		"doc_id",
		"generation_id",
		"lifecycle_visibility",
		"acl_scope",
		"acl_principal_ids",
		"acl_group_ids",
		"record_type",
		"document_version_id",
		"table_id",
	}
)

# upsert 时从 chunk dict 拷贝的可选内容键（与历史索引对齐；未列出的键不得入库）
QDRANT_OPTIONAL_CONTENT_FIELDS: frozenset[str] = frozenset(
	{
		"body",
		"preamble",
		"section_path",
		"heading_text",
		"page",
		"page_start",
		"page_end",
		"table_id",
		"figure_id",
		"node_ids",
		"split_strategy",
		"chunk_policy_version",
		"chunk_profile",
		"split_reason",
		"target_chars",
		"max_chars",
		"table_rows_per_record",
		"table_tokens_per_record",
		"semantic_distance_threshold",
		"semantic_unit_count",
		"semantic_fallback",
		"source_format",
		"content_hash",
		"document_version_id",
		"generation_id",
		"lifecycle_visibility",
		"tenant_id",
		"workspace_id",
		"acl_scope",
		"acl_principal_ids",
		"acl_group_ids",
		"record_type",
		"record_id",
		"parent_record_id",
		"source_chunk_ids",
		"source_node_ids",
		"headers",
		"rows",
		"row_start",
		"row_end",
		"table_row_count",
		"table_caption",
		"table_quality",
		"summary_rows",
		"footnotes",
		"header_rows",
		"table_columns",
		"cell_rows",
		"filename",
		"deactivated_at",
	}
)

# 稳定排序列表，供 upsert 遍历（行为对齐原 _optional_keys 元组）
QDRANT_OPTIONAL_PAYLOAD_KEYS: tuple[str, ...] = (
	"body",
	"preamble",
	"section_path",
	"heading_text",
	"page",
	"page_start",
	"page_end",
	"table_id",
	"figure_id",
	"node_ids",
	"split_strategy",
	"chunk_policy_version",
	"chunk_profile",
	"split_reason",
	"target_chars",
	"max_chars",
	"table_rows_per_record",
	"table_tokens_per_record",
	"semantic_distance_threshold",
	"semantic_unit_count",
	"semantic_fallback",
	"source_format",
	"content_hash",
	"document_version_id",
	"generation_id",
	"lifecycle_visibility",
	"tenant_id",
	"workspace_id",
	"acl_scope",
	"acl_principal_ids",
	"acl_group_ids",
	"record_type",
	"record_id",
	"parent_record_id",
	"source_chunk_ids",
	"source_node_ids",
	"headers",
	"rows",
	"row_start",
	"row_end",
	"table_row_count",
	"table_caption",
	"table_quality",
	"summary_rows",
	"footnotes",
	"header_rows",
	"table_columns",
	"cell_rows",
)


def _non_empty_str(value: str) -> str:
	text = value.strip()
	if not text:
		raise ValueError("must be a non-empty string")
	return text


class IndexWritePayload(BaseModel):
	"""管道侧写入前契约：允许传输字段；禁止未知顶层键。"""

	model_config = ConfigDict(extra="forbid", populate_by_name=True)

	chunk_index: int
	text: str
	body: str | None = None
	embed_text: str | None = None
	record_type: RecordType = "chunk"
	record_id: str
	document_version_id: str
	tenant_id: str | None = None
	workspace_id: str | None = None
	point_id: str | None = Field(default=None, alias="_point_id")

	preamble: str | None = None
	section_path: str | None = None
	heading_text: str | None = None
	page: str | None = None
	page_start: int | None = None
	page_end: int | None = None
	table_id: str | None = None
	figure_id: str | None = None
	node_ids: list[str] | None = None
	split_strategy: str | None = None
	chunk_policy_version: str | None = None
	chunk_profile: str | None = None
	split_reason: str | None = None
	target_chars: int | None = None
	max_chars: int | None = None
	table_rows_per_record: int | None = None
	table_tokens_per_record: int | None = None
	semantic_distance_threshold: float | None = None
	semantic_unit_count: int | None = None
	# 历史兼容：可能是 bool 或异常类型名字符串
	semantic_fallback: bool | str | None = None
	source_format: str | None = None
	content_hash: str | None = None
	generation_id: str | None = None
	lifecycle_visibility: LifecycleVisibility | None = None
	parent_record_id: str | None = None
	source_chunk_ids: list[str] | None = None
	source_node_ids: list[str] | None = None
	headers: list[str] | None = None
	rows: list[list[str]] | None = None
	row_start: int | None = None
	row_end: int | None = None
	table_row_count: int | None = None
	table_caption: str | None = None
	table_quality: dict[str, Any] | None = None
	summary_rows: list[Any] | None = None
	footnotes: list[str] | None = None
	header_rows: list[list[str]] | None = None
	table_columns: list[dict[str, Any]] | None = None
	cell_rows: list[dict[str, Any]] | None = None
	filename: str | None = None

	@field_validator("record_id", "document_version_id", mode="before")
	@classmethod
	def _require_ids(cls, value: Any) -> str:
		if value is None:
			raise ValueError("must be a non-empty string")
		return _non_empty_str(str(value))

	@field_validator("text", mode="before")
	@classmethod
	def _coerce_text(cls, value: Any) -> str:
		return "" if value is None else str(value)


class QdrantIndexPayload(BaseModel):
	"""落库 payload：filter + 允许的内容字段；未知键拒绝。"""

	model_config = ConfigDict(extra="forbid")

	library_id: str
	doc_id: str
	title: str
	chunk_index: int
	text: str
	document_version_id: str
	record_type: RecordType = "chunk"
	tenant_id: str
	workspace_id: str

	body: str | None = None
	preamble: str | None = None
	section_path: str | None = None
	heading_text: str | None = None
	page: str | None = None
	page_start: int | None = None
	page_end: int | None = None
	table_id: str | None = None
	figure_id: str | None = None
	node_ids: list[str] | None = None
	split_strategy: str | None = None
	chunk_policy_version: str | None = None
	chunk_profile: str | None = None
	split_reason: str | None = None
	target_chars: int | None = None
	max_chars: int | None = None
	table_rows_per_record: int | None = None
	table_tokens_per_record: int | None = None
	semantic_distance_threshold: float | None = None
	semantic_unit_count: int | None = None
	semantic_fallback: bool | str | None = None
	source_format: str | None = None
	content_hash: str | None = None
	generation_id: str | None = None
	lifecycle_visibility: LifecycleVisibility | None = None
	acl_scope: AclScopeValue | None = None
	acl_principal_ids: list[str] | None = None
	acl_group_ids: list[str] | None = None
	record_id: str | None = None
	parent_record_id: str | None = None
	source_chunk_ids: list[str] | None = None
	source_node_ids: list[str] | None = None
	headers: list[str] | None = None
	rows: list[list[str]] | None = None
	row_start: int | None = None
	row_end: int | None = None
	table_row_count: int | None = None
	table_caption: str | None = None
	table_quality: dict[str, Any] | None = None
	summary_rows: list[Any] | None = None
	footnotes: list[str] | None = None
	header_rows: list[list[str]] | None = None
	table_columns: list[dict[str, Any]] | None = None
	cell_rows: list[dict[str, Any]] | None = None
	filename: str | None = None
	# set_generation_visibility(inactive) 写入；upsert 路径通常无
	deactivated_at: str | None = None

	@field_validator(
		"library_id",
		"doc_id",
		"title",
		"document_version_id",
		"tenant_id",
		"workspace_id",
		mode="before",
	)
	@classmethod
	def _require_scope_ids(cls, value: Any) -> str:
		if value is None:
			raise ValueError("must be a non-empty string")
		return _non_empty_str(str(value))

	@field_validator("text", mode="before")
	@classmethod
	def _coerce_text(cls, value: Any) -> str:
		return "" if value is None else str(value)


class QdrantIndexPayloadRead(BaseModel):
	"""读路径：忽略历史未知键；字段全 optional，避免未 backfill 旧点被拒。"""

	model_config = ConfigDict(extra="ignore")

	library_id: str | None = None
	doc_id: str | None = None
	title: str | None = None
	chunk_index: int | None = None
	text: str | None = None
	body: str | None = None
	document_version_id: str | None = None
	record_type: RecordType | None = None
	tenant_id: str | None = None
	workspace_id: str | None = None
	preamble: str | None = None
	section_path: str | None = None
	heading_text: str | None = None
	page: str | int | None = None
	page_start: int | None = None
	page_end: int | None = None
	table_id: str | None = None
	figure_id: str | None = None
	node_ids: list[str] | None = None
	split_strategy: str | None = None
	chunk_policy_version: str | None = None
	chunk_profile: str | None = None
	split_reason: str | None = None
	target_chars: int | None = None
	max_chars: int | None = None
	table_rows_per_record: int | None = None
	table_tokens_per_record: int | None = None
	semantic_distance_threshold: float | None = None
	semantic_unit_count: int | None = None
	semantic_fallback: bool | str | None = None
	source_format: str | None = None
	content_hash: str | None = None
	generation_id: str | None = None
	lifecycle_visibility: LifecycleVisibility | None = None
	acl_scope: AclScopeValue | None = None
	acl_principal_ids: list[str] | None = None
	acl_group_ids: list[str] | None = None
	record_id: str | None = None
	parent_record_id: str | None = None
	source_chunk_ids: list[str] | None = None
	source_node_ids: list[str] | None = None
	headers: list[str] | None = None
	rows: list[list[str]] | None = None
	row_start: int | None = None
	row_end: int | None = None
	table_row_count: int | None = None
	table_caption: str | None = None
	table_quality: dict[str, Any] | None = None
	summary_rows: list[Any] | None = None
	footnotes: list[str] | None = None
	header_rows: list[list[str]] | None = None
	table_columns: list[dict[str, Any]] | None = None
	cell_rows: list[dict[str, Any]] | None = None
	filename: str | None = None
	deactivated_at: str | None = None


def validate_index_write_payload(data: dict[str, Any]) -> dict[str, Any]:
	"""校验管道侧 payload；失败 raise ValueError（fail-closed）。"""
	try:
		model = IndexWritePayload.model_validate(data)
	except ValidationError as exc:
		logger.error(
			"index.write_payload_invalid record_id=%s errors=%s",
			data.get("record_id"),
			exc.error_count(),
		)
		raise ValueError(f"invalid index write payload: {exc}") from exc
	return model.model_dump(by_alias=True, exclude_none=True)


def validate_payload_for_upsert(data: dict[str, Any]) -> dict[str, Any]:
	"""校验即将写入 Qdrant 的 payload；失败 raise ValueError（fail-closed）。"""
	try:
		model = QdrantIndexPayload.model_validate(data)
	except ValidationError as exc:
		logger.error(
			"qdrant.payload_invalid doc_id=%s record_id=%s errors=%s",
			data.get("doc_id"),
			data.get("record_id"),
			exc.error_count(),
		)
		raise ValueError(f"invalid Qdrant index payload: {exc}") from exc
	return model.model_dump(exclude_none=True)


def parse_stored_payload(data: dict[str, Any]) -> QdrantIndexPayloadRead | None:
	"""读路径解析；脏/残缺旧点返回 None（由调用方回退原始 dict，不阻断检索）。"""
	try:
		return QdrantIndexPayloadRead.model_validate(data)
	except ValidationError as exc:
		logger.warning(
			"qdrant.payload_read_compat_failed doc_id=%s errors=%s",
			data.get("doc_id"),
			exc.error_count(),
		)
		return None
