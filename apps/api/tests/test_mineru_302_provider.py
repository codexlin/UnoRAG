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
	MinerUClientError,
	MinerUPendingError,
	classify_302_task_state,
	get_mineru_backend,
)
from app.lifecycle_worker import LifecycleWorker
from app.settings import Settings


def _response(
	payload: dict[str, Any] | None = None,
	*,
	status_code: int = 200,
	url: str = "https://api.302.ai/test",
	text: str | None = None,
	content: bytes | None = None,
	method: str = "GET",
) -> httpx.Response:
	request = httpx.Request(method, url)
	if content is not None:
		return httpx.Response(status_code, content=content, request=request)
	if text is not None:
		return httpx.Response(status_code, text=text, request=request)
	return httpx.Response(status_code, json=payload or {}, request=request)


def _result_zip(
	content_list: Any | None = None,
	*,
	name: str = "sample_content_list.json",
	raw_json: str | None = None,
) -> bytes:
	buffer = io.BytesIO()
	with zipfile.ZipFile(buffer, "w") as archive:
		if raw_json is not None:
			archive.writestr(name, raw_json)
		else:
			payload = (
				[{"type": "text", "text": "来自 302 的解析结果", "page_idx": 0}]
				if content_list is None
				else content_list
			)
			archive.writestr(name, json.dumps(payload, ensure_ascii=False))
	return buffer.getvalue()


@pytest.mark.parametrize(
	("status", "expected"),
	[
		("", "pending"),
		("PENDING", "pending"),
		("QUEUED", "pending"),
		("SUBMITTED", "pending"),
		("STARTED", "pending"),
		("started", "pending"),
		("RUNNING", "pending"),
		("PROCESSING", "pending"),
		("WAITING", "pending"),
		("IN_PROGRESS", "pending"),
		("SUCCESS", "success"),
		("SUCCEEDED", "success"),
		("COMPLETED", "success"),
		("DONE", "success"),
		("FAILED", "failed"),
		("ERROR", "failed"),
		("CANCELLED", "failed"),
	],
)
def test_classify_302_task_state(status: str, expected: str) -> None:
	assert classify_302_task_state(status) == expected


def test_302_started_poll_is_pending_not_service_error() -> None:
	"""Regression: live 302 returns STARTED; must not map to mineru_service_error."""
	states: list[dict[str, Any]] = []

	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		del method, url
		return _response({"state": "STARTED"})

	backend = Ai302MinerUBackend(
		base_url="https://api.302.ai",
		api_key="test-key",
		request_fn=request_fn,
		poll_interval_s=5,
	)
	with pytest.raises(MinerUPendingError) as exc_info:
		backend.parse(
			ParseRequest(
				content=b"%PDF",
				filename="sample.pdf",
				title="sample",
				provider_state={"provider": "302ai", "task_id": "task-started"},
				provider_state_callback=states.append,
			)
		)
	assert "STARTED" in str(exc_info.value)
	assert exc_info.value.code == "mineru_pending"
	assert exc_info.value.code != "mineru_service_error"
	assert states[-1]["state"] == "STARTED"
	assert states[-1]["task_id"] == "task-started"


def test_302_failed_poll_is_service_error() -> None:
	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		del method, url
		return _response({"state": "FAILED", "message": "upstream boom"})

	backend = Ai302MinerUBackend(
		base_url="https://api.302.ai",
		api_key="test-key",
		request_fn=request_fn,
	)
	with pytest.raises(MinerUClientError) as exc_info:
		backend.parse(
			ParseRequest(
				content=b"%PDF",
				filename="sample.pdf",
				title="sample",
				provider_state={"provider": "302ai", "task_id": "task-fail"},
			)
		)
	assert exc_info.value.code == "mineru_service_error"
	assert "upstream boom" in str(exc_info.value)


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


def test_302_poll_429_is_rate_limited_without_resubmit() -> None:
	"""429 on poll must surface as rate_limited and must not POST /task again."""
	calls: list[tuple[str, str]] = []

	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		calls.append((method, url))
		return _response(
			{"message": "too many requests"},
			status_code=429,
			url=url,
			method=method,
		)

	backend = Ai302MinerUBackend(
		base_url="https://api.302.ai",
		api_key="test-key",
		request_fn=request_fn,
	)
	with pytest.raises(MinerUClientError) as exc_info:
		backend.parse(
			ParseRequest(
				content=b"%PDF",
				filename="sample.pdf",
				title="sample",
				provider_state={"provider": "302ai", "task_id": "task-rate"},
			)
		)
	assert exc_info.value.code == "mineru_rate_limited"
	assert exc_info.value.retryable is True
	assert exc_info.value.status_code == 429
	assert all(method == "GET" for method, _url in calls)
	assert not any("/task" in url and method == "POST" for method, url in calls)


