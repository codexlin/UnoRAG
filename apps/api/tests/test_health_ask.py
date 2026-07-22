from __future__ import annotations

from fastapi.testclient import TestClient

from app.graph.ask_graph import AskGraphService, build_ask_graph, stub_generate
from app.main import app
from app.settings import Settings

client = TestClient(app)


def test_health() -> None:
	response = client.get("/health")
	assert response.status_code == 200
	payload = response.json()
	assert payload["status"] == "ok"
	assert payload["graph"] == "ask_v1"
	assert payload["ask_mode"] in {"stub", "live"}
	assert payload["effective_mode"] in {"stub", "live"}
	assert "degraded" in payload
	assert "qdrant_ok" in payload


def test_ask_stub() -> None:
	response = client.post(
		"/v1/ask",
		json={"question": "病假需要在几天内补交证明？", "library_id": "lib-hr"},
	)
	assert response.status_code == 200
	payload = response.json()
	assert "三个工作日" in payload["answer"]
	assert len(payload["citations"]) >= 1
	assert payload["mode"] == "stub"
	assert payload["refused"] is False
	assert payload["retrieval_debug"]["judgement"]["action"] == "generate"


def test_ask_refuse_no_hit() -> None:
	response = client.post(
		"/v1/ask",
		json={"question": "无命中：火星上的年假怎么算？", "library_id": "lib-hr"},
	)
	assert response.status_code == 200
	payload = response.json()
	assert payload["refused"] is True
	assert payload["refuse_reason"] == "no_hit"
	assert payload["citations"] == []
	assert "没有找到" in payload["answer"]
	assert payload["retrieval_debug"]["judgement"]["reason"] == "no_hit"


def test_ask_refuse_weak_match() -> None:
	response = client.post(
		"/v1/ask",
		json={"question": "弱相关：随便问问无关内容", "library_id": "lib-hr"},
	)
	assert response.status_code == 200
	payload = response.json()
	assert payload["refused"] is True
	assert payload["refuse_reason"] == "weak_match"
	assert "相关度不够高" in payload["answer"]
	# Weak hits kept for transparency after final refuse.
	assert len(payload["citations"]) >= 1
	assert payload["citations"][0]["score"] < 0.35


def test_judge_with_injected_weak_retrieve() -> None:
	settings = Settings(ask_mode="stub", answer_min_score=0.5, max_retrieve_retries=0)

	def fake_retrieve(_query: str, _library_id: str | None, _top_k: int):
		return [
			{
				"id": "x",
				"index": 1,
				"title": "noise",
				"page": None,
				"snippet": "irrelevant",
				"score": 0.2,
				"text": "irrelevant",
			}
		]

	service = AskGraphService(
		settings,
		retrieve_fn=fake_retrieve,
		generate_fn=stub_generate,
	)
	result = service.ask(question="anything", library_id="lib-hr")
	assert result.refused is True
	assert result.refuse_reason == "weak_match"


def test_retry_then_generate() -> None:
	settings = Settings(ask_mode="stub", answer_min_score=0.5, max_retrieve_retries=1)
	calls = {"n": 0}

	def flaky_retrieve(_query: str, _library_id: str | None, _top_k: int):
		calls["n"] += 1
		if calls["n"] == 1:
			return []
		return [
			{
				"id": "ok",
				"index": 1,
				"title": "制度.pdf",
				"page": "1",
				"snippet": "三个工作日",
				"score": 0.9,
				"text": "病假三个工作日内补交证明",
			}
		]

	service = AskGraphService(
		settings,
		retrieve_fn=flaky_retrieve,
		generate_fn=stub_generate,
	)
	result = service.ask(question="病假几天？")
	assert result.refused is False
	assert calls["n"] == 2
	assert "三个工作日" in result.answer


def test_build_graph_compile() -> None:
	settings = Settings(ask_mode="stub")
	graph = build_ask_graph(
		settings=settings,
		retrieve_fn=lambda q, lib, k: [],
		generate_fn=stub_generate,
		mode="stub",
	)
	assert graph is not None


def test_ingest_unavailable_in_stub() -> None:
	response = client.post(
		"/v1/ingest",
		json={
			"library_id": "lib-hr",
			"title": "sample",
			"text": "病假须于返岗后三个工作日内补交证明材料。",
		},
	)
	assert response.status_code == 503
