"""MinerU 独立服务客户端：timeout / retry / 显式失败；禁止静默空文档。

环境变量见 Settings：MINERU_ENABLED / MINERU_URL / MINERU_TIMEOUT_S /
MINERU_SOFT_TIMEOUT_S / MINERU_MAX_RETRIES。
本地无服务时用 FakeMinerUBackend 跑单测；指向真实服务时设 MINERU_URL。
"""

from __future__ import annotations

import io
import json
import logging
import queue
import threading
import time
import zipfile
from typing import Any, Callable
from urllib.parse import urlparse

import httpx

from app.services.ingest.adapters.mineru_ir import mineru_json_to_ir
from app.services.ingest.backends.base import ParseRequest
from app.services.ingest.backends.mineru_observability import (
	BudgetExceededError,
	build_cost_metrics,
	classify_error_metric,
	correlation_fields,
	emit_mineru_event,
	estimate_parse_cost,
	estimate_pdf_page_count,
	get_budget_ledger,
	incr,
	note_failure_for_spike,
	page_count_from_content_list,
	redact_provider_task_id,
)
from app.services.ingest.ir import DocumentIR

logger = logging.getLogger(__name__)

DEFAULT_MINERU_VERSION = "2.x"
# Soft timeout / 429：不在客户端内重试，立刻上抛以便 job 还槽 + 退避。
_NO_INLINE_RETRY_CODES = frozenset({"mineru_soft_timeout", "mineru_rate_limited"})
# 302.AI async poll: only true terminal failure falls through to service_error.
# Live 302 returns STARTED while work is in flight (see lifecycle E2E 2026-07-27).
_AI302_IN_PROGRESS_STATES = frozenset(
	{
		"",
		"PENDING",
		"QUEUED",
		"SUBMITTED",
		"STARTED",
		"RUNNING",
		"PROCESSING",
		"WAITING",
		"IN_PROGRESS",
	}
)
_AI302_SUCCESS_STATES = frozenset(
	{"SUCCESS", "SUCCEEDED", "COMPLETED", "DONE"}
)
# Fake 默认 OCR 文案：与 leave-scanned 语义对齐（扫描请假制度）
_FAKE_SCANNED_TEXT = (
	"病假须于返岗后三个工作日内补交证明材料。"
	"逾期未交按事假处理。"
)


def classify_302_task_state(status: str) -> str:
	"""Map a 302 poll `state`/`status` to pending | success | failed."""
	normalized = str(status or "").strip().upper()
	if normalized in _AI302_IN_PROGRESS_STATES:
		return "pending"
	if normalized in _AI302_SUCCESS_STATES:
		return "success"
	return "failed"


class MinerUClientError(RuntimeError, ValueError):
	"""MinerU 服务调用失败（超时 / HTTP / 空结果）。"""

	def __init__(
		self,
		message: str,
		*,
		code: str = "mineru_unavailable",
		retryable: bool = True,
		status_code: int | None = None,
		parser_report: dict[str, Any] | None = None,
		timeout_kind: str | None = None,
	) -> None:
		super().__init__(message)
		self.code = code
		self.retryable = retryable
		self.status_code = status_code
		self.parser_report = parser_report
		self.timeout_kind = timeout_kind


class MinerUPendingError(MinerUClientError):
	"""External MinerU task is still running; release the worker lease and poll later."""

	def __init__(self, message: str, *, retry_after_s: float) -> None:
		super().__init__(
			message,
			code="mineru_pending",
			retryable=True,
		)
		self.retry_after_s = max(1.0, float(retry_after_s))


