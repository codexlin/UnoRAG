from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.services.metadata import get_metadata_store
from tests.conftest import create_library

client = TestClient(app)


def _scope_ids():
	from app.settings import get_settings

	settings = get_settings()
	return (
		settings.default_tenant_id,
		settings.default_workspace_id,
		"development",
	)


def test_ask_without_thread_does_not_persist() -> None:
	lib_id = create_library(client, library_id="lib-temp-no-persist")
	response = client.post(
		"/v1/ask",
		json={
			"question": "病假需要在几天内补交证明？",
			"library_id": lib_id,
			"session_id": "temp-session-1",
		},
	)
	assert response.status_code == 200
	payload = response.json()
	assert payload["persisted"] is False
	assert payload.get("thread_id") in (None, "")
	assert payload["citations"]

	archive = client.get("/v1/archive", params={"session_id": "temp-session-1"})
	assert archive.status_code == 200
	assert archive.json() == []

	threads = client.get("/v1/threads")
	assert threads.status_code == 200
	assert threads.json() == []


def test_archive_then_continue_persists_new_turns() -> None:
	lib_id = create_library(client, library_id="lib-thread-continue")
	ask = client.post(
		"/v1/ask",
		json={
			"question": "病假需要在几天内补交证明？",
			"library_id": lib_id,
			"session_id": "arch-sess-1",
		},
	)
	assert ask.status_code == 200
	body = ask.json()

	archived = client.post(
		"/v1/threads",
		json={
			"session_id": "arch-sess-1",
			"library_id": lib_id,
			"title": "病假问答",
			"turns": [
				{
					"question": body["question"],
					"answer": body["answer"],
					"citations": body["citations"],
					"mode": body["mode"],
					"refused": body["refused"],
				}
			],
		},
	)
	assert archived.status_code == 200
	thread = archived.json()
	thread_id = thread["id"]
	assert thread["title"] == "病假问答"
	assert thread["turn_count"] == 1
	assert len(thread["turns"]) == 1

	listed = client.get("/v1/threads")
	assert listed.status_code == 200
	ids = {item["id"] for item in listed.json()}
	assert thread_id in ids

	cont = client.post(f"/v1/threads/{thread_id}/continue")
	assert cont.status_code == 200
	assert cont.json()["id"] == thread_id

	follow = client.post(
		"/v1/ask",
		json={
			"question": "那事假呢？",
			"library_id": lib_id,
			"session_id": "arch-sess-1",
			"thread_id": thread_id,
		},
	)
	assert follow.status_code == 200
	follow_body = follow.json()
	assert follow_body["persisted"] is True
	assert follow_body["thread_id"] == thread_id

	detail = client.get(f"/v1/threads/{thread_id}")
	assert detail.status_code == 200
	turns = detail.json()["turns"]
	assert len(turns) == 2
	assert turns[-1]["question"] == "那事假呢？"


def test_threads_are_isolated_by_principal() -> None:
	lib_id = create_library(client, library_id="lib-thread-isolate")
	tenant_id, workspace_id, _ = _scope_ids()
	store = get_metadata_store()

	mine = store.create_thread(
		title="我的会话",
		session_id="mine-sess",
		library_id=lib_id,
		tenant_id=tenant_id,
		workspace_id=workspace_id,
		principal_id="development",
	)
	store.create_turn(
		session_id="mine-sess",
		thread_id=mine["id"],
		library_id=lib_id,
		question="我的问题",
		answer="我的答案",
		citations=[],
		mode="stub",
		tenant_id=tenant_id,
		workspace_id=workspace_id,
		principal_id="development",
	)
	other = store.create_thread(
		title="别人的会话",
		session_id="other-sess",
		library_id=lib_id,
		tenant_id=tenant_id,
		workspace_id=workspace_id,
		principal_id="other-user",
	)
	store.create_turn(
		session_id="other-sess",
		thread_id=other["id"],
		library_id=lib_id,
		question="别人的问题",
		answer="别人的答案",
		citations=[],
		mode="stub",
		tenant_id=tenant_id,
		workspace_id=workspace_id,
		principal_id="other-user",
	)

	listed = client.get("/v1/threads")
	assert listed.status_code == 200
	ids = {item["id"] for item in listed.json()}
	assert mine["id"] in ids
	assert other["id"] not in ids

	forbidden = client.get(f"/v1/threads/{other['id']}")
	assert forbidden.status_code == 404


def test_ask_unknown_thread_returns_404() -> None:
	lib_id = create_library(client, library_id="lib-thread-404")
	response = client.post(
		"/v1/ask",
		json={
			"question": "病假几天？",
			"library_id": lib_id,
			"thread_id": "does-not-exist",
		},
	)
	assert response.status_code == 404
	assert response.json()["detail"] == "thread not found"
