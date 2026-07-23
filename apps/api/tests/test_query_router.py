"""QueryRouter / RetrievalPlan / archive 字段 Phase 1 单测。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.services.query_router import classify_query
from app.services.retrieval_plan import build_retrieval_plan
from app.services.versioning import derive_document_version_id
from tests.conftest import create_library

client = TestClient(app)


def test_classify_query_rules() -> None:
	assert classify_query("病假几天内补交？")[0] == "fact"
	assert classify_query("总结本库的报销规则")[0] == "summary"
	assert classify_query("表格里供应商报价")[0] == "table"
	assert classify_query("A 和 B 区别？")[0] == "compare"
	assert classify_query("？")[0] == "ambiguous"
	assert (
		classify_query(
			"那逾期呢？",
			history=[{"role": "user", "content": "病假几天补交？"}],
		)[0]
		== "follow_up"
	)
	assert (
		classify_query(
			"公司的差旅报销额度是多少？",
			history=[{"role": "user", "content": "病假几天补交？"}],
		)[0]
		== "fact"
	)


def test_retrieval_plan_phase1_paths() -> None:
	fact = build_retrieval_plan(
		query_type="fact",
		route_reason="default_fact",
		library_id="lib-1",
		top_k=6,
		hybrid_enabled=False,
		rerank_enabled=False,
	)
	assert fact["execute_path"] == "short"
	summary = build_retrieval_plan(
		query_type="summary",
		route_reason="summary_keyword",
		library_id="lib-1",
		top_k=6,
		hybrid_enabled=True,
		rerank_enabled=True,
	)
	assert summary["execute_path"] == "short"
	assert summary["query_type"] == "summary"
	assert summary["top_k"] == 6
	assert "phase1_record_only" in summary["reason"]
	amb = build_retrieval_plan(
		query_type="ambiguous",
		route_reason="too_short",
		library_id="lib-1",
		top_k=6,
		hybrid_enabled=False,
		rerank_enabled=False,
	)
	assert amb["execute_path"] == "clarify"


def test_document_version_stub() -> None:
	assert derive_document_version_id("doc-1") == "doc-1:v1"
	assert derive_document_version_id("doc-1", content_hash="abcdef1234567890").endswith(
		"abcdef123456"
	)


def test_ask_writes_query_type_and_judge_to_archive() -> None:
	lib_id = create_library(client, library_id="lib-router-archive")
	question = "病假需要在几天内补交证明？"
	ask = client.post(
		"/v1/ask",
		json={"question": question, "library_id": lib_id},
	)
	assert ask.status_code == 200
	body = ask.json()
	assert body["retrieval_debug"]["query_type"] == "fact"
	assert body["retrieval_debug"]["judgement"]["reason"] == "ok"
	assert body["retrieval_debug"]["retrieval_plan"]["execute_path"] == "short"

	archive = client.get("/v1/archive", params={"library_id": lib_id, "limit": 5})
	assert archive.status_code == 200
	rows = archive.json()
	assert rows
	row = rows[0]
	assert row["query_type"] == "fact"
	assert isinstance(row["judge"], dict)
	assert row["judge"]["reason"] == "ok"
	assert isinstance(row["retrieval_plan"], dict)
	assert row["rewrite"] == "passthrough"
	assert row["rewritten_query"] == question


def test_ask_ambiguous_clarifies_without_breaking_schema() -> None:
	lib_id = create_library(client, library_id="lib-router-ambiguous")
	ask = client.post("/v1/ask", json={"question": "？", "library_id": lib_id})
	assert ask.status_code == 200
	body = ask.json()
	assert body["refused"] is True
	assert body["refuse_reason"] == "ambiguous"
	assert "session_id" in body
	assert "citations" in body
	assert body["retrieval_debug"]["query_type"] == "ambiguous"
