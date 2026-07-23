from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.graph.ask_graph import AskGraphService, build_ask_graph, stub_generate
from app.main import app
from app.settings import Settings, get_settings
from tests.conftest import create_library

client = TestClient(app)


def test_health() -> None:
	response = client.get("/health")
	assert response.status_code == 200
	payload = response.json()
	assert payload["status"] == "ok"
	assert payload["graph"] == "ask_v1"
	assert payload["ask_mode"] == "stub"
	assert payload["effective_mode"] == "stub"
	assert payload["degraded"] is False
	assert payload["ask_ready"] is True
	assert "qdrant_ok" in payload
	assert "live_ready" in payload


def test_live_unavailable_hard_fails_not_stub(monkeypatch: pytest.MonkeyPatch) -> None:
	"""ASK_MODE=live without keys must not silently degrade to stub ask."""
	monkeypatch.setenv("ASK_MODE", "live")
	monkeypatch.setenv("DASHSCOPE_API_KEY", "")
	monkeypatch.setenv("OPENAI_API_KEY", "")
	get_settings.cache_clear()

	from app.services.runtime import resolve_runtime

	capability = resolve_runtime(get_settings(), qdrant_ok=False)
	assert capability.requested_mode == "live"
	assert capability.effective_mode == "live"
	assert capability.degraded is True
	assert capability.live_ready is False
	assert capability.ask_ready is False
	assert "missing_llm_api_key" in capability.reasons

	health = client.get("/health")
	assert health.status_code == 200
	body = health.json()
	assert body["status"] == "unavailable"
	assert body["effective_mode"] == "live"
	assert body["degraded"] is True
	assert body["ask_ready"] is False

	ask = client.post(
		"/v1/ask",
		json={"question": "病假需要在几天内补交证明？", "library_id": "lib-any"},
	)
	assert ask.status_code == 503

	ingest = client.post(
		"/v1/ingest",
		json={
			"library_id": "lib-any",
			"title": "sample",
			"text": "病假须于返岗后三个工作日内补交证明材料。",
		},
	)
	assert ingest.status_code == 503
	get_settings.cache_clear()


def test_ask_requires_library_id() -> None:
	missing = client.post("/v1/ask", json={"question": "病假需要在几天内补交证明？"})
	assert missing.status_code == 400
	assert "library_id" in missing.json()["detail"]

	blank = client.post(
		"/v1/ask",
		json={"question": "病假需要在几天内补交证明？", "library_id": "  "},
	)
	assert blank.status_code == 400

	stream = client.post(
		"/v1/ask/stream",
		json={"question": "病假需要在几天内补交证明？"},
	)
	assert stream.status_code == 400


def test_ask_stub() -> None:
	lib_id = create_library(client, library_id="lib-ask-stub")
	response = client.post(
		"/v1/ask",
		json={"question": "病假需要在几天内补交证明？", "library_id": lib_id},
	)
	assert response.status_code == 200
	payload = response.json()
	assert "三个工作日" in payload["answer"]
	assert len(payload["citations"]) >= 1
	citation = payload["citations"][0]
	assert citation.get("text")
	assert "三个工作日" in citation["text"]
	assert citation["snippet"]
	assert payload["mode"] == "stub"
	assert payload["refused"] is False
	assert payload["persisted"] is True
	assert payload["retrieval_mode"] in {"dense", "hybrid"}
	assert payload["retrieval_debug"]["judgement"]["action"] == "generate"


def test_ask_refuse_no_hit() -> None:
	lib_id = create_library(client, library_id="lib-ask-nohit")
	response = client.post(
		"/v1/ask",
		json={"question": "无命中：火星上的年假怎么算？", "library_id": lib_id},
	)
	assert response.status_code == 200
	payload = response.json()
	assert payload["refused"] is True
	assert payload["refuse_reason"] == "no_hit"
	assert payload["citations"] == []
	assert "没有找到" in payload["answer"]
	assert payload["retrieval_debug"]["judgement"]["reason"] == "no_hit"


def test_ask_refuse_weak_match() -> None:
	lib_id = create_library(client, library_id="lib-ask-weak")
	response = client.post(
		"/v1/ask",
		json={"question": "弱相关：随便问问无关内容", "library_id": lib_id},
	)
	assert response.status_code == 200
	payload = response.json()
	assert payload["refused"] is True
	assert payload["refuse_reason"] == "weak_match"
	assert "相关度不够高" in payload["answer"]
	assert len(payload["citations"]) >= 1
	assert payload["citations"][0]["score"] < 0.35


