from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.services.ask_trace import question_hash, sanitize_retrieval_debug
from app.services.metadata import get_metadata_store
from tests.conftest import create_library

client = TestClient(app)


def test_sanitize_retrieval_debug_strips_private_and_secrets() -> None:
	raw = {
		"trace_id": "t1",
		"citation_adjudication": {"mode": "semantic_floor", "enabled": True},
		"stages": [
			{
				"stage": "adjudicate",
				"duration_ms": 2,
				"ok": True,
				"detail": {
					"decision": "keep",
					"decision_reason": None,
					"upgrade_to": None,
					"_internal_note": "drop-me",
				},
			}
		],
		"table_execution": {
			"matched_count": 3,
			"_evidence_row_indices": [1, 2, 3, 4],
			"matched_rows": [{"a": 1}],
		},
		"api_key": "sk-should-never-leak",
		"dashscope_api_key": "sk-also-leak",
		"authorization": "Bearer x",
		"nested": {"password": "p", "ok": True},
	}
	clean = sanitize_retrieval_debug(raw)
	assert clean is not None
	assert clean["trace_id"] == "t1"
	assert clean["citation_adjudication"]["mode"] == "semantic_floor"
	assert clean["stages"][0]["stage"] == "adjudicate"
	assert "_internal_note" not in clean["stages"][0]["detail"]
	assert "_evidence_row_indices" not in clean["table_execution"]
	assert clean["table_execution"]["matched_count"] == 3
	assert "api_key" not in clean
	assert "dashscope_api_key" not in clean
	assert "authorization" not in clean
	assert "password" not in clean["nested"]
	assert clean["nested"]["ok"] is True


def test_sanitize_retrieval_debug_none() -> None:
	assert sanitize_retrieval_debug(None) is None
	assert sanitize_retrieval_debug("bad") is None  # type: ignore[arg-type]


def test_archive_debug_endpoint_exposes_adjudicate_fields() -> None:
	lib_id = create_library(client, library_id="lib-archive-debug")
	question = "病假需要在几天内补交证明？"
	ask = client.post(
		"/v1/ask",
		headers={"x-request-id": "archive-debug-trace-1"},
		json={
			"question": question,
			"library_id": lib_id,
			"session_id": "archive-debug-sess",
		},
	)
	assert ask.status_code == 200
	ask_debug = ask.json()["retrieval_debug"]
	assert ask_debug["trace_id"] == "archive-debug-trace-1"

	listed = client.get("/v1/archive", params={"session_id": "archive-debug-sess"})
	assert listed.status_code == 200
	rows = listed.json()
	assert rows
	turn_id = rows[0]["id"]
	# List/detail share sanitized same-origin debug as Ask done payload.
	listed_debug = rows[0]["retrieval_debug"]
	assert listed_debug["trace_id"] == "archive-debug-trace-1"
	assert listed_debug["question_hash"] == question_hash(question)
	stage_names = [item["stage"] for item in listed_debug.get("stages") or []]
	assert "adjudicate" in stage_names
	assert "retrieve" in stage_names

	detail = client.get(f"/v1/archive/{turn_id}")
	assert detail.status_code == 200
	assert detail.json()["retrieval_debug"]["trace_id"] == "archive-debug-trace-1"

	debug_resp = client.get(f"/v1/archive/{turn_id}/debug")
	assert debug_resp.status_code == 200
	body = debug_resp.json()
	assert body["turn_id"] == turn_id
	assert body["session_id"] == "archive-debug-sess"
	assert body["library_id"] == lib_id
	assert body["trace_id"] == "archive-debug-trace-1"
	assert body["question_hash"] == question_hash(question)
	debug = body["retrieval_debug"]
	assert debug["trace_id"] == "archive-debug-trace-1"
	names = [item["stage"] for item in debug.get("stages") or []]
	assert "adjudicate" in names
	adjudicate = next(item for item in debug["stages"] if item["stage"] == "adjudicate")
	assert "decision" in adjudicate["detail"]
	# Ask stub path still records citation_adjudication when retrieve ran.
	assert "citation_adjudication" in debug or "candidates_count" in debug


def test_archive_debug_sanitizes_persisted_private_keys() -> None:
	from app.settings import get_settings

	settings = get_settings()
	store = get_metadata_store()
	row = store.create_turn(
		session_id="sanitize-sess",
		library_id="lib-archive-sanitize",
		question="病假几天？",
		answer="三个工作日",
		citations=[],
		mode="stub",
		tenant_id=settings.default_tenant_id,
		workspace_id=settings.default_workspace_id,
		principal_id="development",
		retrieval_debug={
			"trace_id": "sanitize-trace",
			"question_hash": "abcd",
			"api_key": "sk-leak",
			"stages": [{"stage": "adjudicate", "duration_ms": 1, "ok": True, "detail": {}}],
			"table_execution": {
				"matched_count": 1,
				"_evidence_row_indices": [9, 8, 7],
			},
		},
	)
	turn_id = row["id"]

	debug_body = client.get(f"/v1/archive/{turn_id}/debug").json()
	debug = debug_body["retrieval_debug"]
	assert debug["trace_id"] == "sanitize-trace"
	assert "api_key" not in debug
	assert "_evidence_row_indices" not in (debug.get("table_execution") or {})
	assert (debug.get("table_execution") or {}).get("matched_count") == 1

	listed = client.get("/v1/archive", params={"session_id": "sanitize-sess"}).json()
	assert listed
	assert "api_key" not in listed[0]["retrieval_debug"]


def test_archive_debug_404_for_unknown_turn() -> None:
	response = client.get("/v1/archive/does-not-exist/debug")
	assert response.status_code == 404
	assert response.json()["detail"] == "turn not found"