def _post_multipart(
	url: str,
	*,
	filename: str,
	content: bytes,
	timeout_s: float,
	extra_fields: dict[str, str] | None = None,
) -> bytes:
	"""按官方 mineru-api 契约上传单个文件并要求 JSON content_list。"""
	fields = {
		"return_content_list": "true",
		"response_format_zip": "false",
		**(extra_fields or {}),
	}
	try:
		response = httpx.post(
			url,
			data=fields,
			files={"files": (filename, content, "application/pdf")},
			headers={"Accept": "application/json"},
			timeout=timeout_s,
		)
		response.raise_for_status()
		return response.content
	except httpx.TimeoutException as exc:
		raise MinerUClientError(
			f"MinerU hard timeout after {timeout_s}s",
			code="mineru_timeout",
			timeout_kind="hard",
		) from exc
	except httpx.HTTPStatusError as exc:
		status = exc.response.status_code
		detail = exc.response.text[:500]
		if status == 429:
			code = "mineru_rate_limited"
			retryable = True
		elif status == 408:
			code = "mineru_timeout"
			retryable = True
		elif status >= 500:
			code = "mineru_service_error"
			retryable = True
		else:
			code = "mineru_request_rejected"
			retryable = False
		raise MinerUClientError(
			f"MinerU HTTP {status}: {detail}",
			code=code,
			retryable=retryable,
			status_code=status,
			timeout_kind="hard" if code == "mineru_timeout" else None,
		) from exc
	except httpx.RequestError as exc:
		# Connection refused / DNS / reset：服务未开或不可达，fail-closed 不重试。
		# auto 路由在已有 PyMuPDF 节点时会 degrade；无节点则 job 直接 failed。
		raise MinerUClientError(
			f"MinerU unreachable: {exc}",
			code="mineru_unreachable",
			retryable=False,
		) from exc


class MinerUBackend:
	"""HTTP 调用独立 MinerU 服务，再经 content_list → DocumentIR。"""

	def __init__(
		self,
		*,
		base_url: str,
		timeout_s: float = 120.0,
		soft_timeout_s: float = 0.0,
		max_retries: int = 2,
		parse_path: str = "/file_parse",
		version: str = DEFAULT_MINERU_VERSION,
		post_fn: Callable[..., bytes] | None = None,
	) -> None:
		self.base_url = base_url.rstrip("/")
		self.timeout_s = timeout_s
		self.soft_timeout_s = float(soft_timeout_s)
		self.max_retries = max(0, int(max_retries))
		self.parse_path = parse_path if parse_path.startswith("/") else f"/{parse_path}"
		self._version = version
		self._post_fn = post_fn or _post_multipart

	@property
	def name(self) -> str:
		return "mineru"

	@property
	def version(self) -> str:
		return self._version

	def parse(self, request: ParseRequest) -> DocumentIR:
		url = f"{self.base_url}{self.parse_path}"
		last_exc: Exception | None = None
		attempts = self.max_retries + 1
		t0 = time.perf_counter()
		raw: bytes | None = None
		for attempt in range(1, attempts + 1):
			if request.cancel_check is not None:
				request.cancel_check()
			try:
				if request.progress_callback is not None:
					request.progress_callback("mineru_request", None, None)
				raw = _post_with_cancel(
					self._post_fn,
					cancel_check=request.cancel_check,
					soft_timeout_s=self.soft_timeout_s,
					url=url,
					filename=request.filename,
					content=request.content,
					timeout_s=self.timeout_s,
				)
				break
			except MinerUClientError as exc:
				last_exc = exc
				logger.warning(
					"mineru.parse.retry attempt=%s/%s err=%s code=%s "
					"timeout_kind=%s",
					attempt,
					attempts,
					exc,
					exc.code,
					exc.timeout_kind,
				)
				if (
					not exc.retryable
					or attempt >= attempts
					or exc.code in _NO_INLINE_RETRY_CODES
				):
					raise
				_sleep_with_cancel(
					min(0.5 * attempt, 2.0),
					request.cancel_check,
				)
		if raw is None:
			raise MinerUClientError(str(last_exc or "MinerU request failed"))
		if request.cancel_check is not None:
			request.cancel_check()

		try:
			payload = json.loads(raw.decode("utf-8"))
		except (UnicodeDecodeError, json.JSONDecodeError) as exc:
			raise MinerUClientError(
				"MinerU response is not valid JSON",
				code="mineru_invalid_response",
			) from exc
		if not isinstance(payload, dict):
			raise MinerUClientError(
				"MinerU response JSON must be an object",
				code="mineru_invalid_response",
			)

		latency_ms = (time.perf_counter() - t0) * 1000.0
		try:
			return mineru_json_to_ir(
				payload=payload,
				filename=request.filename,
				title=request.title,
				content=request.content,
				doc_id=request.doc_id,
				library_id=request.library_id,
				parser_version=str(payload.get("version") or self.version),
				latency_ms=latency_ms,
				progress_callback=request.progress_callback,
				cancel_check=request.cancel_check,
			)
		except ValueError as exc:
			raise MinerUClientError(
				str(exc),
				code="mineru_invalid_response",
			) from exc


