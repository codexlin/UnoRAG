"""MinerU 短窗熔断：连续连不上时跳过 HTTP，半开探活后恢复。

进程内单例，供 lifecycle_worker 单进程使用。仅对 unreachable / 同类连接失败计数；
soft_timeout / 429 等不计入，避免误伤容量退避路径。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable, Literal

logger = logging.getLogger(__name__)

CircuitState = Literal["closed", "open", "half_open"]

# 计入熔断的错误码（连不上 / 跳过时的开路标记本身不再累加）
CIRCUIT_TRIP_CODES = frozenset({"mineru_unreachable"})

DEFAULT_FAILURE_THRESHOLD = 3
DEFAULT_OPEN_SECONDS = 90.0


class MinerUCircuitBreaker:
	"""Closed → Open（达阈值）→ Half-open（到期探活 1 次）→ Closed / 再 Open。"""

	def __init__(
		self,
		*,
		failure_threshold: int = DEFAULT_FAILURE_THRESHOLD,
		open_seconds: float = DEFAULT_OPEN_SECONDS,
		clock: Callable[[], float] | None = None,
	) -> None:
		self.failure_threshold = max(1, int(failure_threshold))
		self.open_seconds = max(1.0, float(open_seconds))
		self._clock = clock or time.monotonic
		self._lock = threading.Lock()
		self._state: CircuitState = "closed"
		self._failure_count = 0
		self._opened_at: float | None = None
		self._probe_inflight = False

	@property
	def state(self) -> CircuitState:
		with self._lock:
			self._maybe_half_open_unlocked()
			return self._state

	@property
	def failure_count(self) -> int:
		with self._lock:
			return self._failure_count

	def configure(
		self,
		*,
		failure_threshold: int | None = None,
		open_seconds: float | None = None,
	) -> None:
		with self._lock:
			if failure_threshold is not None:
				self.failure_threshold = max(1, int(failure_threshold))
			if open_seconds is not None:
				self.open_seconds = max(1.0, float(open_seconds))

	def allow_request(self) -> bool:
		"""闭路 / 半开探活允许 1 次；开路则跳过 HTTP。"""
		with self._lock:
			self._maybe_half_open_unlocked()
			if self._state == "closed":
				return True
			if self._state == "half_open":
				if self._probe_inflight:
					return False
				self._probe_inflight = True
				logger.info("mineru.circuit_probe state=half_open")
				return True
			# open
			return False

	def record_success(self) -> None:
		with self._lock:
			was = self._state
			self._state = "closed"
			self._failure_count = 0
			self._opened_at = None
			self._probe_inflight = False
			if was != "closed":
				logger.info("mineru.circuit_close previous=%s", was)

	def release_probe(self) -> None:
		"""探活请求被取消/非 MinerU 异常中断时释放半开名额。"""
		with self._lock:
			self._probe_inflight = False

	def record_failure(self, code: str) -> None:
		"""仅 connection/unreachable 计入；半开探活失败则再开路一段时间。"""
		with self._lock:
			if code not in CIRCUIT_TRIP_CODES:
				# 服务可达但其它错误：半开探活说明链路通，关闭熔断。
				if self._state == "half_open":
					self._state = "closed"
					self._failure_count = 0
					self._opened_at = None
					self._probe_inflight = False
					logger.info(
						"mineru.circuit_close reason=non_trip_error code=%s",
						code,
					)
				return

			if self._state == "half_open":
				self._trip_unlocked(reason="probe_failed")
				return

			self._failure_count += 1
			if self._failure_count >= self.failure_threshold:
				self._trip_unlocked(reason="threshold")

	def reset(self) -> None:
		"""测试 / 进程内重置。"""
		with self._lock:
			self._state = "closed"
			self._failure_count = 0
			self._opened_at = None
			self._probe_inflight = False

	def snapshot(self) -> dict[str, object]:
		with self._lock:
			self._maybe_half_open_unlocked()
			return {
				"state": self._state,
				"failure_count": self._failure_count,
				"failure_threshold": self.failure_threshold,
				"open_seconds": self.open_seconds,
				"opened_at": self._opened_at,
				"probe_inflight": self._probe_inflight,
			}

	def _maybe_half_open_unlocked(self) -> None:
		if self._state != "open" or self._opened_at is None:
			return
		if self._clock() - self._opened_at >= self.open_seconds:
			self._state = "half_open"
			self._probe_inflight = False
			logger.info(
				"mineru.circuit_half_open open_seconds=%s",
				self.open_seconds,
			)

	def _trip_unlocked(self, *, reason: str) -> None:
		self._state = "open"
		self._opened_at = self._clock()
		self._probe_inflight = False
		logger.warning(
			"mineru.circuit_open reason=%s failure_count=%s open_seconds=%s",
			reason,
			self._failure_count,
			self.open_seconds,
		)


_breaker: MinerUCircuitBreaker | None = None
_breaker_lock = threading.Lock()


def get_mineru_circuit() -> MinerUCircuitBreaker:
	global _breaker
	with _breaker_lock:
		if _breaker is None:
			_breaker = MinerUCircuitBreaker()
		return _breaker


def reset_mineru_circuit(
	*,
	failure_threshold: int = DEFAULT_FAILURE_THRESHOLD,
	open_seconds: float = DEFAULT_OPEN_SECONDS,
	clock: Callable[[], float] | None = None,
) -> MinerUCircuitBreaker:
	"""单测用：丢弃旧实例并返回新的闭路熔断器。"""
	global _breaker
	with _breaker_lock:
		_breaker = MinerUCircuitBreaker(
			failure_threshold=failure_threshold,
			open_seconds=open_seconds,
			clock=clock,
		)
		return _breaker
