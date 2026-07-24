"""P1: MinerU soft timeout, longer 429/soft backoff, LLM inflight gate."""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from pydantic import ValidationError

from app.services.ingest.backends.base import ParseRequest
from app.services.ingest.backends.mineru import MinerUBackend, MinerUClientError
from app.services.llm import llm_inflight_slot, reset_llm_inflight_gate_for_tests
from app.settings import Settings
from app.workers.document_ingest import (
	classify_ingest_error,
	mineru_job_retry_delay_seconds,
)


def test_soft_timeout_le_hard_validation() -> None:
	with pytest.raises(ValidationError, match="MINERU_SOFT_TIMEOUT_S"):
		Settings(
			_env_file=None,
			mineru_timeout_s=30,
			mineru_soft_timeout_s=60,
			ask_mode="stub",
			metadata_backend="json",
		)


def test_soft_timeout_disabled_when_non_positive() -> None:
	settings = Settings(
		_env_file=None,
		mineru_timeout_s=120,
		mineru_soft_timeout_s=0,
		ask_mode="stub",
		metadata_backend="json",
	)
	assert settings.mineru_soft_timeout_s == 0


def test_mineru_soft_timeout_is_retryable_and_abandons_wait() -> None:
	started = threading.Event()
	release = threading.Event()

	def blocking_post(**_kwargs) -> bytes:
		started.set()
		release.wait(timeout=5)
		return b'{"content_list":[{"type":"text","text":"late","page_idx":0}]}'

	backend = MinerUBackend(
		base_url="http://mineru:8000",
		timeout_s=5.0,
		soft_timeout_s=0.2,
		max_retries=2,
		post_fn=blocking_post,
	)
	t0 = time.monotonic()
	try:
		with pytest.raises(MinerUClientError) as exc_info:
			backend.parse(
				ParseRequest(
					content=b"%PDF",
					filename="slow.pdf",
					title="slow",
				)
			)
	finally:
		release.set()

	err = exc_info.value
	assert err.code == "mineru_soft_timeout"
	assert err.retryable is True
	assert err.timeout_kind == "soft"
	assert classify_ingest_error(err) == (True, "mineru_soft_timeout")
	# Soft timeout must not burn the slot on inline client retries.
	assert time.monotonic() - t0 < 1.5
	assert started.wait(timeout=1.0)


@pytest.mark.parametrize(
	("error_code", "attempt", "expected"),
	[
		("mineru_rate_limited", 1, 30),
		("mineru_soft_timeout", 2, 60),
		("mineru_soft_timeout", 5, 300),
		("mineru_timeout", 1, None),
		("ingest_transient", 1, None),
	],
)
def test_mineru_long_backoff_for_429_and_soft(
	error_code: str,
	attempt: int,
	expected: int | None,
) -> None:
	settings = Settings(
		_env_file=None,
		mineru_retry_base_s=30,
		mineru_retry_max_s=300,
		ask_mode="stub",
		metadata_backend="json",
	)
	assert (
		mineru_job_retry_delay_seconds(
			settings,
			error_code=error_code,
			attempt=attempt,
		)
		== expected
	)


def test_llm_inflight_limits_concurrent_slots() -> None:
	reset_llm_inflight_gate_for_tests()
	settings = Settings(
		_env_file=None,
		llm_max_inflight=2,
		ask_mode="stub",
		metadata_backend="json",
		openai_api_key="test-key",
	)
	active = 0
	peak = 0
	lock = threading.Lock()

	def hold() -> None:
		nonlocal active, peak
		with llm_inflight_slot(settings):
			with lock:
				active += 1
				peak = max(peak, active)
			time.sleep(0.15)
			with lock:
				active -= 1

	with ThreadPoolExecutor(max_workers=6) as pool:
		list(pool.map(lambda _: hold(), range(6)))

	assert peak == 2
	reset_llm_inflight_gate_for_tests()


def test_llm_inflight_disabled_when_non_positive() -> None:
	reset_llm_inflight_gate_for_tests()
	settings = Settings(
		_env_file=None,
		llm_max_inflight=0,
		ask_mode="stub",
		metadata_backend="json",
	)
	active = 0
	peak = 0
	lock = threading.Lock()

	def hold() -> None:
		nonlocal active, peak
		with llm_inflight_slot(settings):
			with lock:
				active += 1
				peak = max(peak, active)
			time.sleep(0.05)
			with lock:
				active -= 1

	with ThreadPoolExecutor(max_workers=4) as pool:
		list(pool.map(lambda _: hold(), range(4)))

	assert peak == 4
	reset_llm_inflight_gate_for_tests()