class Ai302MinerUBackend:
	"""302.AI async MinerU transport, normalized to the shared DocumentIR contract."""

	def __init__(
		self,
		*,
		base_url: str,
		api_key: str,
		timeout_s: float = 120.0,
		upload_path: str = "/302/upload-file",
		task_path: str = "/302/v2/mineru/task",
		poll_interval_s: float = 5.0,
		max_wait_s: float = 900.0,
		parse_method: str = "auto",
		version: str = "2.5",
		cost_per_page: float = 0.02,
		daily_budget: float = 0.0,
		budget_warn_ratio: float = 0.8,
		long_pending_s: float = 300.0,
		request_fn: Callable[..., httpx.Response] | None = None,
	) -> None:
		self.base_url = base_url.rstrip("/")
		self.api_key = api_key.strip()
		self.timeout_s = float(timeout_s)
		self.upload_path = _normalized_path(upload_path)
		self.task_path = _normalized_path(task_path)
		self.poll_interval_s = max(1.0, float(poll_interval_s))
		self.max_wait_s = max(self.poll_interval_s, float(max_wait_s))
		self.parse_method = parse_method.strip() or "auto"
		self._version = version.strip() or "2.5"
		self.cost_per_page = max(0.0, float(cost_per_page))
		self.long_pending_s = max(0.0, float(long_pending_s))
		self._request_fn = request_fn or httpx.request
		get_budget_ledger().configure(
			daily_budget=daily_budget,
			warn_ratio=budget_warn_ratio,
		)

	@property
	def name(self) -> str:
		return "mineru"

	@property
	def version(self) -> str:
		return self._version

	def parse(self, request: ParseRequest) -> DocumentIR:
		if not self.api_key:
			raise MinerUClientError(
				"302 MinerU API key is not configured",
				code="mineru_not_configured",
				retryable=False,
			)
		t0 = time.perf_counter()
		corr = self._correlation(request)
		state = dict(request.provider_state or {})
		task_id = str(state.get("task_id") or "").strip()
		page_count = estimate_pdf_page_count(request.content)
		estimated_cost = estimate_parse_cost(
			page_count, cost_per_page=self.cost_per_page
		)
		try:
			if not task_id:
				prior = str(state.get("state") or "").strip().upper()
				if prior and prior not in {"", "FAILED", "ERROR", "CANCELLED"}:
					incr("mineru_302_duplicate_submit")
					emit_mineru_event(
						"mineru.302.duplicate_submit",
						level="warning",
						phase="submit",
						prior_state=prior,
						**corr,
					)
				# Fail-closed before any billable create.
				try:
					get_budget_ledger().check_can_submit(estimated_cost)
				except BudgetExceededError as exc:
					emit_mineru_event(
						"mineru.302.budget_exceeded",
						level="warning",
						phase="submit",
						spent=exc.spent,
						budget=exc.budget,
						estimated_cost=exc.estimated,
						page_count=page_count,
						**corr,
					)
					raise MinerUClientError(
						str(exc),
						code="mineru_budget_exceeded",
						retryable=False,
					) from exc
				if request.progress_callback is not None:
					request.progress_callback("mineru_upload", None, None)
				upload_t0 = time.perf_counter()
				try:
					pdf_url = self._upload(request)
				except MinerUClientError as exc:
					self._observe_error(exc, phase="upload", request=request, task_id=None)
					raise
				incr("mineru_302_upload")
				emit_mineru_event(
					"mineru.302.upload",
					phase="upload",
					latency_ms=round((time.perf_counter() - upload_t0) * 1000.0, 1),
					page_count=page_count,
					estimated_cost=estimated_cost,
					**corr,
				)
				submit_t0 = time.perf_counter()
				try:
					task_id = self._submit(pdf_url)
				except MinerUClientError as exc:
					self._observe_error(exc, phase="create", request=request, task_id=None)
					raise
				incr("mineru_302_create")
				get_budget_ledger().record_spend(estimated_cost)
				corr = self._correlation(request, task_id=task_id)
				emit_mineru_event(
					"mineru.302.create",
					phase="create",
					latency_ms=round((time.perf_counter() - submit_t0) * 1000.0, 1),
					page_count=page_count,
					estimated_cost=estimated_cost,
					**corr,
				)
				state = {
					"provider": "302ai",
					"task_id": task_id,
					"state": "SUBMITTED",
					"poll_count": 0,
					"page_count": page_count,
					"estimated_cost": estimated_cost,
					"submitted_at": time.time(),
				}
				_publish_provider_state(request, state)

			corr = self._correlation(request, task_id=task_id)
			if request.cancel_check is not None:
				request.cancel_check()
			if request.progress_callback is not None:
				request.progress_callback("mineru_poll", None, None)
			poll_t0 = time.perf_counter()
			try:
				payload = self._request_json(
					"GET",
					self.task_path,
					params={"task_id": task_id},
				)
			except MinerUClientError as exc:
				self._observe_error(exc, phase="poll", request=request, task_id=task_id)
				raise
			provider_latency_ms = (time.perf_counter() - poll_t0) * 1000.0
			provider_status = str(
				payload.get("state") or payload.get("status") or ""
			).strip().upper()
			kind = classify_302_task_state(provider_status)
			if kind == "pending":
				poll_count = int(state.get("poll_count") or 0) + 1
				wait_s = poll_count * self.poll_interval_s
				state.update(
					{
						"state": provider_status or "PENDING",
						"poll_count": poll_count,
						"wait_s": wait_s,
					}
				)
				_publish_provider_state(request, state)
				incr("mineru_302_pending")
				emit_mineru_event(
					"mineru.302.pending",
					phase="poll",
					provider_status=provider_status or "PENDING",
					poll_count=poll_count,
					wait_s=wait_s,
					provider_latency_ms=round(provider_latency_ms, 1),
					max_wait_s=self.max_wait_s,
					**corr,
				)
				if (
					self.long_pending_s > 0
					and wait_s >= self.long_pending_s
					and not state.get("long_pending_warned")
				):
					state["long_pending_warned"] = True
					_publish_provider_state(request, state)
					emit_mineru_event(
						"mineru.302.long_pending",
						level="warning",
						phase="poll",
						wait_s=wait_s,
						long_pending_s=self.long_pending_s,
						poll_count=poll_count,
						**corr,
					)
				if wait_s >= self.max_wait_s:
					exc = MinerUClientError(
						f"302 MinerU task {redact_provider_task_id(task_id)} "
						"exceeded maximum wait",
						code="mineru_timeout",
						retryable=False,
						timeout_kind="hard",
					)
					self._observe_error(
						exc, phase="poll", request=request, task_id=task_id
					)
					raise exc
				raise MinerUPendingError(
					f"302 MinerU task {redact_provider_task_id(task_id)} is "
					f"{provider_status or 'PENDING'}",
					retry_after_s=self.poll_interval_s,
				)
			if kind != "success":
				message = str(
					payload.get("message") or payload.get("error") or provider_status
				)
				exc = MinerUClientError(
					f"302 MinerU task failed: {message[:500]}",
					code="mineru_service_error",
					retryable=False,
				)
				self._observe_error(exc, phase="poll", request=request, task_id=task_id)
				raise exc
			result_url = str(
				payload.get("result_url") or payload.get("full_zip_url") or ""
			).strip()
			if not result_url:
				exc = MinerUClientError(
					"302 MinerU success response is missing result_url",
					code="mineru_invalid_response",
				)
				self._observe_error(exc, phase="complete", request=request, task_id=task_id)
				raise exc
			_validate_302_result_url(result_url, base_url=self.base_url)
			try:
				raw_zip = self._request_bytes("GET", result_url, include_auth=False)
			except MinerUClientError as exc:
				self._observe_error(
					exc, phase="download", request=request, task_id=task_id
				)
				raise
			if len(raw_zip) > 128 * 1024 * 1024:
				exc = MinerUClientError(
					"302 MinerU result ZIP exceeds 128 MiB safety limit",
					code="mineru_invalid_response",
					retryable=False,
				)
				self._observe_error(exc, phase="download", request=request, task_id=task_id)
				raise exc
			try:
				content_list = _content_list_from_zip(raw_zip)
			except MinerUClientError as exc:
				self._observe_error(
					exc, phase="complete", request=request, task_id=task_id
				)
				raise
			result_pages = page_count_from_content_list(content_list)
			if result_pages is not None:
				page_count = result_pages
				estimated_cost = estimate_parse_cost(
					page_count, cost_per_page=self.cost_per_page
				)
			elif state.get("page_count") is not None:
				try:
					page_count = int(state["page_count"])
				except (TypeError, ValueError):
					pass
				if state.get("estimated_cost") is not None:
					try:
						estimated_cost = float(state["estimated_cost"])
					except (TypeError, ValueError):
						estimated_cost = estimate_parse_cost(
							page_count, cost_per_page=self.cost_per_page
						)
			latency_ms = (time.perf_counter() - t0) * 1000.0
			wait_s = float(state.get("wait_s") or 0.0)
			try:
				ir = mineru_json_to_ir(
					payload={"version": self.version, "content_list": content_list},
					filename=request.filename,
					title=request.title,
					content=request.content,
					doc_id=request.doc_id,
					library_id=request.library_id,
					parser_version=self.version,
					latency_ms=latency_ms,
					progress_callback=request.progress_callback,
					cancel_check=request.cancel_check,
				)
			except ValueError as exc:
				err = MinerUClientError(
					str(exc),
					code="mineru_invalid_response",
				)
				self._observe_error(
					err, phase="complete", request=request, task_id=task_id
				)
				raise err from exc
			cost_metrics = build_cost_metrics(
				page_count=page_count,
				cost_per_page=self.cost_per_page,
				estimated_cost=estimated_cost,
			)
			ir.parser_report.metrics.update(
				{
					"mineru_provider": "302ai",
					"mineru_external": True,
					# External / UI: redacted only. Full id stays in job payload.
					"mineru_task_id": redact_provider_task_id(task_id),
					"mineru_parse_method": self.parse_method,
					"mineru_wait_s": wait_s,
					"mineru_poll_count": int(state.get("poll_count") or 0),
					"mineru_provider_latency_ms": round(provider_latency_ms, 1),
					**cost_metrics,
				}
			)
			incr("mineru_302_complete")
			emit_mineru_event(
				"mineru.302.complete",
				phase="complete",
				latency_ms=round(latency_ms, 1),
				provider_latency_ms=round(provider_latency_ms, 1),
				wait_s=wait_s,
				poll_count=int(state.get("poll_count") or 0),
				page_count=page_count,
				estimated_cost=estimated_cost,
				**corr,
			)
			_publish_provider_state(
				request,
				{
					"provider": "302ai",
					"task_id": task_id,
					"state": "SUCCESS",
					"page_count": page_count,
					"estimated_cost": estimated_cost,
				},
			)
			return ir
		except MinerUPendingError:
			raise
		except MinerUClientError:
			raise
		except Exception:
			incr("mineru_302_fail")
			raise

	def _correlation(
		self,
		request: ParseRequest,
		*,
		task_id: str | None = None,
	) -> dict[str, Any]:
		return correlation_fields(
			job_id=request.job_id,
			document_id=request.doc_id,
			library_id=request.library_id,
			trace_id=request.trace_id,
			task_id=task_id,
		)

	def _observe_error(
		self,
		exc: MinerUClientError,
		*,
		phase: str,
		request: ParseRequest,
		task_id: str | None,
	) -> None:
		metric = classify_error_metric(exc.code, exc.status_code)
		incr(f"mineru_302_{metric}")
		incr("mineru_302_fail")
		corr = self._correlation(request, task_id=task_id)
		emit_mineru_event(
			"mineru.302.fail",
			level="warning",
			phase=phase,
			error_code=exc.code,
			status_code=exc.status_code,
			retryable=exc.retryable,
			timeout_kind=exc.timeout_kind,
			metric=metric,
			**corr,
		)
		if note_failure_for_spike():
			emit_mineru_event(
				"mineru.302.failure_spike",
				level="warning",
				phase=phase,
				error_code=exc.code,
				**corr,
			)

	def _upload(self, request: ParseRequest) -> str:
		response = self._request(
			"POST",
			self.upload_path,
			files={"file": (request.filename, request.content, "application/pdf")},
		)
		payload = _response_json(response)
		value = payload.get("data")
		url = value if isinstance(value, str) else ""
		if not url:
			raise MinerUClientError(
				"302 upload response is missing data URL",
				code="mineru_invalid_response",
			)
		return url

	def _submit(self, pdf_url: str) -> str:
		payload = self._request_json(
			"POST",
			self.task_path,
			json={
				"pdf_url": pdf_url,
				"parse_method": self.parse_method,
				"version": self.version,
			},
		)
		task_id = str(payload.get("task_id") or "").strip()
		if not task_id:
			raise MinerUClientError(
				"302 task response is missing task_id",
				code="mineru_invalid_response",
			)
		return task_id

	def _request_json(self, method: str, path_or_url: str, **kwargs: Any) -> dict[str, Any]:
		return _response_json(self._request(method, path_or_url, **kwargs))

	def _request_bytes(self, method: str, path_or_url: str, **kwargs: Any) -> bytes:
		return self._request(method, path_or_url, **kwargs).content

	def _request(self, method: str, path_or_url: str, **kwargs: Any) -> httpx.Response:
		include_auth = bool(kwargs.pop("include_auth", True))
		url = (
			path_or_url
			if path_or_url.startswith(("http://", "https://"))
			else f"{self.base_url}{_normalized_path(path_or_url)}"
		)
		try:
			headers = {"Accept": "application/json"}
			if include_auth:
				headers["Authorization"] = f"Bearer {self.api_key}"
			response = self._request_fn(
				method,
				url,
				headers=headers,
				timeout=self.timeout_s,
				**kwargs,
			)
			response.raise_for_status()
			return response
		except httpx.TimeoutException as exc:
			raise MinerUClientError(
				f"302 MinerU timeout after {self.timeout_s}s",
				code="mineru_timeout",
				timeout_kind="hard",
			) from exc
		except httpx.HTTPStatusError as exc:
			status = exc.response.status_code
			code = (
				"mineru_rate_limited"
				if status == 429
				else "mineru_service_error"
				if status >= 500
				else "mineru_request_rejected"
			)
			raise MinerUClientError(
				f"302 MinerU HTTP {status}: {exc.response.text[:500]}",
				code=code,
				retryable=status == 429 or status >= 500,
				status_code=status,
			) from exc
		except httpx.RequestError as exc:
			raise MinerUClientError(
				f"302 MinerU unreachable: {exc}",
				code="mineru_unreachable",
				retryable=False,
			) from exc


