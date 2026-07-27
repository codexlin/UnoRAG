"""P1: 302 MinerU observability — redaction, budget gate, event/counters."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from app.services.ingest.backends.base import ParseRequest
from app.services.ingest.backends.mineru import (
	Ai302MinerUBackend,
	MinerUClientError,
	MinerUPendingError,
)
from app.services.ingest.backends.mineru_observability import (
	DailyBudgetLedger,
	build_cost_metrics,
	estimate_parse_cost,
	get_budget_ledger,
	redact_metrics_task_ids,
	redact_provider_task_id,
	reset_observability_state,
	snapshot_counters,
)


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


@pytest.fixture(autouse=True)
def _reset_obs() -> None:
	reset_observability_state()
	yield
	reset_observability_state()


@pytest.mark.parametrize(
	("raw", "expected"),
	[
		("", None),
		(None, None),
		("abcd", "…"),
		("abcdefgh", "ab…gh"),
		("task-stuck", "ta…ck"),
		("0123456789abcdef0123", "01234567…0123"),
	],
)
def test_redact_provider_task_id(raw: str | None, expected: str | None) -> None:
	assert redact_provider_task_id(raw) == expected


def test_redact_metrics_and_public_parser_report() -> None:
	metrics = redact_metrics_task_ids(
		{"mineru_task_id": "0123456789abcdef0123", "other": 1}
	)
	assert metrics["mineru_task_id"] == "01234567…0123"
	assert metrics["other"] == 1
	from app.services.ingest.ir import ParserReport

	report = ParserReport(
		metrics={"mineru_task_id": "abcdefghijklmnop", "ok": True}
	)
	public = report.to_public_dict()
	assert public["metrics"]["mineru_task_id"] == "abcdefgh…mnop"
	assert "abcdefghijklmnop" not in json.dumps(public)


def test_estimate_parse_cost() -> None:
	assert estimate_parse_cost(10, cost_per_page=0.02) == 0.2
	assert estimate_parse_cost(None) is None
	assert build_cost_metrics(page_count=5, cost_per_page=0.01)[
		"mineru_estimated_cost"
	] == 0.05


def test_budget_gate_fail_closed_before_upload() -> None:
	calls: list[tuple[str, str]] = []

	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		calls.append((method, url))
		raise AssertionError("budget gate must not call provider")

	ledger = get_budget_ledger()
	ledger.configure(daily_budget=0.01, warn_ratio=0.8)
	ledger.record_spend(0.01)

	backend = Ai302MinerUBackend(
		base_url="https://api.302.ai",
		api_key="test-key",
		request_fn=request_fn,
		cost_per_page=0.02,
		daily_budget=0.01,
	)
	with pytest.raises(MinerUClientError) as exc_info:
		backend.parse(
			ParseRequest(
				content=b"%PDF-1.4 fake",
				filename="sample.pdf",
				title="sample",
				job_id="job-budget",
				doc_id="doc-1",
			)
		)
	assert exc_info.value.code == "mineru_budget_exceeded"
	assert exc_info.value.retryable is False
	assert calls == []
	assert snapshot_counters().get("mineru_302_budget_exceeded", 0) >= 1


def test_budget_disabled_when_zero() -> None:
	ledger = DailyBudgetLedger(daily_budget=0.0)
	ledger.check_can_submit(999.0)  # must not raise


def test_success_emits_complete_and_redacts_task_id(
	monkeypatch: pytest.MonkeyPatch,
	capsys: pytest.CaptureFixture[str],
) -> None:
	import io
	import zipfile

	buffer = io.BytesIO()
	with zipfile.ZipFile(buffer, "w") as archive:
		archive.writestr(
			"sample_content_list.json",
			json.dumps(
				[{"type": "text", "text": "ok", "page_idx": 0}],
				ensure_ascii=False,
			),
		)
	zip_bytes = buffer.getvalue()

	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		if url == "https://file.302.ai/result.zip":
			return _response(content=zip_bytes, url=url, method=method)
		return _response(
			{
				"state": "SUCCESS",
				"result_url": "https://file.302.ai/result.zip",
			}
		)

	# Avoid fitz page-count noise on tiny fake PDF.
	monkeypatch.setattr(
		"app.services.ingest.backends.mineru.estimate_pdf_page_count",
		lambda _content: 3,
	)

	backend = Ai302MinerUBackend(
		base_url="https://api.302.ai",
		api_key="test-key",
		request_fn=request_fn,
		cost_per_page=0.02,
	)
	full_id = "abcd1234wxyz5678task"
	ir = backend.parse(
		ParseRequest(
			content=b"%PDF",
			filename="sample.pdf",
			title="sample",
			job_id="job-1",
			doc_id="doc-1",
			trace_id="trace-1",
			provider_state={"provider": "302ai", "task_id": full_id},
		)
	)
	redacted = redact_provider_task_id(full_id)
	assert ir.parser_report.metrics["mineru_task_id"] == redacted
	assert full_id not in str(ir.parser_report.metrics["mineru_task_id"])
	assert ir.parser_report.metrics["mineru_page_count"] == 1  # from content_list
	assert ir.parser_report.metrics["mineru_estimated_cost"] == 0.02
	assert snapshot_counters().get("mineru_302_complete", 0) >= 1

	out = capsys.readouterr().out
	assert "mineru.302.complete" in out
	assert full_id not in out
	assert redacted in out or "provider_task_id" in out
	assert "trace-1" in out
	assert "job-1" in out


def test_429_increments_counter_and_emits_fail(
	capsys: pytest.CaptureFixture[str],
) -> None:
	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
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
				provider_state={"provider": "302ai", "task_id": "task-rate-limit-xx"},
			)
		)
	assert exc_info.value.code == "mineru_rate_limited"
	assert snapshot_counters().get("mineru_302_429", 0) >= 1
	assert snapshot_counters().get("mineru_302_fail", 0) >= 1
	assert "mineru.302.fail" in capsys.readouterr().out


def test_timeout_increments_timeout_counter() -> None:
	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		del method, url
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
					"task_id": "task-timeout-abcdef",
					"poll_count": 0,
				},
			)
		)
	assert exc_info.value.code == "mineru_timeout"
	assert snapshot_counters().get("mineru_302_timeout", 0) >= 1
	# Exception message must not leak full task id when long enough to redact.
	assert "task-timeout-abcdef" not in str(exc_info.value)


def test_invalid_result_increments_invalid_counter() -> None:
	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		if url == "https://file.302.ai/result.zip":
			return _response(content=b"not-a-zip", url=url, method=method)
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
				provider_state={"provider": "302ai", "task_id": "task-bad-zip-xxxx"},
			)
		)
	assert exc_info.value.code == "mineru_invalid_response"
	assert snapshot_counters().get("mineru_302_invalid_result", 0) >= 1


def test_pending_emits_event_and_long_pending_warning(
	capsys: pytest.CaptureFixture[str],
) -> None:
	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		del method, url
		return _response({"state": "STARTED"})

	backend = Ai302MinerUBackend(
		base_url="https://api.302.ai",
		api_key="test-key",
		request_fn=request_fn,
		poll_interval_s=5,
		max_wait_s=900,
		long_pending_s=5,
	)
	states: list[dict[str, Any]] = []
	with pytest.raises(MinerUPendingError):
		backend.parse(
			ParseRequest(
				content=b"%PDF",
				filename="sample.pdf",
				title="sample",
				provider_state={
					"provider": "302ai",
					"task_id": "task-pending-long01",
					"poll_count": 0,
				},
				provider_state_callback=states.append,
			)
		)
	out = capsys.readouterr().out
	assert "mineru.302.pending" in out
	assert "mineru.302.long_pending" in out
	assert snapshot_counters().get("mineru_302_pending", 0) >= 1
	assert states[-1].get("long_pending_warned") is True


def test_duplicate_submit_warning_when_prior_state_without_task_id(
	monkeypatch: pytest.MonkeyPatch,
	capsys: pytest.CaptureFixture[str],
) -> None:
	monkeypatch.setattr(
		"app.services.ingest.backends.mineru.estimate_pdf_page_count",
		lambda _content: 1,
	)

	def request_fn(method: str, url: str, **_kwargs: Any) -> httpx.Response:
		if url.endswith("/302/upload-file"):
			return _response({"code": 200, "data": "https://file.example/a.pdf"})
		if method == "POST" and url.endswith("/302/v2/mineru/task"):
			return _response({"task_id": "new-task-id-abcdef12"})
		return _response({"state": "STARTED"})

	backend = Ai302MinerUBackend(
		base_url="https://api.302.ai",
		api_key="test-key",
		request_fn=request_fn,
		daily_budget=0,
	)
	with pytest.raises(MinerUPendingError):
		backend.parse(
			ParseRequest(
				content=b"%PDF",
				filename="sample.pdf",
				title="sample",
				# Inconsistent: prior RUNNING but task_id cleared → duplicate risk.
				provider_state={"provider": "302ai", "state": "RUNNING"},
			)
		)
	assert "mineru.302.duplicate_submit" in capsys.readouterr().out
	assert snapshot_counters().get("mineru_302_duplicate_submit", 0) >= 1