def test_judge_with_injected_weak_retrieve() -> None:
	settings = Settings(ask_mode="stub", answer_min_score=0.5, max_retrieve_retries=0)

	def fake_retrieve(
		_query: str,
		_library_id: str | None,
		_top_k: int,
		_filters: dict | None = None,
	):
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
	result = service.ask(question="anything", library_id="lib-unit")
	assert result.refused is True
	assert result.refuse_reason == "weak_match"


def test_retry_then_generate() -> None:
	settings = Settings(ask_mode="stub", answer_min_score=0.5, max_retrieve_retries=1)
	calls = {"n": 0}

	def flaky_retrieve(
		_query: str,
		_library_id: str | None,
		_top_k: int,
		_filters: dict | None = None,
	):
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
	calls: dict[str, object] = {"n": 0}

	def retrieve_fn(
		_query: str,
		_library_id: str | None,
		_top_k: int,
		_filters: dict | None = None,
	):
		calls["n"] = int(calls["n"]) + 1
		return []

	graph = build_ask_graph(
		settings=settings,
		retrieve_fn=retrieve_fn,
		generate_fn=stub_generate,
		mode="stub",
	)
	assert graph is not None
	# 实际 invoke 一次，强制校验 RetrieveFn 为 4 参签名
	state = graph.invoke(
		{
			"session_id": "s-compile",
			"question": "病假几天？",
			"library_id": "lib-compile",
			"history": [],
			"retrieval_debug": {},
		}
	)
	assert state is not None
	assert int(calls["n"]) >= 1


def test_ingest_simulates_in_stub() -> None:
	lib_id = create_library(client, library_id="lib-ingest-sim")
	response = client.post(
		"/v1/ingest",
		json={
			"library_id": lib_id,
			"title": "sample",
			"text": "病假须于返岗后三个工作日内补交证明材料。",
		},
	)
	assert response.status_code == 200
	payload = response.json()
	assert payload["status"] == "ready"
	assert payload["simulated"] is True
	assert payload["chunk_count"] >= 1
	assert payload["mode"] == "stub"

	libs = client.get("/v1/libraries")
	assert libs.status_code == 200
	row = next(item for item in libs.json() if item["id"] == lib_id)
	assert row["ready_count"] >= 1
	assert row["status"] == "ready"


def test_ingest_503_when_simulate_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
	lib_id = create_library(client, library_id="lib-ingest-nosim")
	monkeypatch.setenv("STUB_INGEST_SIMULATE", "false")
	get_settings.cache_clear()
	response = client.post(
		"/v1/ingest",
		json={
			"library_id": lib_id,
			"title": "sample",
			"text": "病假须于返岗后三个工作日内补交证明材料。",
		},
	)
	assert response.status_code == 503
	get_settings.cache_clear()


def test_ask_persists_archive_turn() -> None:
	lib_id = create_library(client, library_id="lib-ask-archive")
	response = client.post(
		"/v1/ask",
		json={
			"question": "病假需要在几天内补交证明？",
			"library_id": lib_id,
			"session_id": "archive-session-1",
		},
	)
	assert response.status_code == 200
	payload = response.json()
	assert payload["citations"][0].get("doc_id") or payload["citations"][0].get("title")
	assert payload["persisted"] is True
	assert payload["citations"][0].get("text")

	archive = client.get("/v1/archive", params={"session_id": "archive-session-1"})
	assert archive.status_code == 200
	rows = archive.json()
	assert len(rows) >= 1
	assert rows[0]["question"] == "病假需要在几天内补交证明？"
	assert rows[0]["citations"]
	assert "doc_id" in rows[0]["citations"][0] or rows[0]["citations"][0].get("title")
	assert rows[0]["citations"][0].get("text") or rows[0]["citations"][0].get("snippet")


def test_ask_persist_failure_is_visible(monkeypatch: pytest.MonkeyPatch) -> None:
	from app.graph import ask_graph as ask_graph_mod

	lib_id = create_library(client, library_id="lib-ask-persist-fail")

	def boom_persist(**_kwargs):
		return {"persisted": False, "persist_error": "disk full"}

	monkeypatch.setattr(ask_graph_mod, "_persist_turn", boom_persist)
	response = client.post(
		"/v1/ask",
		json={
			"question": "病假需要在几天内补交证明？",
			"library_id": lib_id,
			"session_id": "persist-fail-session",
		},
	)
	assert response.status_code == 200
	payload = response.json()
	assert "三个工作日" in payload["answer"]
	assert payload["persisted"] is False
	assert payload["persist_error"] == "disk full"