class FakeMinerUBackend:
	"""单测 / 本地无服务：按文件名返回可控 content_list，不走网络。"""

	def __init__(
		self,
		*,
		fixture_loader: Callable[[str], dict[str, Any]] | None = None,
		version: str = "fake-1.0",
		fail: bool = False,
	) -> None:
		self._fixture_loader = fixture_loader
		self._version = version
		self._fail = fail

	@property
	def name(self) -> str:
		return "mineru"

	@property
	def version(self) -> str:
		return self._version

	def parse(self, request: ParseRequest) -> DocumentIR:
		if self._fail:
			raise MinerUClientError("FakeMinerUBackend forced failure")
		t0 = time.perf_counter()
		if self._fixture_loader is not None:
			payload = self._fixture_loader(request.filename)
		else:
			payload = self._default_payload(request.filename)
		latency_ms = (time.perf_counter() - t0) * 1000.0
		return mineru_json_to_ir(
			payload=payload,
			filename=request.filename,
			title=request.title,
			content=request.content,
			doc_id=request.doc_id,
			library_id=request.library_id,
			parser_version=self.version,
			latency_ms=latency_ms,
			progress_callback=request.progress_callback,
			cancel_check=request.cancel_check,
		)

	def _default_payload(self, filename: str) -> dict[str, Any]:
		name = (filename or "").lower()
		if "scanned" in name or "scan" in name:
			return {
				"version": self.version,
				"content_list": [
					{
						"type": "text",
						"text": "请假制度（扫描件 OCR）",
						"text_level": 1,
						"page_idx": 0,
						"bbox": [100, 80, 900, 140],
					},
					{
						"type": "text",
						"text": _FAKE_SCANNED_TEXT,
						"page_idx": 0,
						"bbox": [100, 160, 900, 400],
					},
				],
			}
		if "dual" in name or "column" in name:
			return {
				"version": self.version,
				"content_list": [
					{
						"type": "text",
						"text": "双栏版式左栏：考勤须知",
						"text_level": 2,
						"page_idx": 0,
						"bbox": [50, 80, 480, 140],
					},
					{
						"type": "text",
						"text": "左栏正文：打卡不得代打。",
						"page_idx": 0,
						"bbox": [50, 160, 480, 400],
					},
					{
						"type": "text",
						"text": "双栏版式右栏：出差报销",
						"text_level": 2,
						"page_idx": 0,
						"bbox": [520, 80, 950, 140],
					},
					{
						"type": "text",
						"text": "右栏正文：报销须附行程单。",
						"page_idx": 0,
						"bbox": [520, 160, 950, 400],
					},
				],
			}
		# 默认：跨页表 + 公式 + 图注
		return {
			"version": self.version,
			"content_list": [
				{
					"type": "text",
					"text": "复杂文档样例",
					"text_level": 1,
					"page_idx": 0,
					"bbox": [100, 60, 800, 120],
				},
				{
					"type": "table",
					"table_caption": ["跨页供应商报价表（续）"],
					"table_body": (
						"<table><tr><th>供应商</th><th>报价</th></tr>"
						"<tr><td>甲公司</td><td>120000</td></tr>"
						"<tr><td>乙公司</td><td>80000</td></tr></table>"
					),
					"page_idx": 0,
					"bbox": [80, 140, 920, 420],
				},
					{
						"type": "table",
						"table_caption": ["跨页供应商报价表（第2页）"],
						"is_table_continuation": True,
						"table_body": (
						"<table><tr><th>供应商</th><th>报价</th></tr>"
						"<tr><td>丙公司</td><td>95000</td></tr></table>"
					),
					"page_idx": 1,
					"bbox": [80, 100, 920, 300],
				},
				{
					"type": "equation",
					"text": "E = mc^2",
					"text_format": "latex",
					"page_idx": 1,
					"bbox": [120, 340, 400, 400],
				},
				{
					"type": "image",
					"img_caption": ["图1 设备须断电后再检修"],
					"page_idx": 1,
					"bbox": [120, 420, 700, 780],
				},
			],
		}