def test_302_submit_429_is_rate_limited_before_task_persisted() -> None:
	"""Submit 429 fails closed before task_id exists; no silent success."""
	states: list[dict[str, Any]] = []
	calls: list[tuple[str, str]] = []

	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		calls.append((method, url))
		if url.endswith("/302/upload-file"):
			return _response({"code": 200, "data": "https://file.example/source.pdf"})
		if method == "POST" and url.endswith("/302/v2/mineru/task"):
			return _response(
				{"message": "rate limited"},
				status_code=429,
				url=url,
				method=method,
			)
		raise AssertionError(f"unexpected call {method} {url}")

	backend = Ai302MinerUBackend(
		base_url="https://api.302.ai",
		api_key="test-key",
		request_fn=request_fn,
	)
	with pytest.raises(MinerUClientError) as exc_info:
		backend.parse(
			ParseRequest(
				content=b"%PDF",
				filename="sample.pdf",
				title="sample",
				provider_state_callback=states.append,
			)
		)
	assert exc_info.value.code == "mineru_rate_limited"
	assert exc_info.value.retryable is True
	assert states == []
	assert [method for method, _url in calls] == ["POST", "POST"]


@pytest.mark.parametrize(
	("status_code", "phase"),
	[
		(500, "poll"),
		(502, "poll"),
		(503, "submit"),
	],
)
def test_302_5xx_classified_as_service_error(status_code: int, phase: str) -> None:
	calls: list[tuple[str, str]] = []

	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		calls.append((method, url))
		if phase == "submit":
			if url.endswith("/302/upload-file"):
				return _response({"code": 200, "data": "https://file.example/source.pdf"})
			if method == "POST" and url.endswith("/302/v2/mineru/task"):
				return _response(
					{"message": "upstream down"},
					status_code=status_code,
					url=url,
					method=method,
				)
		else:
			return _response(
				{"message": "poll boom"},
				status_code=status_code,
				url=url,
				method=method,
			)
		raise AssertionError(f"unexpected call {method} {url}")

	backend = Ai302MinerUBackend(
		base_url="https://api.302.ai",
		api_key="test-key",
		request_fn=request_fn,
	)
	provider_state = (
		None
		if phase == "submit"
		else {"provider": "302ai", "task_id": "task-5xx"}
	)
	with pytest.raises(MinerUClientError) as exc_info:
		backend.parse(
			ParseRequest(
				content=b"%PDF",
				filename="sample.pdf",
				title="sample",
				provider_state=provider_state,
			)
		)
	assert exc_info.value.code == "mineru_service_error"
	assert exc_info.value.retryable is True
	assert exc_info.value.status_code == status_code
	assert not isinstance(exc_info.value, MinerUPendingError)
	if phase == "poll":
		assert all(method == "GET" for method, _url in calls)
		assert not any(method == "POST" for method, _url in calls)


def test_302_poll_deadline_timeout_after_persistent_started() -> None:
	"""Permanent STARTED/RUNNING until max_wait raises hard timeout (not success)."""
	states: list[dict[str, Any]] = []
	polls = 0

	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		nonlocal polls
		del method, url
		polls += 1
		return _response({"state": "STARTED"})

	backend = Ai302MinerUBackend(
		base_url="https://api.302.ai",
		api_key="test-key",
		request_fn=request_fn,
		poll_interval_s=5,
		max_wait_s=5,
	)
	with pytest.raises(MinerUClientError) as exc_info:
		backend.parse(
			ParseRequest(
				content=b"%PDF",
				filename="sample.pdf",
				title="sample",
				provider_state={
					"provider": "302ai",
					"task_id": "task-stuck",
					"poll_count": 0,
				},
				provider_state_callback=states.append,
			)
		)
	assert exc_info.value.code == "mineru_timeout"
	assert exc_info.value.retryable is False
	assert exc_info.value.timeout_kind == "hard"
	assert polls == 1
	assert states[-1]["task_id"] == "task-stuck"
	assert states[-1]["state"] == "STARTED"
	assert states[-1]["poll_count"] == 1


