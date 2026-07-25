"""MinerU 短窗熔断：连续 unreachable → open → 跳过 HTTP → 半开探活 → close。"""

from __future__ import annotations

import pytest

from app.services.ingest.backends.base import ParseRequest
from app.services.ingest.backends.mineru import MinerUClientError
from app.services.ingest.backends.mineru_circuit import (
	MinerUCircuitBreaker,
	reset_mineru_circuit,
)
from app.services.ingest.parsers.pdf_route import parse_pdf_routed
from app.settings import Settings


@pytest.fixture(autouse=True)
def _reset_circuit() -> None:
	reset_mineru_circuit()
	yield
	reset_mineru_circuit()


def test_circuit_trips_after_threshold_and_blocks() -> None:
	clock = {"t": 0.0}
	breaker = MinerUCircuitBreaker(
		failure_threshold=3,
		open_seconds=60.0,
		clock=lambda: clock["t"],
	)
	assert breaker.allow_request() is True
	breaker.record_failure("mineru_unreachable")
	breaker.record_failure("mineru_unreachable")
	assert breaker.state == "closed"
	breaker.record_failure("mineru_unreachable")
	assert breaker.state == "open"
	assert breaker.allow_request() is False


def test_soft_timeout_and_429_do_not_trip() -> None:
	breaker = MinerUCircuitBreaker(failure_threshold=2, open_seconds=30.0)
	breaker.record_failure("mineru_soft_timeout")
	breaker.record_failure("mineru_rate_limited")
	breaker.record_failure("mineru_service_error")
	assert breaker.state == "closed"
	assert breaker.failure_count == 0


def test_half_open_probe_success_closes() -> None:
	clock = {"t": 0.0}
	breaker = MinerUCircuitBreaker(
		failure_threshold=2,
		open_seconds=10.0,
		clock=lambda: clock["t"],
	)
	breaker.record_failure("mineru_unreachable")
	breaker.record_failure("mineru_unreachable")
	assert breaker.state == "open"
	assert breaker.allow_request() is False

	clock["t"] = 10.0
	assert breaker.state == "half_open"
	assert breaker.allow_request() is True
	# 半开仅允许一次探活
	assert breaker.allow_request() is False

	breaker.record_success()
	assert breaker.state == "closed"
	assert breaker.failure_count == 0
	assert breaker.allow_request() is True


def test_half_open_probe_failure_reopens() -> None:
	clock = {"t": 0.0}
	breaker = MinerUCircuitBreaker(
		failure_threshold=2,
		open_seconds=10.0,
		clock=lambda: clock["t"],
	)
	breaker.record_failure("mineru_unreachable")
	breaker.record_failure("mineru_unreachable")
	clock["t"] = 10.0
	assert breaker.allow_request() is True
	breaker.record_failure("mineru_unreachable")
	assert breaker.state == "open"
	assert breaker.allow_request() is False
	# 再等一个开路窗口才能探活
	clock["t"] = 19.0
	assert breaker.allow_request() is False
	clock["t"] = 20.0
	assert breaker.allow_request() is True


def _pdf_with_text() -> bytes:
	import fitz

	doc = fitz.open()
	page = doc.new_page()
	page.insert_text((72, 72), "Complex layout quote table extractable text.", fontsize=12)
	content = doc.tobytes()
	doc.close()
	return content


