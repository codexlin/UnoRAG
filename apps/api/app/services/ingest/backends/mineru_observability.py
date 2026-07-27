"""302 MinerU observability + cost control (V1).

Structured JSON events (safe fields only) + in-process counters.
No public metrics endpoint; scrape logs / counter snapshots in-process.
Provider task ids are redacted in external surfaces (parser_report / logs).
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

logger = logging.getLogger(__name__)

# Placeholder rate — ops should override via MINERU_302_COST_PER_PAGE.
DEFAULT_COST_PER_PAGE = 0.02
DEFAULT_BUDGET_WARN_RATIO = 0.8
DEFAULT_LONG_PENDING_S = 300.0

_COUNTERS: Counter[str] = Counter()
_COUNTER_LOCK = threading.Lock()
_FAILURE_WINDOW: list[float] = []
_FAILURE_WINDOW_LOCK = threading.Lock()
_FAILURE_SPIKE_WINDOW_S = 300.0
_FAILURE_SPIKE_THRESHOLD = 5


def redact_provider_task_id(task_id: str | None) -> str | None:
	"""External/UI form: first8…last4 (or fully masked when short)."""
	value = str(task_id or "").strip()
	if not value:
		return None
	if len(value) <= 12:
		if len(value) <= 4:
			return "…"
		return f"{value[:2]}…{value[-2:]}"
	return f"{value[:8]}…{value[-4:]}"


def estimate_pdf_page_count(content: bytes | None) -> int | None:
	"""Best-effort page count from PDF bytes (PyMuPDF). None when unknown."""
	if not content:
		return None
	try:
		import fitz

		document = fitz.open(stream=content, filetype="pdf")
		try:
			count = int(document.page_count)
		finally:
			document.close()
		return count if count >= 0 else None
	except Exception:
		return None


def page_count_from_content_list(content_list: list[dict[str, Any]] | None) -> int | None:
	"""Infer page count from MinerU content_list page_idx values."""
	if not content_list:
		return None
	indices: list[int] = []
	for item in content_list:
		if not isinstance(item, dict):
			continue
		raw = item.get("page_idx", item.get("page"))
		try:
			indices.append(int(raw))
		except (TypeError, ValueError):
			continue
	if not indices:
		return None
	return max(indices) + 1


def estimate_parse_cost(
	pages: int | None,
	*,
	cost_per_page: float = DEFAULT_COST_PER_PAGE,
) -> float | None:
	if pages is None or pages < 0:
		return None
	rate = max(0.0, float(cost_per_page))
	return round(int(pages) * rate, 6)


def incr(metric: str, amount: int = 1) -> None:
	key = str(metric or "").strip()
	if not key:
		return
	with _COUNTER_LOCK:
		_COUNTERS[key] += int(amount)


def snapshot_counters() -> dict[str, int]:
	with _COUNTER_LOCK:
		return dict(_COUNTERS)


def reset_observability_state() -> None:
	"""Test helper: clear counters, budget ledger, failure window."""
	with _COUNTER_LOCK:
		_COUNTERS.clear()
	with _FAILURE_WINDOW_LOCK:
		_FAILURE_WINDOW.clear()
	get_budget_ledger().reset()


def _clean_id(value: str | None) -> str | None:
	text = str(value or "").strip()
	return text or None


def correlation_fields(
	*,
	job_id: str | None = None,
	document_id: str | None = None,
	library_id: str | None = None,
	trace_id: str | None = None,
	task_id: str | None = None,
) -> dict[str, Any]:
	"""Safe correlation map for logs / events (redacted provider task id)."""
	return {
		"trace_id": _clean_id(trace_id),
		"job_id": _clean_id(job_id),
		"document_id": _clean_id(document_id),
		"library_id": _clean_id(library_id),
		"provider_task_id": redact_provider_task_id(task_id),
	}


def emit_mineru_event(
	event: str,
	*,
	level: str = "info",
	**fields: Any,
) -> dict[str, Any]:
	"""Emit one greppable JSON line: event=mineru.302.* (mirrors ask.trace)."""
	payload: dict[str, Any] = {"event": event, "ts": time.time()}
	for key, value in fields.items():
		if value is None:
			continue
		# Never log credential-shaped keys.
		lower = str(key).lower().replace("-", "_")
		if any(
			frag in lower
			for frag in ("api_key", "authorization", "bearer", "password", "secret")
		):
			continue
		payload[key] = value
	# Force redaction if a full task id slipped in under alternate keys.
	for key in ("task_id", "mineru_task_id", "provider_task_id"):
		if key in payload and isinstance(payload[key], str):
			if key == "provider_task_id":
				payload[key] = redact_provider_task_id(payload[key])
			elif "…" not in payload[key]:
				payload[key] = redact_provider_task_id(payload[key])
	line = json.dumps(payload, ensure_ascii=False, default=str)
	print(line, flush=True)
	log_fn = logger.warning if level == "warning" else logger.info
	if level == "error":
		log_fn = logger.error
	log_fn("%s", line)
	return payload


def note_failure_for_spike(*, now: float | None = None) -> bool:
	"""Record a failure; return True if a spike warning should fire."""
	ts = float(now if now is not None else time.time())
	with _FAILURE_WINDOW_LOCK:
		_FAILURE_WINDOW.append(ts)
		cutoff = ts - _FAILURE_SPIKE_WINDOW_S
		while _FAILURE_WINDOW and _FAILURE_WINDOW[0] < cutoff:
			_FAILURE_WINDOW.pop(0)
		return len(_FAILURE_WINDOW) >= _FAILURE_SPIKE_THRESHOLD


def classify_error_metric(code: str | None, status_code: int | None = None) -> str:
	normalized = str(code or "").strip().lower()
	if status_code == 429 or normalized == "mineru_rate_limited":
		return "429"
	if status_code is not None and status_code >= 500:
		return "5xx"
	if normalized in {"mineru_timeout", "mineru_soft_timeout"}:
		return "timeout"
	if normalized in {
		"mineru_invalid_response",
		"mineru_request_rejected",
	}:
		return "invalid_result"
	if normalized == "mineru_budget_exceeded":
		return "budget_exceeded"
	return "fail"


@dataclass
class DailyBudgetLedger:
	"""Process-local UTC daily spend tracker (V1; multi-worker rollup is follow-up)."""

	daily_budget: float = 0.0
	warn_ratio: float = DEFAULT_BUDGET_WARN_RATIO
	_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
	_day: str = ""
	_spent: float = 0.0
	_near_warned: bool = False

	def configure(
		self,
		*,
		daily_budget: float | None = None,
		warn_ratio: float | None = None,
	) -> None:
		with self._lock:
			if daily_budget is not None:
				self.daily_budget = max(0.0, float(daily_budget))
			if warn_ratio is not None:
				self.warn_ratio = min(1.0, max(0.0, float(warn_ratio)))

	def reset(self) -> None:
		with self._lock:
			self._day = ""
			self._spent = 0.0
			self._near_warned = False

	def snapshot(self) -> dict[str, Any]:
		with self._lock:
			self._rollover_unlocked()
			return {
				"day": self._day,
				"spent": round(self._spent, 6),
				"daily_budget": self.daily_budget,
				"enabled": self.daily_budget > 0,
			}

	def check_can_submit(self, estimated_cost: float | None) -> None:
		"""Fail-closed when already at budget or adding cost would exceed it."""
		cost = max(0.0, float(estimated_cost or 0.0))
		with self._lock:
			self._rollover_unlocked()
			if self.daily_budget <= 0:
				return
			# Already at/over budget: block even when page cost is unknown (0).
			if self._spent >= self.daily_budget - 1e-9:
				incr("mineru_302_budget_exceeded")
				raise BudgetExceededError(
					f"302 MinerU daily budget exceeded "
					f"(spent={self._spent:.4f} >= budget={self.daily_budget:.4f})",
					spent=self._spent,
					budget=self.daily_budget,
					estimated=cost,
				)
			projected = self._spent + cost
			if projected > self.daily_budget + 1e-9:
				incr("mineru_302_budget_exceeded")
				raise BudgetExceededError(
					f"302 MinerU daily budget exceeded "
					f"(spent={self._spent:.4f} + est={cost:.4f} "
					f"> budget={self.daily_budget:.4f})",
					spent=self._spent,
					budget=self.daily_budget,
					estimated=cost,
				)
			# Near-limit warning (once per day) before crossing.
			warn_at = self.daily_budget * self.warn_ratio
			if (
				not self._near_warned
				and warn_at > 0
				and projected >= warn_at
			):
				self._near_warned = True
				emit_mineru_event(
					"mineru.302.budget_near_limit",
					level="warning",
					spent=round(self._spent, 6),
					projected=round(projected, 6),
					daily_budget=self.daily_budget,
					warn_ratio=self.warn_ratio,
				)

	def record_spend(self, cost: float | None) -> float:
		amount = max(0.0, float(cost or 0.0))
		with self._lock:
			self._rollover_unlocked()
			self._spent += amount
			# Milli-units: scrape-friendly integer counter for estimated spend.
			if amount > 0:
				incr("mineru_302_cost_milli", amount=max(1, int(round(amount * 1000))))
			return round(self._spent, 6)

	def _rollover_unlocked(self) -> None:
		today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
		if self._day != today:
			self._day = today
			self._spent = 0.0
			self._near_warned = False


class BudgetExceededError(RuntimeError):
	code = "mineru_budget_exceeded"

	def __init__(
		self,
		message: str,
		*,
		spent: float,
		budget: float,
		estimated: float,
	) -> None:
		super().__init__(message)
		self.spent = spent
		self.budget = budget
		self.estimated = estimated
		self.retryable = False


_BUDGET_LEDGER = DailyBudgetLedger()


def get_budget_ledger() -> DailyBudgetLedger:
	return _BUDGET_LEDGER


def build_cost_metrics(
	*,
	page_count: int | None,
	cost_per_page: float,
	estimated_cost: float | None = None,
) -> dict[str, Any]:
	cost = (
		estimated_cost
		if estimated_cost is not None
		else estimate_parse_cost(page_count, cost_per_page=cost_per_page)
	)
	out: dict[str, Any] = {
		"mineru_page_count": page_count,
		"mineru_cost_per_page": cost_per_page,
		"mineru_estimated_cost": cost,
	}
	return out


def redact_metrics_task_ids(metrics: dict[str, Any] | None) -> dict[str, Any]:
	"""Ensure parser_report metrics never expose a full provider task id."""
	if not isinstance(metrics, dict):
		return {}
	out = dict(metrics)
	for key in ("mineru_task_id", "task_id", "provider_task_id"):
		if key in out and out[key] is not None:
			out[key] = redact_provider_task_id(str(out[key]))
	return out


Clock = Callable[[], float]
