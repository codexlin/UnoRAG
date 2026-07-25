from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.services.metadata import reset_metadata_store
from app.settings import get_settings


@pytest.fixture(autouse=True)
def force_stub_settings(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
	"""Isolate tests: stub ask mode + explicit JSON metadata (test-only)."""
	monkeypatch.setenv("ASK_MODE", "stub")
	monkeypatch.setenv("DASHSCOPE_API_KEY", "")
	monkeypatch.setenv("OPENAI_API_KEY", "")
	# Unit tests hit FastAPI without BFF HMAC headers.
	monkeypatch.setenv("INTERNAL_AUTH_ENABLED", "false")
	# Explicit escape hatch — production/dev must use Postgres.
	monkeypatch.setenv("METADATA_BACKEND", "json")
	monkeypatch.setenv("DATABASE_URL", "")
	monkeypatch.setenv("METADATA_PATH", str(tmp_path / "metadata.json"))
	monkeypatch.setenv("DOCUMENT_STORAGE_DIR", str(tmp_path / "documents"))
	monkeypatch.setenv("STUB_INGEST_SIMULATE", "true")
	get_settings.cache_clear()
	reset_metadata_store()
	yield
	get_settings.cache_clear()
	reset_metadata_store()


def create_library(
	client: TestClient,
	*,
	name: str = "测试知识库",
	library_id: str = "lib-test",
) -> str:
	"""通过正式 API 建库，与产品用法一致。"""
	response = client.post(
		"/v1/libraries",
		json={"name": name, "library_id": library_id},
	)
	assert response.status_code == 200, response.text
	return str(response.json()["id"])