def get_mineru_backend(
	*,
	enabled: bool,
	base_url: str,
	provider: str = "self_hosted",
	timeout_s: float = 120.0,
	soft_timeout_s: float = 0.0,
	max_retries: int = 2,
	parse_path: str = "/file_parse",
	api_key_302: str = "",
	external_parser_allowed: bool = False,
	base_url_302: str = "https://api.302.ai",
	upload_path_302: str = "/302/upload-file",
	task_path_302: str = "/302/v2/mineru/task",
	poll_interval_s_302: float = 5.0,
	max_wait_s_302: float = 900.0,
	cost_per_page_302: float = 0.02,
	daily_budget_302: float = 0.0,
	budget_warn_ratio_302: float = 0.8,
	long_pending_s_302: float = 300.0,
	parse_method: str = "auto",
	version: str = "2.5",
	use_fake: bool = False,
	fake_backend: FakeMinerUBackend | None = None,
) -> MinerUBackend | Ai302MinerUBackend | FakeMinerUBackend | None:
	if not enabled:
		return None
	if use_fake or fake_backend is not None:
		return fake_backend or FakeMinerUBackend()
	resolved_provider = (provider or "self_hosted").strip().lower().replace("-", "_")
	if resolved_provider in {"302", "302ai"}:
		if not external_parser_allowed or not api_key_302.strip():
			return None
		return Ai302MinerUBackend(
			base_url=base_url_302,
			api_key=api_key_302,
			timeout_s=timeout_s,
			upload_path=upload_path_302,
			task_path=task_path_302,
			poll_interval_s=poll_interval_s_302,
			max_wait_s=max_wait_s_302,
			cost_per_page=cost_per_page_302,
			daily_budget=daily_budget_302,
			budget_warn_ratio=budget_warn_ratio_302,
			long_pending_s=long_pending_s_302,
			parse_method=parse_method,
			version=version,
		)
	url = (base_url or "").strip()
	if not url:
		return None
	return MinerUBackend(
		base_url=url,
		timeout_s=timeout_s,
		soft_timeout_s=soft_timeout_s,
		max_retries=max_retries,
		parse_path=parse_path,
	)


