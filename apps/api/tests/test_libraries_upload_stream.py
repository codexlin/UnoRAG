from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.main import app
from app.routers.libraries import (
	_delete_library_resources,
	get_document_storage,
	get_service_access_scope,
)
from app.security.access_scope import AccessScope
from app.security.internal_context import RequestContext
from app.services.hybrid import fuse_dense_and_bm25, tokenize
from app.services.documents import extract_text
from app.settings import get_settings
from tests.conftest import create_library
from tests.support.seed import (
	seed_reindex_document,
	seed_replace_document,
	seed_upload_document,
)

client = TestClient(app)


def test_internal_projection_rejects_session_context() -> None:
	context = RequestContext(
		tenant_id="tenant-1",
		workspace_id="workspace-1",
		principal_id="user-1",
		group_ids=(),
		request_id="request-1",
		jti="jti-1",
		auth_source="session",
		method="DELETE",
		target="/v1/internal/projections/libraries/library-1",
		body_sha256=None,
		issued_at=0,
		expires_at=0,
	)

	with pytest.raises(HTTPException, match="service request context required") as exc:
		get_service_access_scope(context)

	assert exc.value.status_code == 403


def test_list_libraries_starts_empty() -> None:
	response = client.get("/v1/libraries")
	assert response.status_code == 200
	assert response.json() == []


def test_create_library_and_list_documents() -> None:
	created = client.post(
		"/v1/libraries",
		json={
			"name": "工程手册",
			"description": "施工与验收规范",
			"library_id": "lib-eng-test",
		},
	)
	assert created.status_code == 200
	payload = created.json()
	assert payload["status"] == "empty"
	assert payload["description"] == "施工与验收规范"

	docs = client.get("/v1/libraries/lib-eng-test/documents")
	assert docs.status_code == 200
	assert docs.json() == []


def test_update_library_name_and_description() -> None:
	created = client.post(
		"/v1/libraries",
		json={"name": "待改名库", "library_id": "lib-rename-test"},
	)
	assert created.status_code == 200
	assert created.json().get("description") is None

	patched = client.patch(
		"/v1/libraries/lib-rename-test",
		json={"name": "已改名库", "description": "更新后的描述"},
	)
	assert patched.status_code == 200
	body = patched.json()
	assert body["name"] == "已改名库"
	assert body["description"] == "更新后的描述"

	detail = client.get("/v1/libraries/lib-rename-test")
	assert detail.status_code == 200
	assert detail.json()["name"] == "已改名库"
	assert detail.json()["description"] == "更新后的描述"

	cleared = client.patch(
		"/v1/libraries/lib-rename-test",
		json={"description": None},
	)
	assert cleared.status_code == 200
	assert cleared.json()["description"] is None
	assert cleared.json()["name"] == "已改名库"


def test_internal_library_projection_is_idempotent() -> None:
	created = client.put(
		"/v1/internal/projections/libraries/lib-projection-test",
		json={"name": "Initial", "description": "v1"},
	)
	updated = client.put(
		"/v1/internal/projections/libraries/lib-projection-test",
		json={"name": "Updated", "description": None},
	)

	assert created.status_code == 200
	assert created.json()["name"] == "Initial"
	assert updated.status_code == 200
	assert updated.json()["name"] == "Updated"
	assert updated.json()["description"] is None
	assert client.get("/v1/libraries/lib-projection-test").json()["name"] == "Updated"


def test_internal_library_projection_delete_is_idempotent() -> None:
	created = client.put(
		"/v1/internal/projections/libraries/lib-projection-delete-test",
		json={"name": "Delete me"},
	)
	first = client.delete(
		"/v1/internal/projections/libraries/lib-projection-delete-test",
	)
	replayed = client.delete(
		"/v1/internal/projections/libraries/lib-projection-delete-test",
	)

	assert created.status_code == 200
	assert first.status_code == 200
	assert first.json()["already_absent"] is False
	assert replayed.status_code == 200
	assert replayed.json()["already_absent"] is True