def test_route_skips_http_when_circuit_open(
	monkeypatch: pytest.MonkeyPatch,
) -> None:
	"""连续 unreachable 达阈值后跳过 backend.parse，直接 degrade。"""
	calls = {"n": 0}

	class CountingUnreachable:
		name = "mineru"
		version = "test"

		def parse(self, request: ParseRequest):
			calls["n"] += 1
			raise MinerUClientError(
				"MinerU unreachable: connection refused",
				code="mineru_unreachable",
				retryable=False,
			)

	monkeypatch.setattr(
		"app.services.ingest.parsers.pdf_route.should_upgrade_to_mineru",
		lambda _ir: True,
	)
	monkeypatch.setattr(
		"app.services.ingest.parsers.pdf_route.probe_needs_mineru",
		lambda _content: True,
	)

	settings = Settings(
		mineru_enabled=True,
		mineru_mode="auto",
		mineru_circuit_failure_threshold=3,
		mineru_circuit_open_seconds=60.0,
		ask_mode="stub",
		metadata_backend="json",
	)
	content = _pdf_with_text()
	backend = CountingUnreachable()

	for _ in range(3):
		ir = parse_pdf_routed(
			content=content,
			filename="complex.pdf",
			title="t",
			settings=settings,
			mineru_backend=backend,
		)
		assert ir.parser_report.metrics.get("route") == "pymupdf_degrade"

	assert calls["n"] == 3

	# 第 4 次：熔断开，不应再调用 HTTP
	ir = parse_pdf_routed(
		content=content,
		filename="complex-2.pdf",
		title="t2",
		settings=settings,
		mineru_backend=backend,
	)
	assert calls["n"] == 3
	assert ir.nodes
	assert ir.parser_report.metrics.get("route") == "pymupdf_degrade"
	assert ir.parser_report.metrics.get("mineru_error_code") == "mineru_circuit_open"
	assert ir.parser_report.metrics.get("mineru_circuit") == "open"
	assert any("已用基础解析" in w for w in ir.parser_report.warnings)
	assert any("短窗熔断" in w for w in ir.parser_report.warnings)


def test_route_probe_success_closes_circuit(
	monkeypatch: pytest.MonkeyPatch,
) -> None:
	clock = {"t": 0.0}
	breaker = reset_mineru_circuit(
		failure_threshold=2,
		open_seconds=30.0,
		clock=lambda: clock["t"],
	)

	class FlakyThenOk:
		name = "mineru"
		version = "test"

		def __init__(self) -> None:
			self.calls = 0

		def parse(self, request: ParseRequest):
			from app.services.ingest.ir import DocumentIR, Node, NodeType, ParserReport

			self.calls += 1
			if self.calls <= 2:
				raise MinerUClientError(
					"unreachable",
					code="mineru_unreachable",
					retryable=False,
				)
			return DocumentIR(
				id="doc-ok",
				title=request.title or "ok",
				filename=request.filename,
				nodes=[
					Node(
						id="n1",
						type=NodeType.PARAGRAPH,
						text="recovered via mineru probe",
					)
				],
				parser_report=ParserReport(backend="mineru", parser="mineru"),
			)

	monkeypatch.setattr(
		"app.services.ingest.parsers.pdf_route.should_upgrade_to_mineru",
		lambda _ir: True,
	)
	monkeypatch.setattr(
		"app.services.ingest.parsers.pdf_route.probe_needs_mineru",
		lambda _content: True,
	)

	settings = Settings(
		mineru_enabled=True,
		mineru_mode="auto",
		mineru_circuit_failure_threshold=2,
		mineru_circuit_open_seconds=30.0,
		ask_mode="stub",
		metadata_backend="json",
	)
	content = _pdf_with_text()
	backend = FlakyThenOk()

	# 两次 unreachable → open
	for _ in range(2):
		parse_pdf_routed(
			content=content,
			filename="a.pdf",
			title="t",
			settings=settings,
			mineru_backend=backend,
		)
	assert breaker.state == "open"
	assert backend.calls == 2

	# 开路期间跳过
	parse_pdf_routed(
		content=content,
		filename="b.pdf",
		title="t",
		settings=settings,
		mineru_backend=backend,
	)
	assert backend.calls == 2

	# 时间推进 → 半开探活成功 → close
	clock["t"] = 30.0
	ir = parse_pdf_routed(
		content=content,
		filename="c.pdf",
		title="t",
		settings=settings,
		mineru_backend=backend,
	)
	assert backend.calls == 3
	assert breaker.state == "closed"
	assert ir.parser_report.metrics.get("route") == "mineru"

	# 后续再升级可调用
	parse_pdf_routed(
		content=content,
		filename="d.pdf",
		title="t",
		settings=settings,
		mineru_backend=backend,
	)
	assert backend.calls == 4