def _normalized_path(value: str) -> str:
	path = (value or "").strip()
	return path if path.startswith("/") else f"/{path}"


def _validate_302_result_url(url: str, *, base_url: str) -> None:
	parsed = urlparse(url)
	base = urlparse(base_url)
	host = (parsed.hostname or "").lower()
	base_host = (base.hostname or "").lower()
	if parsed.scheme != "https" or not host:
		raise MinerUClientError(
			"302 MinerU result_url must use HTTPS",
			code="mineru_invalid_response",
			retryable=False,
		)
	if host != base_host and not host.endswith(".302.ai"):
		raise MinerUClientError(
			"302 MinerU result_url host is not trusted",
			code="mineru_invalid_response",
			retryable=False,
		)


def _publish_provider_state(request: ParseRequest, state: dict[str, Any]) -> None:
	if request.provider_state_callback is not None:
		request.provider_state_callback(dict(state))


def _response_json(response: httpx.Response) -> dict[str, Any]:
	try:
		payload = response.json()
	except (json.JSONDecodeError, UnicodeDecodeError) as exc:
		raise MinerUClientError(
			"302 MinerU response is not valid JSON",
			code="mineru_invalid_response",
		) from exc
	if not isinstance(payload, dict):
		raise MinerUClientError(
			"302 MinerU response JSON must be an object",
			code="mineru_invalid_response",
		)
	return payload


