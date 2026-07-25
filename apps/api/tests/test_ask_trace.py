from __future__ import annotations

import hashlib
import json

from fastapi.testclient import TestClient

from app.main import app
from app.services.ask_trace import (
	STAGE_DETAIL_KEYS,
	append_stage,
	normalize_stage_detail,
	question_hash,
	resolve_trace_id,
)
from app.settings import Settings
from app.graph.ask_graph import AskGraphService, stub_generate
from tests.conftest import create_library

client = TestClient(app)

RETRIEVE_KEYS = STAGE_DETAIL_KEYS["retrieve"]
ROUTE_KEYS = STAGE_DETAIL_KEYS["route"]
ADJUDICATE_KEYS = STAGE_DETAIL_KEYS["adjudicate"]
GENERATE_KEYS = STAGE_DETAIL_KEYS["generate"]


def test_question_hash_is_sha256_prefix() -> None:
	q = "病假需要在几天内补交证明？"
	assert question_hash(q) == hashlib.sha256(q.encode("utf-8")).hexdigest()[:16]
	assert len(question_hash(q)) == 16


def test_resolve_trace_id_prefers_x_request_id() -> None:
	assert (
		resolve_trace_id(x_request_id="req-abc", request_id="internal-1") == "req-abc"
	)
	assert resolve_trace_id(x_request_id="", request_id="internal-1") == "internal-1"
	assert resolve_trace_id(x_request_id="development", request_id="development")
	generated = resolve_trace_id(x_request_id="development", request_id="development")
	assert generated != "development"
	assert len(generated) >= 8


def test_stage_detail_schema_keys_always_present() -> None:
	detail = normalize_stage_detail("retrieve", {"hit_count": 2})
	for key in RETRIEVE_KEYS:
		assert key in detail
	assert detail["hit_count"] == 2
	assert detail["top_score"] is None

	debug: dict = {"stages": []}
	append_stage(
		debug, name="adjudicate", duration_ms=1.2, detail={"decision": "keep"}
	)
	stage = debug["stages"][0]
	assert stage["stage"] == "adjudicate"
	assert stage["duration_ms"] == 1
	for key in ADJUDICATE_KEYS:
		assert key in stage["detail"]


def test_ask_stub_has_trace_id_question_hash_and_stages() -> None:
	from app.services.metadata import get_metadata_store
	from app.settings import get_settings

	lib_id = create_library(client, library_id="lib-ask-trace")
	settings = get_settings()
	thread = get_metadata_store().create_thread(
		title="trace",
		session_id="trace-sess-1",
		library_id=lib_id,
		tenant_id=settings.default_tenant_id,
		workspace_id=settings.default_workspace_id,
		principal_id="development",
	)
	question = "病假需要在几天内补交证明？"
	response = client.post(
		"/v1/ask",
		headers={"x-request-id": "trace-stub-001"},
		json={
			"question": question,
			"library_id": lib_id,
			"session_id": "trace-sess-1",
			"thread_id": thread["id"],
		},
	)
	assert response.status_code == 200
	payload = response.json()
	debug = payload["retrieval_debug"]
	assert debug["trace_id"] == "trace-stub-001"
	assert debug["question_hash"] == question_hash(question)
	assert isinstance(debug.get("total_duration_ms"), int)
	assert debug["total_duration_ms"] >= 0

	stages = debug.get("stages") or []
	assert stages
	names = [item["stage"] for item in stages]
	assert "route" in names
	assert "retrieve" in names
	# New emits use adjudicate; legacy stage name `gate` remains readable in STAGE_DETAIL_KEYS.
	assert "adjudicate" in names
	assert "generate" in names

	route = next(item for item in stages if item["stage"] == "route")
	for key in ROUTE_KEYS:
		assert key in route["detail"]

	retrieve = next(item for item in stages if item["stage"] == "retrieve")
	for key in RETRIEVE_KEYS:
		assert key in retrieve["detail"]
	assert retrieve["detail"]["hit_count"] is not None

	generate = next(item for item in stages if item["stage"] == "generate")
	for key in GENERATE_KEYS:
		assert key in generate["detail"]
	assert generate["detail"]["mode"] == "stub"
	assert generate["detail"]["input_tokens"] is None
	assert generate["detail"]["output_tokens"] is None

	# archived turn 落盘带完整 debug
	archive = client.get(
		"/v1/archive",
		params={"session_id": "trace-sess-1", "thread_id": thread["id"]},
	)
	assert archive.status_code == 200
	rows = archive.json()
	assert rows
	stored = rows[0]["retrieval_debug"]
	assert stored["trace_id"] == "trace-stub-001"
	assert stored["question_hash"] == question_hash(question)
	assert stored.get("stages")
	assert "total_duration_ms" in stored


