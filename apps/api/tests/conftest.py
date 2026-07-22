from __future__ import annotations

import pytest

from app.settings import get_settings


@pytest.fixture(autouse=True)
def force_stub_settings(monkeypatch: pytest.MonkeyPatch):
	"""Keep HTTP tests on stub even when developer .env is ASK_MODE=live."""
	monkeypatch.setenv("ASK_MODE", "stub")
	monkeypatch.setenv("DASHSCOPE_API_KEY", "")
	monkeypatch.setenv("OPENAI_API_KEY", "")
	get_settings.cache_clear()
	yield
	get_settings.cache_clear()