def test_internal_library_projection_accepts_concurrent_delete_completion() -> None:
	class ConcurrentDeleteMeta:
		def __init__(self) -> None:
			self.reads = 0

		def get_library(self, _library_id, *, scope):
			self.reads += 1
			return {"id": "library-1"} if self.reads == 1 else None

		def list_documents(self, _library_id, *, scope):
			return []

		def delete_library(self, _library_id, *, scope):
			return False

	class Storage:
		pass

	settings = get_settings()
	result = _delete_library_resources(
		"library-1",
		settings=settings,
		meta=ConcurrentDeleteMeta(),
		storage=Storage(),
		access_scope=AccessScope.development(settings),
		missing_ok=True,
	)

	assert result["ok"] is True
	assert result["already_absent"] is True


def test_internal_library_delete_retains_metadata_when_storage_cleanup_fails() -> None:
	lib_id = create_library(
		client,
		name="Cleanup retry",
		library_id="lib-projection-delete-retry",
	)
	seed_upload_document(
		library_id=lib_id,
		filename="retry.md",
		content=b"# Retry\n\nRetain metadata until storage cleanup succeeds.",
		content_type="text/markdown",
	)

	class FailingStorage:
		def delete(self, _storage_key: str) -> None:
			raise OSError("storage unavailable")

	app.dependency_overrides[get_document_storage] = FailingStorage
	try:
		deleted = client.delete(
			f"/v1/internal/projections/libraries/{lib_id}",
		)
	finally:
		app.dependency_overrides.pop(get_document_storage, None)

	assert deleted.status_code == 502
	assert "metadata retained for retry" in deleted.json()["detail"]
	assert client.get(f"/v1/libraries/{lib_id}").status_code == 200


def test_delete_library_with_documents() -> None:
	lib_id = create_library(client, name="待删除库", library_id="lib-delete-test")

	uploaded = seed_upload_document(
		library_id=lib_id,
		filename="note.md",
		content="# 删除测试\n\n这条文档应随库一并清除。".encode("utf-8"),
		content_type="text/markdown",
	)
	doc_id = uploaded["doc_id"]

	docs_before = client.get(f"/v1/libraries/{lib_id}/documents")
	assert docs_before.status_code == 200
	assert any(item["id"] == doc_id for item in docs_before.json())

	deleted = client.delete(f"/v1/libraries/{lib_id}")
	assert deleted.status_code == 200
	payload = deleted.json()
	assert payload["ok"] is True
	assert payload["library_id"] == lib_id
	assert payload["deleted_documents"] >= 1

	missing = client.get(f"/v1/libraries/{lib_id}")
	assert missing.status_code == 404

	doc_missing = client.get(f"/v1/documents/{doc_id}")
	assert doc_missing.status_code == 404

	again = client.delete(f"/v1/libraries/{lib_id}")
	assert again.status_code == 404


def test_upload_txt_stub_simulate() -> None:
	lib_id = create_library(client, library_id="lib-upload-sim")
	payload = seed_upload_document(
		library_id=lib_id,
		filename="leave.md",
		content="# 病假\n\n须于返岗后三个工作日内补交证明。".encode("utf-8"),
		content_type="text/markdown",
	)
	assert payload["status"] == "ready"
	assert payload["simulated"] is True
	assert payload["chunk_count"] >= 1

	docs = client.get(f"/v1/libraries/{lib_id}/documents")
	assert docs.status_code == 200
	assert any(item["id"] == payload["doc_id"] for item in docs.json())


def test_fastapi_upload_permanently_gone() -> None:
	lib_id = create_library(client, library_id="lib-upload-gone")
	response = client.post(
		"/v1/ingest/upload",
		data={"library_id": lib_id},
		files={
			"file": (
				"gone.md",
				"# gone\n".encode("utf-8"),
				"text/markdown",
			)
		},
	)
	assert response.status_code == 410


def test_process_document_ingest_sync_job() -> None:
	from app.services.ingest.jobs import process_document_ingest

	lib_id = create_library(client, library_id="lib-job-sync")
	uploaded = seed_upload_document(
		library_id=lib_id,
		filename="job-note.md",
		content="# job\n\n后台任务可跑通。".encode("utf-8"),
		content_type="text/markdown",
	)
	doc_id = uploaded["doc_id"]
	result = process_document_ingest(doc_id)
	assert result["ok"] is True
	assert result.get("skipped") is True


