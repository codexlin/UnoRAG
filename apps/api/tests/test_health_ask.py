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
	assert ingest.status_code == 410
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
	# Default-temp: no thread_id → not durable; SessionMemory still holds short turns.
	assert payload["persisted"] is False
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
	settings = Settings(ask_mode="stub", max_retrieve_retries=0)

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
	result = service.ask(
		question="anything",
		library_id="lib-unit",
		ask_overrides={"answer_min_score": 0.5},
	)
	assert result.refused is True
	assert result.refuse_reason == "weak_match"


def test_retry_then_generate() -> None:
	settings = Settings(ask_mode="stub", max_retrieve_retries=1)
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
	from tests.support.seed import seed_ingest_text

	lib_id = create_library(client, library_id="lib-ingest-sim")
	payload = seed_ingest_text(
		library_id=lib_id,
		title="sample",
		text="病假须于返岗后三个工作日内补交证明材料。",
	)
	assert payload["status"] == "ready"
	assert payload["simulated"] is True
	assert payload["chunk_count"] >= 1
	assert payload["mode"] == "stub"

	libs = client.get("/v1/libraries")
	assert libs.status_code == 200
	row = next(item for item in libs.json() if item["id"] == lib_id)
	assert row["ready_count"] >= 1
	assert row["status"] == "ready"


def test_seed_ingest_503_when_simulate_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
	from tests.support.seed import SeedIngestError, seed_ingest_text

	lib_id = create_library(client, library_id="lib-ingest-nosim")
	monkeypatch.setenv("STUB_INGEST_SIMULATE", "false")
	get_settings.cache_clear()
	with pytest.raises(SeedIngestError) as exc:
		seed_ingest_text(
			library_id=lib_id,
			title="sample",
			text="病假须于返岗后三个工作日内补交证明材料。",
		)
	assert exc.value.http_status == 503
	get_settings.cache_clear()


def test_ask_temp_session_does_not_auto_archive() -> None:
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
	assert payload["persisted"] is False
	assert payload["citations"][0].get("text")

	archive = client.get("/v1/archive", params={"session_id": "archive-session-1"})
	assert archive.status_code == 200
	assert archive.json() == []


def test_ask_persist_failure_is_visible(monkeypatch: pytest.MonkeyPatch) -> None:
	from app.services.metadata import get_metadata_store
	from app.settings import get_settings

	lib_id = create_library(client, library_id="lib-ask-persist-fail")
	settings = get_settings()
	thread = get_metadata_store().create_thread(
		title="persist-fail",
		session_id="persist-fail-session",
		library_id=lib_id,
		tenant_id=settings.default_tenant_id,
		workspace_id=settings.default_workspace_id,
		principal_id="development",
	)

	def boom_persist(**_kwargs):
		return {"persisted": False, "persist_error": "disk full"}

	monkeypatch.setattr("app.graph.service.persist_turn", boom_persist)
	response = client.post(
		"/v1/ask",
		json={
			"question": "病假需要在几天内补交证明？",
			"library_id": lib_id,
			"session_id": "persist-fail-session",
			"thread_id": thread["id"],
		},
	)
	assert response.status_code == 200
	payload = response.json()
	assert "三个工作日" in payload["answer"]
	assert payload["persisted"] is False
	assert payload["persist_error"] == "disk full"


def test_iter_ask_events_passes_load_table_groups_fn(
	monkeypatch: pytest.MonkeyPatch,
) -> None:
	"""Stream path rebuilds the graph; must keep the same table-group loader as ask()."""
	from app.graph.builder import build_ask_graph as real_build

	settings = Settings(ask_mode="stub")

	class FakeRetrieval:
		last_debug: dict = {}

		def load_table_groups(self, **_kwargs):
			return []

	captured: dict[str, object] = {}

	def capture_build(**kwargs):
		captured["load_table_groups_fn"] = kwargs.get("load_table_groups_fn")
		return real_build(**kwargs)

	monkeypatch.setattr("app.graph.service.build_ask_graph", capture_build)

	service = AskGraphService(
		settings,
		retrieve_fn=lambda *_a, **_k: [],
		generate_fn=stub_generate,
		retrieval_service=FakeRetrieval(),
	)
	assert service._load_table_groups_fn is not None

	captured.clear()
	events = list(
		service.iter_ask_events(
			question="表格题？",
			library_id="lib-stream-loader",
			ask_overrides={"session_memory_enabled": False},
		)
	)
	assert events
	assert captured.get("load_table_groups_fn") is not None
	assert captured["load_table_groups_fn"] is service._load_table_groups_fn
