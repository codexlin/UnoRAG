from __future__ import annotations

from pathlib import Path

import pytest

from app.services.metadata import reset_metadata_store
from app.settings import get_settings


@pytest.fixture(autouse=True)
def force_stub_settings(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
	"""Isolate tests: stub ask mode + explicit JSON metadata (test-only)."""
	monkeypatch.setenv("ASK_MODE", "stub")
	monkeypatch.setenv("DASHSCOPE_API_KEY", "")
	monkeypatch.setenv("OPENAI_API_KEY", "")
	# Explicit escape hatch — production/dev must use Postgres.
	monkeypatch.setenv("METADATA_BACKEND", "json")
	monkeypatch.setenv("DATABASE_URL", "")
	monkeypatch.setenv("METADATA_PATH", str(tmp_path / "metadata.json"))
	monkeypatch.setenv("STUB_INGEST_SIMULATE", "true")
	monkeypatch.setenv("HYBRID_ENABLED", "false")
	get_settings.cache_clear()
	reset_metadata_store()
	yield
	get_settings.cache_clear()
	reset_metadata_store()
