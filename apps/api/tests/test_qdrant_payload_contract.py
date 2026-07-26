"""Pydantic Phase 1：IndexRecord / Qdrant payload 写入契约。"""

from __future__ import annotations

import pytest
from qdrant_client import QdrantClient

from app.security.access_scope import AccessScope
from app.services.ingest.index_record import IndexRecord, index_record_to_payload
from app.services.ingest.ir import Chunk, SplitStrategy
from app.services.ingest.pipeline import chunks_to_payloads
from app.services.ingest.qdrant_payload import (
	FILTER_PAYLOAD_FIELDS,
	QDRANT_OPTIONAL_CONTENT_FIELDS,
	parse_stored_payload,
	validate_index_write_payload,
	validate_payload_for_upsert,
)
from app.services.qdrant_store import QdrantStore
from app.settings import Settings


def _chunk() -> Chunk:
	return Chunk(
		chunk_index=0,
		text="病假需在三个工作日内补交证明。",
		body="病假需在三个工作日内补交证明。",
		section_path="第3章/请假",
		heading_text="病假",
		split_strategy=SplitStrategy.HEADING,
		source_format="md",
		content_hash="abc123",
		meta={
			"chunk_policy_version": "v1",
			"chunk_profile": "general",
			"split_reason": "heading_boundary",
			"target_chars": 800,
			"max_chars": 1200,
		},
	)


def test_filter_fields_documented_and_subset_of_content_allowlist() -> None:
	# generation / ACL 等 filter 键必须在允许入库列表内（table_id 亦用于表格加载过滤）
	assert "tenant_id" in FILTER_PAYLOAD_FIELDS
	assert "record_type" in FILTER_PAYLOAD_FIELDS
	assert "generation_id" in FILTER_PAYLOAD_FIELDS
	assert FILTER_PAYLOAD_FIELDS <= (
		QDRANT_OPTIONAL_CONTENT_FIELDS
		| {"library_id", "doc_id", "title", "text", "chunk_index"}
	)


def test_chunks_to_payloads_validates_and_keeps_allowed_fields() -> None:
	payloads = chunks_to_payloads(
		[_chunk()],
		doc_id="doc-1",
		library_id="lib-1",
		document_version_id="11111111-1111-1111-1111-111111111111",
		include_sections=False,
		include_tables=False,
	)
	assert len(payloads) == 1
	item = payloads[0]
	assert item["record_type"] == "chunk"
	assert item["document_version_id"] == "11111111-1111-1111-1111-111111111111"
	assert item["chunk_policy_version"] == "v1"
	assert "_point_id" in item
	assert "embed_text" in item
	# 未知顶层键不得出现在校验后的写入 dict
	assert "evil_meta" not in item


def test_index_write_payload_rejects_unknown_keys() -> None:
	base = chunks_to_payloads(
		[_chunk()],
		doc_id="doc-1",
		document_version_id="11111111-1111-1111-1111-111111111111",
		include_sections=False,
		include_tables=False,
	)[0]
	dirty = {**base, "evil_meta": {"injected": True}}
	with pytest.raises(ValueError, match="invalid index write payload"):
		validate_index_write_payload(dirty)


def test_index_write_payload_rejects_invalid_record_type() -> None:
	base = chunks_to_payloads(
		[_chunk()],
		doc_id="doc-1",
		document_version_id="11111111-1111-1111-1111-111111111111",
		include_sections=False,
		include_tables=False,
	)[0]
	dirty = {**base, "record_type": "not_a_real_type"}
	with pytest.raises(ValueError, match="invalid index write payload"):
		validate_index_write_payload(dirty)


def test_upsert_rejects_dirty_payload_fail_closed() -> None:
	settings = Settings(
		embedding_dim=3,
		qdrant_collection="payload-contract-test",
		internal_auth_enabled=False,
	)
	store = QdrantStore(settings, client=QdrantClient(location=":memory:"))
	scope = AccessScope.development(settings)
	with pytest.raises(ValueError, match="invalid Qdrant index payload"):
		store.upsert_chunks(
			library_id="lib-1",
			doc_id="doc-1",
			title="手册",
			chunks=[
				{
					"chunk_index": 0,
					"text": "ok",
					"body": "ok",
					"document_version_id": "11111111-1111-1111-1111-111111111111",
					"record_type": {"nested": "bad"},
					"record_id": "chk:doc-1:0",
				}
			],
			vectors=[[1.0, 0.0, 0.0]],
			access_scope=scope,
		)


def test_upsert_accepts_normal_ingest_payload() -> None:
	settings = Settings(
		embedding_dim=3,
		qdrant_collection="payload-contract-ok",
		internal_auth_enabled=False,
	)
	store = QdrantStore(settings, client=QdrantClient(location=":memory:"))
	scope = AccessScope.development(settings)
	payloads = chunks_to_payloads(
		[_chunk()],
		doc_id="doc-1",
		document_version_id="11111111-1111-1111-1111-111111111111",
		tenant_id=scope.tenant_id,
		workspace_id=scope.workspace_id,
		include_sections=False,
		include_tables=False,
	)
	count = store.upsert_chunks(
		library_id="lib-1",
		doc_id="doc-1",
		title="手册",
		chunks=payloads,
		vectors=[[1.0, 0.0, 0.0]],
		access_scope=scope,
	)
	assert count == 1
	points, _ = store.client.scroll(
		collection_name=store.collection,
		limit=10,
		with_payload=True,
		with_vectors=False,
	)
	assert len(points) == 1
	payload = dict(points[0].payload or {})
	assert payload["record_type"] == "chunk"
	assert payload["document_version_id"] == "11111111-1111-1111-1111-111111111111"
	assert "embed_text" not in payload
	assert "_point_id" not in payload
	assert "evil_meta" not in payload


def test_index_record_to_payload_requires_document_version_id() -> None:
	record = IndexRecord(
		record_type="section",
		record_id="sec:abc",
		body="hello",
		embed_text="hello",
		doc_id="doc-1",
	)
	with pytest.raises(ValueError, match="document_version_id is required"):
		index_record_to_payload(record)


def test_index_record_to_payload_validates() -> None:
	record = IndexRecord(
		record_type="section",
		record_id="sec:abc",
		document_version_id="11111111-1111-1111-1111-111111111111",
		body="hello",
		embed_text="hello",
		doc_id="doc-1",
		tenant_id="t1",
		workspace_id="w1",
	)
	payload = index_record_to_payload(record)
	assert payload["record_type"] == "section"
	assert payload["document_version_id"] == "11111111-1111-1111-1111-111111111111"
	assert payload["_point_id"]


def test_parse_stored_payload_tolerates_legacy_unknown_keys() -> None:
	legacy = {
		"library_id": "lib-1",
		"doc_id": "doc-1",
		"title": "旧文档",
		"chunk_index": 0,
		"text": "正文",
		"legacy_only_field": "keep-on-raw",
	}
	parsed = parse_stored_payload(legacy)
	assert parsed is not None
	assert parsed.doc_id == "doc-1"
	dumped = parsed.model_dump(exclude_none=True)
	assert "legacy_only_field" not in dumped


def test_validate_payload_for_upsert_rejects_unknown_top_level() -> None:
	with pytest.raises(ValueError, match="invalid Qdrant index payload"):
		validate_payload_for_upsert(
			{
				"library_id": "lib-1",
				"doc_id": "doc-1",
				"title": "t",
				"chunk_index": 0,
				"text": "x",
				"document_version_id": "11111111-1111-1111-1111-111111111111",
				"record_type": "chunk",
				"tenant_id": "t",
				"workspace_id": "w",
				"not_allowed": 1,
			}
		)