def test_302_invalid_zip_fails_without_ir() -> None:
	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		if url == "https://file.302.ai/result.zip":
			return _response(
				content=b"not-a-zip",
				url=url,
				method=method,
			)
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
	with pytest.raises(MinerUClientError) as exc_info:
		backend.parse(
			ParseRequest(
				content=b"%PDF",
				filename="sample.pdf",
				title="sample",
				provider_state={"provider": "302ai", "task_id": "task-bad-zip"},
			)
		)
	assert exc_info.value.code == "mineru_invalid_response"
	assert "ZIP" in str(exc_info.value)


@pytest.mark.parametrize(
	("raw_json", "match"),
	[
		("not-json", "ZIP is invalid"),
		('"just a string"', "content_list must be an array"),
		('{"content_list": "nope"}', "content_list must be an array"),
		("[]", "empty content_list"),
		('[{"type": "text", "text": "   "}]', "empty content_list"),
		('["not-a-dict", 42, null]', "empty content_list"),
	],
)
def test_302_malformed_content_list_fails_cleanly(raw_json: str, match: str) -> None:
	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		if url == "https://file.302.ai/result.zip":
			return _response(
				content=_result_zip(raw_json=raw_json),
				url=url,
				method=method,
			)
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
	with pytest.raises(MinerUClientError) as exc_info:
		backend.parse(
			ParseRequest(
				content=b"%PDF",
				filename="sample.pdf",
				title="sample",
				provider_state={"provider": "302ai", "task_id": "task-bad-cl"},
			)
		)
	assert exc_info.value.code == "mineru_invalid_response"
	assert match in str(exc_info.value)


def test_302_zip_missing_content_list_fails() -> None:
	buffer = io.BytesIO()
	with zipfile.ZipFile(buffer, "w") as archive:
		archive.writestr("readme.txt", "no content list here")

	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		if url == "https://file.302.ai/result.zip":
			return _response(content=buffer.getvalue(), url=url, method=method)
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
	with pytest.raises(MinerUClientError) as exc_info:
		backend.parse(
			ParseRequest(
				content=b"%PDF",
				filename="sample.pdf",
				title="sample",
				provider_state={"provider": "302ai", "task_id": "task-no-cl"},
			)
		)
	assert exc_info.value.code == "mineru_invalid_response"
	assert "no content_list" in str(exc_info.value)


def test_302_crash_after_submit_resumes_same_task_without_second_post() -> None:
	"""Worker crash mid-pending: resume with persisted task_id must not POST /task again."""
	calls: list[tuple[str, str]] = []
	states: list[dict[str, Any]] = []
	poll_phase = {"n": 0}

	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		calls.append((method, url))
		if url.endswith("/302/upload-file"):
			return _response({"code": 200, "data": "https://file.example/source.pdf"})
		if method == "POST" and url.endswith("/302/v2/mineru/task"):
			return _response({"task_id": "task-resume-1"})
		if url == "https://file.302.ai/result.zip":
			return _response(content=_result_zip(), url=url, method=method)
		poll_phase["n"] += 1
		if poll_phase["n"] == 1:
			return _response({"state": "RUNNING"})
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
		poll_interval_s=5,
	)

	# Attempt 1: submit + first poll → pending (simulate worker crash after lease release)
	with pytest.raises(MinerUPendingError):
		backend.parse(
			ParseRequest(
				content=b"%PDF",
				filename="sample.pdf",
				title="sample",
				provider_state_callback=states.append,
			)
		)
	saved = dict(states[-1])
	assert saved["task_id"] == "task-resume-1"
	task_posts = [
		(method, url)
		for method, url in calls
		if method == "POST" and url.endswith("/302/v2/mineru/task")
	]
	assert len(task_posts) == 1

	# Attempt 2: resume with same task_id — only poll/download, never second submit
	calls_before_resume = len(calls)
	ir = backend.parse(
		ParseRequest(
			content=b"%PDF",
			filename="sample.pdf",
			title="sample",
			provider_state=saved,
		)
	)
	resume_calls = calls[calls_before_resume:]
	assert ir.nodes[0].text == "来自 302 的解析结果"
	assert all(
		not (method == "POST" and url.endswith("/302/v2/mineru/task"))
		for method, url in resume_calls
	)
	assert [method for method, _url in resume_calls] == ["GET", "GET"]
	assert (
		len(
			[
				(method, url)
				for method, url in calls
				if method == "POST" and url.endswith("/302/v2/mineru/task")
			]
		)
		== 1
	)
