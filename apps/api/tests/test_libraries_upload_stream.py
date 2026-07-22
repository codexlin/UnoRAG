from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.services.hybrid import fuse_dense_and_bm25, tokenize
from app.services.documents import extract_text

client = TestClient(app)


def test_list_libraries_seeded() -> None:
	response = client.get("/v1/libraries")
	assert response.status_code == 200
	payload = response.json()
	assert any(item["id"] == "lib-hr" for item in payload)


def test_create_library_and_list_documents() -> None:
	created = client.post("/v1/libraries", json={"name": "工程手册", "library_id": "lib-eng-test"})
	assert created.status_code == 200
	assert created.json()["status"] == "empty"

	docs = client.get("/v1/libraries/lib-eng-test/documents")
	assert docs.status_code == 200
	assert docs.json() == []


def test_upload_txt_stub_simulate() -> None:
	response = client.post(
		"/v1/ingest/upload",
		data={"library_id": "lib-hr"},
		files={
			"file": (
				"leave.md",
				"# 病假\n\n须于返岗后三个工作日内补交证明。".encode("utf-8"),
				"text/markdown",
			)
		},
	)
	assert response.status_code == 200
	payload = response.json()
	assert payload["status"] == "ready"
	assert payload["simulated"] is True
	assert payload["chunk_count"] >= 1

	docs = client.get("/v1/libraries/lib-hr/documents")
	assert docs.status_code == 200
	assert any(item["id"] == payload["doc_id"] for item in docs.json())


def test_ask_stream_sse() -> None:
	with client.stream(
		"POST",
		"/v1/ask/stream",
		json={"question": "病假需要在几天内补交证明？", "library_id": "lib-hr"},
	) as response:
		assert response.status_code == 200
		body = "".join(response.iter_text())
	assert "event: meta" in body
	assert "event: citations" in body
	assert "event: token" in body
	assert "event: done" in body
	assert "三个工作日" in body
	assert '"text"' in body
	assert '"persisted": true' in body or '"persisted":true' in body
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