def test_replace_document_keeps_doc_id() -> None:
	lib_id = create_library(client, name="替换测试库", library_id="lib-replace-test")

	uploaded = seed_upload_document(
		library_id=lib_id,
		filename="v1.md",
		content="# v1\n\n旧版内容。".encode("utf-8"),
		content_type="text/markdown",
	)
	doc_id = uploaded["doc_id"]

	body = seed_replace_document(
		doc_id,
		filename="v2.md",
		content="# v2\n\n新版内容应覆盖旧版。".encode("utf-8"),
		content_type="text/markdown",
	)
	assert body["doc_id"] == doc_id
	assert body["filename"] == "v2.md"
	assert body["status"] == "ready"
	assert body["chunk_count"] >= 1

	detail = client.get(f"/v1/documents/{doc_id}")
	assert detail.status_code == 200
	row = detail.json()
	assert row["filename"] == "v2.md"
	assert row["has_file"] is True
	assert row["size_bytes"] == len("# v2\n\n新版内容应覆盖旧版。".encode("utf-8"))


def test_upload_writes_size_bytes() -> None:
	lib_id = create_library(client, library_id="lib-size-check")
	content = "# size check\n\n文件大小应写入元数据。".encode("utf-8")
	uploaded = seed_upload_document(
		library_id=lib_id,
		filename="size-check.md",
		content=content,
		content_type="text/markdown",
	)
	doc_id = uploaded["doc_id"]

	detail = client.get(f"/v1/documents/{doc_id}")
	assert detail.status_code == 200
	body = detail.json()
	assert body["size_bytes"] == len(content)
	assert body["has_file"] is True

	listed = client.get(f"/v1/libraries/{lib_id}/documents")
	assert listed.status_code == 200
	row = next(item for item in listed.json() if item["id"] == doc_id)
	assert row["size_bytes"] == len(content)

	seed_reindex_document(doc_id)
	after = client.get(f"/v1/documents/{doc_id}")
	assert after.status_code == 200
	assert after.json()["size_bytes"] == len(content)


def test_ask_stream_sse() -> None:
	lib_id = create_library(client, library_id="lib-ask-stream")
	with client.stream(
		"POST",
		"/v1/ask/stream",
		json={"question": "病假需要在几天内补交证明？", "library_id": lib_id},
	) as response:
		assert response.status_code == 200
		body = "".join(response.iter_text())
	assert "event: meta" in body
	assert "event: citations" in body
	assert "event: token" in body
	assert "event: done" in body
	assert "三个工作日" in body
	assert '"text"' in body
	# Default-temp ask (no thread_id): SessionMemory only — not durable archive.
	assert '"persisted": false' in body or '"persisted":false' in body
	assert "retrieval_mode" in body


def test_tokenize_chinese_bigrams() -> None:
	tokens = tokenize("病假证明")
	assert "病" in tokens
	assert "病假" in tokens


def test_rrf_fusion_debug_fields() -> None:
	dense = [
		{
			"id": "d1",
			"doc_id": "doc-a",
			"chunk_index": 0,
			"title": "A",
			"snippet": "病假三个工作日",
			"text": "病假三个工作日",
			"score": 0.9,
		}
	]
	bm25 = [
		{
			"id": "b1",
			"doc_id": "doc-a",
			"chunk_index": 0,
			"title": "A",
			"snippet": "病假三个工作日",
			"text": "病假三个工作日",
			"score": 4.2,
		},
		{
			"id": "b2",
			"doc_id": "doc-b",
			"chunk_index": 1,
			"title": "B",
			"snippet": "年假",
			"text": "年假",
			"score": 1.1,
		},
	]
	fused = fuse_dense_and_bm25(dense_hits=dense, bm25_hits=bm25, rrf_k=60, limit=5)
	assert fused
	assert fused[0]["rrf_score"] is not None
	assert fused[0]["doc_id"] == "doc-a"


def test_extract_txt() -> None:
	parsed = extract_text(filename="note.txt", content="hello 病假".encode("utf-8"))
	assert "病假" in parsed.text
	assert parsed.parser == "text"
