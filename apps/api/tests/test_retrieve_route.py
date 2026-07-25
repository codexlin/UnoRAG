"""Minimal POST /v1/retrieve coverage (stub RetrievalService)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import retrieve as retrieve_router

client = TestClient(app)


class _StubRetrievalService:
	def __init__(self, *_args: Any, **_kwargs: Any) -> None:
		self.last_debug = {
			"retrieval_mode": "dense",
			"used_hybrid": False,
			"used_rerank": False,
		}

	def search(
		self,
		*,
		query: str,
		library_id: str | None,
		top_k: int | None = None,
		record_type: str | None = "chunk",
		filters: dict[str, Any] | None = None,
	) -> list[dict[str, Any]]:
		assert library_id == "lib-demo"
		assert "病假" in query
		return [
			{
				"id": "c1",
				"index": 1,
				"title": "考勤制度",
				"snippet": "病假须于返岗后三个工作日内补交证明。",
				"score": 0.91,
				"text": "病假须于返岗后三个工作日内补交证明。",
				"body": "病假须于返岗后三个工作日内补交证明。",
				"doc_id": "d1",
				"filename": "policy.pdf",
			}
		]


@pytest.fixture(autouse=True)
def stub_retrieval(monkeypatch: pytest.MonkeyPatch) -> None:
	monkeypatch.setattr(
		retrieve_router,
		"RetrievalService",
		lambda *_a, **_k: _StubRetrievalService(),
	)


def test_retrieve_returns_citations() -> None:
	response = client.post(
		"/v1/retrieve",
		json={"query": "病假证明几天内补交？", "library_id": "lib-demo"},
	)
	assert response.status_code == 200, response.text
	payload = response.json()
	assert payload["library_id"] == "lib-demo"
	assert payload["refused"] is False
	assert len(payload["citations"]) == 1
	assert "三个工作日" in payload["citations"][0]["snippet"]
	assert payload["retrieval_debug"]["auth_source"]


def test_retrieve_rejects_blank_query() -> None:
	response = client.post(
		"/v1/retrieve",
		json={"query": "", "library_id": "lib-demo"},
	)
	assert response.status_code == 422


def test_retrieve_empty_hits_refused(monkeypatch: pytest.MonkeyPatch) -> None:
	class Empty(_StubRetrievalService):
		def search(self, **_kwargs: Any) -> list[dict[str, Any]]:
			return []

	monkeypatch.setattr(
		retrieve_router,
		"RetrievalService",
		lambda *_a, **_k: Empty(),
	)
	response = client.post(
		"/v1/retrieve",
		json={"query": "无证据问题", "library_id": "lib-demo"},
	)
	assert response.status_code == 200
	payload = response.json()
	assert payload["refused"] is True
	assert payload["refuse_reason"] == "no_matching_evidence"
	assert payload["citations"] == []