def _content_list_from_zip(raw: bytes) -> list[dict[str, Any]]:
	try:
		with zipfile.ZipFile(io.BytesIO(raw)) as archive:
			candidates = sorted(
				name
				for name in archive.namelist()
				if name.endswith("_content_list.json") or name == "content_list.json"
			)
			if not candidates:
				raise MinerUClientError(
					"302 MinerU result ZIP has no content_list JSON",
					code="mineru_invalid_response",
				)
			info = archive.getinfo(candidates[0])
			if info.file_size > 64 * 1024 * 1024:
				raise MinerUClientError(
					"302 MinerU content_list exceeds 64 MiB safety limit",
					code="mineru_invalid_response",
					retryable=False,
				)
			payload = json.loads(archive.read(info).decode("utf-8"))
	except (zipfile.BadZipFile, KeyError, UnicodeDecodeError, json.JSONDecodeError) as exc:
		raise MinerUClientError(
			"302 MinerU result ZIP is invalid",
			code="mineru_invalid_response",
		) from exc
	content_list = (
		payload.get("content_list")
		if isinstance(payload, dict)
		else payload
	)
	if not isinstance(content_list, list):
		raise MinerUClientError(
			"302 MinerU content_list must be an array",
			code="mineru_invalid_response",
		)
	return [item for item in content_list if isinstance(item, dict)]


