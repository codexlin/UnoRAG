from __future__ import annotations

import io
import json
import zipfile
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from app.services.ingest.backends.base import ParseRequest
from app.services.ingest.backends.mineru import (
	Ai302MinerUBackend,
	MinerUBackend,
	MinerUPendingError,
	get_mineru_backend,
)
from app.lifecycle_worker import LifecycleWorker
from app.settings import Settings


def _response(payload: dict[str, Any], *, url: str = "https://api.302.ai/test") -> httpx.Response:
	request = httpx.Request("GET", url)
	return httpx.Response(200, json=payload, request=request)


def _result_zip() -> bytes:
	buffer = io.BytesIO()
	with zipfile.ZipFile(buffer, "w") as archive:
		archive.writestr(
			"sample_content_list.json",
			json.dumps(
				[{"type": "text", "text": "来自 302 的解析结果", "page_idx": 0}],
				ensure_ascii=False,
			),
		)
	return buffer.getvalue()


def test_302_submit_persists_task_and_defers() -> None:
	calls: list[tuple[str, str]] = []
	states: list[dict[str, Any]] = []

	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		calls.append((method, url))
		if url.endswith("/302/upload-file"):
			return _response({"code": 200, "data": "https://file.example/source.pdf"})
		if method == "POST":
			return _response({"task_id": "task-1"})
		return _response({"state": "RUNNING"})

	backend = Ai302MinerUBackend(
		base_url="https://api.302.ai",
		api_key="test-key",
		request_fn=request_fn,
		poll_interval_s=7,
	)
	with pytest.raises(MinerUPendingError) as exc_info:
		backend.parse(
			ParseRequest(
				content=b"%PDF",
				filename="sample.pdf",
				title="sample",
				provider_state_callback=states.append,
			)
		)
	assert exc_info.value.retry_after_s == 7
	assert states[-1] == {
		"provider": "302ai",
		"task_id": "task-1",
		"state": "RUNNING",
		"poll_count": 1,
	}
	assert [method for method, _url in calls] == ["POST", "POST", "GET"]


def test_302_resume_does_not_upload_or_resubmit() -> None:
	calls: list[tuple[str, str]] = []

	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		calls.append((method, url))
		if url == "https://file.302.ai/result.zip":
			assert "Authorization" not in _kwargs["headers"]
			request = httpx.Request(method, url)
			return httpx.Response(200, content=_result_zip(), request=request)
		return _response(
			{
				"state": "SUCCESS",
				"result_url": "https://file.302.ai/result.zip",
			}
		)

	backend = Ai302MinerUBackend(
		base_url="https://api.302.ai",
		api_key="test-key",
		request_fn=request_fn,
	)
	ir = backend.parse(
		ParseRequest(
			content=b"%PDF",
			filename="sample.pdf",
			title="sample",
			provider_state={"provider": "302ai", "task_id": "task-1"},
		)
	)
	assert ir.nodes[0].text == "来自 302 的解析结果"
	assert ir.parser_report.metrics["mineru_provider"] == "302ai"
	assert ir.parser_report.metrics["mineru_external"] is True
	assert [method for method, _url in calls] == ["GET", "GET"]


def test_mineru_factory_keeps_legacy_self_hosted_contract() -> None:
	backend = get_mineru_backend(
		enabled=True,
		base_url="http://mineru:8000",
	)
	assert isinstance(backend, MinerUBackend)
	assert (
		get_mineru_backend(
			enabled=True,
			base_url="",
			provider="302ai",
			api_key_302="test-key",
			external_parser_allowed=False,
		)
		is None
	)


def test_production_302_requires_explicit_egress_and_secret() -> None:
	base = {
		"app_env": "production",
		"internal_auth_enabled": True,
		"internal_auth_secret": "a" * 40,
		"internal_auth_replay_backend": "redis",
		"document_storage_root": "/data",
		"database_url": "postgresql://app:pass@db/meriknow",
		"qdrant_url": "http://qdrant:6333",
		"redis_url": "redis://redis:6379",
		"openai_api_key": "real-enough-test-key",
		"active_generation_gate_enabled": True,
		"mineru_enabled": True,
		"mineru_provider": "302ai",
	}
	with pytest.raises(ValidationError, match="EXTERNAL_PARSER_ALLOWED"):
		Settings(**base)
	worker_settings = Settings(
		**base,
		external_parser_allowed=True,
		worker_database_url="postgresql://worker:pass@db/meriknow",
	)
	with pytest.raises(ValueError, match="MINERU_302_API_KEY"):
		LifecycleWorker(worker_settings)
	settings = Settings(
		**base,
		external_parser_allowed=True,
		mineru_302_api_key="temporary-test-key",
	)
	assert settings.redacted_effective_config()["mineru_provider"] == "302ai"
	assert "temporary-test-key" not in str(settings.redacted_effective_config())
