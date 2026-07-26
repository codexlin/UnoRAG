"""Pydantic Phase 3：结构化 RetrievalPlan 校验 / 非法 key / 降级。"""

from __future__ import annotations

import json

from app.services.ingest.qdrant_payload import FILTER_PAYLOAD_FIELDS
from app.services.retrieval import filters_to_extra_must, hit_matches_plan_filters
from app.services.retrieval_plan_contract import (
	ALLOWED_PLAN_FILTER_KEYS,
	EXECUTABLE_PLAN_FILTER_KEYS,
	RetrievalPlan,
	merge_plan_filters,
	resolve_structured_retrieval_plan,
)


def test_allowed_keys_subset_of_phase1_and_executable() -> None:
	assert ALLOWED_PLAN_FILTER_KEYS <= FILTER_PAYLOAD_FIELDS
	assert ALLOWED_PLAN_FILTER_KEYS <= EXECUTABLE_PLAN_FILTER_KEYS
	assert "record_type" in ALLOWED_PLAN_FILTER_KEYS
	assert "doc_id" in ALLOWED_PLAN_FILTER_KEYS
	# 系统门禁字段不得由 LLM plan 覆盖
	assert "tenant_id" not in ALLOWED_PLAN_FILTER_KEYS
	assert "lifecycle_visibility" not in ALLOWED_PLAN_FILTER_KEYS
	assert "library_id" not in ALLOWED_PLAN_FILTER_KEYS


def test_legal_plan_validates_and_applies() -> None:
	raw = {
		"semantic_query": "病假证明补交期限",
		"filters": {
			"record_type": "chunk",
			"doc_id": "doc-hr",
			"table_id": None,
		},
	}
	result = resolve_structured_retrieval_plan(
		raw=raw,
		fallback_semantic_query="原问题",
		from_llm=True,
	)
	assert result.degraded is False
	assert result.degrade_reason is None
	assert result.plan.semantic_query == "病假证明补交期限"
	assert result.applied_filters == {
		"record_type": "chunk",
		"doc_id": "doc-hr",
	}
	assert result.stripped_filter_keys == []
	RetrievalPlan.model_validate(result.plan.model_dump())
	debug = result.debug_fields()
	assert debug["degraded"] is False
	assert debug["filters"]["doc_id"] == "doc-hr"


def test_illegal_filter_keys_are_stripped() -> None:
	raw = {
		"semantic_query": "考勤规则",
		"filters": {
			"record_type": "section",
			"tenant_id": "evil",
			"lifecycle_visibility": "staging",
			"library_id": "other-lib",
			"made_up_field": "x",
		},
	}
	result = resolve_structured_retrieval_plan(
		raw=raw,
		fallback_semantic_query="fallback",
		from_llm=True,
	)
	assert result.degraded is False
	assert result.applied_filters == {"record_type": "section"}
	assert set(result.stripped_filter_keys) == {
		"tenant_id",
		"lifecycle_visibility",
		"library_id",
		"made_up_field",
	}


def test_validation_failure_degrades_to_semantic() -> None:
	raw = {
		"semantic_query": "",  # 非法空查询
		"filters": {"record_type": "chunk"},
	}
	result = resolve_structured_retrieval_plan(
		raw=raw,
		fallback_semantic_query="改写后的问题",
		from_llm=True,
	)
	assert result.degraded is True
	assert result.degrade_reason == "validation_error"
	assert result.plan.semantic_query == "改写后的问题"
	assert result.applied_filters == {}


def test_invalid_record_type_degrades() -> None:
	raw = {
		"semantic_query": "表格问题",
		"filters": {"record_type": "not_a_real_type"},
	}
	result = resolve_structured_retrieval_plan(
		raw=raw,
		fallback_semantic_query="表格问题",
		from_llm=True,
	)
	assert result.degraded is True
	assert result.degrade_reason == "validation_error"
	assert result.applied_filters == {}


def test_llm_unavailable_degrades() -> None:
	result = resolve_structured_retrieval_plan(
		raw=None,
		fallback_semantic_query="历史改写 query",
		from_llm=False,
	)
	assert result.degraded is True
	assert result.degrade_reason == "llm_unavailable"
	assert result.plan.semantic_query == "历史改写 query"
	assert result.applied_filters == {}


def test_llm_error_degrades() -> None:
	result = resolve_structured_retrieval_plan(
		raw=None,
		fallback_semantic_query="q",
		from_llm=True,
		llm_error="timeout",
	)
	assert result.degraded is True
	assert result.degrade_reason == "llm_error:timeout"


def test_json_string_plan_parses() -> None:
	raw = json.dumps(
		{
			"semantic_query": "年假天数",
			"filters": {"document_version_id": "ver-1"},
		},
		ensure_ascii=False,
	)
	result = resolve_structured_retrieval_plan(
		raw=raw,
		fallback_semantic_query="fallback",
		from_llm=True,
	)
	assert result.degraded is False
	assert result.applied_filters == {"document_version_id": "ver-1"}


def test_merge_plan_filters_keeps_route_record_type() -> None:
	structured = resolve_structured_retrieval_plan(
		raw={
			"semantic_query": "第三节讲了什么",
			"filters": {"record_type": "chunk", "doc_id": "doc-a"},
		},
		fallback_semantic_query="第三节讲了什么",
		from_llm=True,
	)
	merged = merge_plan_filters(
		{"tenant_id": "default", "record_type": "section"},
		structured,
	)
	assert merged["record_type"] == "section"  # 路由优先
	assert merged["doc_id"] == "doc-a"
	assert merged["tenant_id"] == "default"


def test_filters_to_extra_must_builds_conditions() -> None:
	must = filters_to_extra_must(
		{"record_type": "chunk", "doc_id": "doc-1", "table_id": "t1"}
	)
	assert len(must) == 2
	keys = {getattr(c, "key", None) for c in must}
	assert keys == {"doc_id", "table_id"}


def test_hit_matches_plan_filters() -> None:
	hit = {"doc_id": "doc-1", "table_id": "t1", "document_version_id": "v1"}
	assert hit_matches_plan_filters(hit, {"doc_id": "doc-1"}) is True
	assert hit_matches_plan_filters(hit, {"doc_id": "other"}) is False
	assert hit_matches_plan_filters(hit, {"table_id": "t1", "document_version_id": "v1"})


def test_hit_matches_plan_filters_record_type() -> None:
	chunk = {"record_type": "chunk", "doc_id": "d1"}
	summary = {"record_type": "table_summary", "doc_id": "d1"}
	section = {"record_type": "section", "doc_id": "d1"}
	legacy = {"doc_id": "d1"}  # 无 record_type → 视为 chunk

	assert hit_matches_plan_filters(chunk, {"record_type": "chunk"}) is True
	assert hit_matches_plan_filters(section, {"record_type": "chunk"}) is False
	assert hit_matches_plan_filters(legacy, {"record_type": "chunk"}) is True

	pseudo = {"record_type": "chunk+table_summary"}
	assert hit_matches_plan_filters(chunk, pseudo) is True
	assert hit_matches_plan_filters(summary, pseudo) is True
	assert hit_matches_plan_filters(section, pseudo) is False
	assert hit_matches_plan_filters(legacy, pseudo) is True
	assert hit_matches_plan_filters(
		chunk, {"record_type": "chunk+table_summary", "doc_id": "other"}
	) is False
