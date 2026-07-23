"""QueryRouter / RetrievalPlan / archive 字段 Phase 1+2A 单测。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.services.ingest.index_record import build_section_records_from_chunks, chunk_record_id
from app.services.ingest.ir import Chunk, SplitStrategy
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
	assert classify_query("第3章讲什么？")[0] == "section_lookup"
	assert classify_query("请假制度这一节有哪些规定？")[0] == "section_lookup"
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


def test_retrieval_plan_phase2a_record_types() -> None:
	fact = build_retrieval_plan(
		query_type="fact",
		route_reason="default_fact",
		library_id="lib-1",
		top_k=6,
		hybrid_enabled=False,
		rerank_enabled=False,
	)
	assert fact["execute_path"] == "short"
	assert fact["record_type"] == "chunk"
	assert fact["filters"]["record_type"] == "chunk"

	summary = build_retrieval_plan(
		query_type="summary",
		route_reason="summary_keyword",
		library_id="lib-1",
		top_k=6,
		hybrid_enabled=True,
		rerank_enabled=True,
	)
	assert summary["execute_path"] == "section_short"
	assert summary["record_type"] == "section"
	assert summary["filters"]["record_type"] == "section"
	assert summary["top_k"] >= 8
	assert "section_retrieval" in summary["reason"]

	section = build_retrieval_plan(
		query_type="section_lookup",
		route_reason="section_lookup_pattern",
		library_id="lib-1",
		top_k=6,
		hybrid_enabled=False,
		rerank_enabled=False,
	)
	assert section["execute_path"] == "section_short"
	assert section["record_type"] == "section"

	amb = build_retrieval_plan(
		query_type="ambiguous",
		route_reason="too_short",
		library_id="lib-1",
		top_k=6,
		hybrid_enabled=False,
		rerank_enabled=False,
	)
	assert amb["execute_path"] == "clarify"


def test_section_records_aggregate_and_deterministic_ids() -> None:
	chunks = [
		Chunk(
			chunk_index=0,
			text="a",
			body="病假须于返岗后三个工作日内补交。",
			section_path="第3章 请假制度",
			heading_text="请假制度",
			split_strategy=SplitStrategy.HEADING,
		),
		Chunk(
			chunk_index=1,
			text="b",
			body="年假不扣薪。",
			section_path="第3章 请假制度",
			heading_text="请假制度",
			split_strategy=SplitStrategy.HEADING,
		),
		Chunk(
			chunk_index=2,
			text="c",
			body="薪酬按月发放。",
			section_path="第4章 薪酬福利",
			heading_text="薪酬福利",
			split_strategy=SplitStrategy.HEADING,
		),
	]
	first = build_section_records_from_chunks(chunks, doc_id="doc-a")
	second = build_section_records_from_chunks(chunks, doc_id="doc-a")
	assert len(first) == 2
	assert {item.section_path for item in first} == {"第3章 请假制度", "第4章 薪酬福利"}
	leave = next(item for item in first if item.section_path and "第3章" in item.section_path)
	assert "三个工作日" in leave.body and "年假" in leave.body
	assert leave.source_chunk_ids == [
		chunk_record_id("doc-a", 0),
		chunk_record_id("doc-a", 1),
	]
	assert [item.record_id for item in first] == [item.record_id for item in second]
	assert [item.point_uuid() for item in first] == [item.point_uuid() for item in second]


def test_section_parts_keep_local_source_chunk_ids() -> None:
	chunks = [
		Chunk(
			chunk_index=0,
			text="甲",
			body="甲" * 20,
			section_path="长节",
			page_start=1,
			page_end=1,
			split_strategy=SplitStrategy.HEADING,
		),
		Chunk(
			chunk_index=1,
			text="乙",
			body="乙" * 20,
			section_path="长节",
			page_start=2,
			page_end=2,
			split_strategy=SplitStrategy.HEADING,
		),
	]
	parts = build_section_records_from_chunks(chunks, doc_id="doc-long", max_chars=25)
	assert len(parts) >= 2
	assert parts[0].source_chunk_ids == [chunk_record_id("doc-long", 0)]
	assert "甲" in parts[0].body and "乙" not in parts[0].body
	assert parts[0].page_start == 1 and parts[0].page_end == 1
	assert parts[1].source_chunk_ids == [chunk_record_id("doc-long", 1)]
	assert "乙" in parts[1].body and "甲" not in parts[1].body


def test_document_version_changes_with_content() -> None:
	from app.services.ingest.pipeline import chunks_to_payloads

	a = [
		Chunk(
			chunk_index=0,
			text="a",
			body="版本甲内容",
			section_path="第1章",
			split_strategy=SplitStrategy.HEADING,
			content_hash="hash_aaa_111111",
		),
	]
	b = [
		Chunk(
			chunk_index=0,
			text="b",
			body="版本乙内容",
			section_path="第1章",
			split_strategy=SplitStrategy.HEADING,
			content_hash="hash_bbb_222222",
		),
	]
	pa = chunks_to_payloads(a, doc_id="doc-a", include_sections=False)
	pb = chunks_to_payloads(b, doc_id="doc-a", include_sections=False)
	assert pa[0]["document_version_id"] != pb[0]["document_version_id"]
	assert pa[0]["document_version_id"].startswith("doc-a:")
	assert pb[0]["document_version_id"].startswith("doc-a:")


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
	assert body["retrieval_debug"]["retrieval_plan"]["record_type"] == "chunk"

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


def test_ask_section_lookup_uses_section_plan() -> None:
	lib_id = create_library(client, library_id="lib-router-section")
	ask = client.post(
		"/v1/ask",
		json={"question": "第3章讲什么？", "library_id": lib_id},
	)
	assert ask.status_code == 200
	body = ask.json()
	plan = body["retrieval_debug"]["retrieval_plan"]
	assert body["retrieval_debug"]["query_type"] == "section_lookup"
	assert plan["record_type"] == "section"
	assert plan["execute_path"] == "section_short"
	assert body["retrieval_debug"].get("record_type") == "section"
	assert body["citations"]
	assert body["citations"][0].get("record_type") == "section"
	assert body["citations"][0].get("source_chunk_ids")


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