def _sleep_with_cancel(
	seconds: float,
	cancel_check: Callable[[], None] | None,
) -> None:
	deadline = time.monotonic() + max(0.0, seconds)
	while True:
		if cancel_check is not None:
			cancel_check()
		remaining = deadline - time.monotonic()
		if remaining <= 0:
			return
		time.sleep(min(0.1, remaining))


def _post_with_cancel(
	post_fn: Callable[..., bytes],
	*,
	cancel_check: Callable[[], None] | None,
	soft_timeout_s: float = 0.0,
	**kwargs: Any,
) -> bytes:
	"""Run HTTP post; optionally abandon on cancel or soft timeout to free slots."""
	soft = float(soft_timeout_s or 0.0)
	use_watcher = cancel_check is not None or soft > 0
	if not use_watcher:
		return post_fn(**kwargs)

	result: queue.Queue[tuple[bool, bytes | BaseException]] = queue.Queue(maxsize=1)
	started = time.monotonic()

	def invoke() -> None:
		try:
			result.put((True, post_fn(**kwargs)))
		except BaseException as exc:
			result.put((False, exc))

	thread = threading.Thread(
		target=invoke,
		name="mineru-http",
		daemon=True,
	)
	thread.start()
	while thread.is_alive():
		thread.join(timeout=0.25)
		if cancel_check is not None:
			cancel_check()
		if soft > 0 and (time.monotonic() - started) >= soft:
			held_ms = (time.monotonic() - started) * 1000.0
			logger.warning(
				"mineru.soft_timeout timeout_kind=soft soft_timeout_s=%s "
				"slot_held_ms=%.1f",
				soft,
				held_ms,
			)
			raise MinerUClientError(
				f"MinerU soft timeout after {soft}s (abandoned local wait)",
				code="mineru_soft_timeout",
				retryable=True,
				timeout_kind="soft",
			)
	ok, value = result.get()
	if ok:
		return value  # type: ignore[return-value]
	raise value  # type: ignore[misc]
