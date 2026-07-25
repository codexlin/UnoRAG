"""FastAPI ingest write paths are permanently gone (410); no env switch."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.main import app
from app.services.ingest.fastapi_ingest_writes import (
	LEGACY_INGEST_GONE_DETAIL,
	reject_fastapi_ingest_writes,
)
from tests.conftest import create_library

client = TestClient(app)


def test_reject_fastapi_ingest_writes_always_410() -> None:
	with pytest.raises(HTTPException) as exc:
		reject_fastapi_ingest_writes()
	assert exc.value.status_code == 410
	assert exc.value.detail["code"] == "legacy_ingest_writes_disabled"
	assert LEGACY_INGEST_GONE_DETAIL in str(exc.value.detail["message"])


def test_upload_always_returns_410() -> None:
	lib_id = create_library(client, library_id="lib-legacy-off")
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
	body = response.json()
	detail = body.get("detail") or {}
	assert detail.get("code") == "legacy_ingest_writes_disabled"
	assert LEGACY_INGEST_GONE_DETAIL in str(detail.get("message") or detail)


def test_ingest_text_replace_reindex_delete_always_410() -> None:
	lib_id = create_library(client, library_id="lib-gone-paths")
	assert (
		client.post(
			"/v1/ingest",
			json={"library_id": lib_id, "title": "t", "text": "hello"},
		).status_code
		== 410
	)
	assert client.post("/v1/documents/any-doc/reindex").status_code == 410
	assert (
		client.post(
			"/v1/documents/any-doc/replace",
			files={"file": ("a.md", b"# a", "text/markdown")},
		).status_code
		== 410
	)
	assert client.delete("/v1/documents/any-doc").status_code == 410
