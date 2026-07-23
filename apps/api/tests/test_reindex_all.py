"""reindex_all：异步 202 须轮询终态，不得把 processing 直接计成功。"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "reindex_all.py"


def _load_reindex_module():
	spec = importlib.util.spec_from_file_location("reindex_all_script", _SCRIPT)
	assert spec and spec.loader
	mod = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(mod)
	return mod


def test_reindex_async_202_polls_until_ready(monkeypatch: pytest.MonkeyPatch) -> None:
	mod = _load_reindex_module()
	doc_polls = {"n": 0}

	def fake_get(url: str):
		if url.endswith("/health"):
			return {"live_ready": True, "ask_ready": True}
		if url.endswith("/v1/libraries"):
			return [{"id": "lib-1"}]
		if "/libraries/lib-1/documents" in url:
			return [{"id": "doc-1", "name": "a.docx", "status": "ready"}]
		if url.endswith("/v1/documents/doc-1"):
			doc_polls["n"] += 1
			if doc_polls["n"] < 2:
				return {"id": "doc-1", "status": "processing"}
			return {"id": "doc-1", "status": "ready", "chunk_count": 3}
		raise AssertionError(url)

	def fake_post(url: str):
		assert url.endswith("/v1/documents/doc-1/reindex")
		return 202, {"status": "processing", "doc_id": "doc-1", "chunk_count": 0}

	monkeypatch.setattr(mod, "_get", fake_get)
	monkeypatch.setattr(mod, "_post", fake_post)
	monkeypatch.setattr(mod.time, "sleep", lambda _s: None)
	monkeypatch.setattr(
		sys,
		"argv",
		["reindex_all.py", "--base-url", "http://127.0.0.1:8000", "--poll-interval", "0.01"],
	)

	assert mod.main() == 0
	assert doc_polls["n"] >= 2


def test_reindex_async_eventual_failure_exits_nonzero(
	monkeypatch: pytest.MonkeyPatch,
) -> None:
	mod = _load_reindex_module()

	def fake_get(url: str):
		if url.endswith("/health"):
			return {"live_ready": True, "ask_ready": True}
		if url.endswith("/v1/libraries"):
			return [{"id": "lib-1"}]
		if "/libraries/lib-1/documents" in url:
			return [{"id": "doc-1", "name": "a.docx", "status": "ready"}]
		if url.endswith("/v1/documents/doc-1"):
			return {"id": "doc-1", "status": "failed", "error": "boom"}
		raise AssertionError(url)

	def fake_post(url: str):
		return 202, {"status": "processing", "doc_id": "doc-1"}

	monkeypatch.setattr(mod, "_get", fake_get)
	monkeypatch.setattr(mod, "_post", fake_post)
	monkeypatch.setattr(mod.time, "sleep", lambda _s: None)
	monkeypatch.setattr(
		sys,
		"argv",
		["reindex_all.py", "--base-url", "http://127.0.0.1:8000", "--poll-interval", "0.01"],
	)

	assert mod.main() == 1