def test_ask_emits_stdout_json_line(capsys) -> None:
	lib_id = create_library(client, library_id="lib-ask-trace-stdout")
	response = client.post(
		"/v1/ask",
		headers={"x-request-id": "trace-stdout-1"},
		json={"question": "病假几天？", "library_id": lib_id},
	)
	assert response.status_code == 200
	captured = capsys.readouterr().out
	lines = [line for line in captured.splitlines() if '"event": "ask.trace"' in line]
	assert lines, captured
	payload = json.loads(lines[-1])
	assert payload["event"] == "ask.trace"
	assert payload["trace_id"] == "trace-stdout-1"
	assert payload["question_hash"]
	assert isinstance(payload["stages"], list)
	assert "total_duration_ms" in payload


def test_stream_total_duration_only_on_done() -> None:
	lib_id = create_library(client, library_id="lib-ask-trace-stream")
	with client.stream(
		"POST",
		"/v1/ask/stream",
		headers={"x-request-id": "trace-stream-1"},
		json={"question": "病假需要在几天内补交证明？", "library_id": lib_id},
	) as response:
		assert response.status_code == 200
		events: list[tuple[str, dict]] = []
		event_name = ""
		for raw in response.iter_lines():
			if not raw:
				continue
			if raw.startswith("event:"):
				event_name = raw.split(":", 1)[1].strip()
			elif raw.startswith("data:"):
				data = json.loads(raw.split(":", 1)[1].strip())
				events.append((event_name, data))

	assert events
	meta = next(data for name, data in events if name == "meta")
	assert meta["trace_id"] == "trace-stream-1"
	assert "total_duration_ms" not in meta

	done = next(data for name, data in events if name == "done")
	assert done["trace_id"] == "trace-stream-1"
	debug = done["retrieval_debug"]
	assert debug["trace_id"] == "trace-stream-1"
	assert isinstance(debug.get("total_duration_ms"), int)
	assert debug["total_duration_ms"] >= 0
	assert not debug.get("truncated")
	names = [item["stage"] for item in debug.get("stages") or []]
	assert "route" in names
	assert "retrieve" in names
	assert "generate" in names


def test_stream_disconnect_marks_truncated() -> None:
	from app.services.metadata import get_metadata_store

	settings = Settings(ask_mode="stub")
	service = AskGraphService(
		settings,
		generate_fn=stub_generate,
	)
	thread = get_metadata_store().create_thread(
		title="disconnect",
		session_id="disconnect-sess",
		library_id="lib-disconnect",
		tenant_id=service.access_scope.tenant_id,
		workspace_id=service.access_scope.workspace_id,
		principal_id=service.access_scope.principal_id,
	)
	gen = service.iter_ask_events(
		question="病假需要在几天内补交证明？",
		library_id="lib-disconnect",
		thread_id=thread["id"],
		trace_id="trace-disconnect-1",
		ask_overrides={"session_memory_enabled": False},
	)
	first = next(gen)
	assert first["event"] == "meta"
	# 模拟客户端断连：关闭生成器触发 GeneratorExit → truncated 落盘
	gen.close()

	rows = get_metadata_store().list_turns(
		library_id="lib-disconnect",
		thread_id=thread["id"],
		tenant_id=service.access_scope.tenant_id,
		workspace_id=service.access_scope.workspace_id,
		principal_id=service.access_scope.principal_id,
		limit=5,
	)
	assert rows
	debug = rows[0].get("retrieval_debug") or {}
	assert debug.get("truncated") is True
	assert debug.get("trace_id") == "trace-disconnect-1"
	assert isinstance(debug.get("total_duration_ms"), int)
