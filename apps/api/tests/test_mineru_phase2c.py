"""Phase 2C — MinerU adapter / routing / degrade."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import httpx
import pytest

from app.services.ingest.adapters.mineru_ir import mineru_json_to_ir, parse_table_html
from app.services.ingest.backends.base import ParseRequest
from app.services.ingest.backends.mineru import (
	FakeMinerUBackend,
	MinerUBackend,
	MinerUClientError,
	_post_multipart,
)
from app.services.ingest.chunker import chunk_document
from app.services.ingest.ir import NodeType
from app.services.ingest.parsers.pdf_route import (
	parse_pdf_routed,
	should_upgrade_to_mineru,
)
from app.services.ingest.pipeline import chunks_to_payloads, prepare_ingest
from app.settings import Settings

FIXTURES = Path(__file__).parent / "fixtures"
TESTDATA = Path(__file__).resolve().parents[3] / "testdata"


def test_parse_table_html_headers_rows() -> None:
	html = (
		"<table><tr><th>供应商</th><th>报价</th></tr>"
		"<tr><td>甲公司</td><td>120000</td></tr></table>"
	)
	parsed = parse_table_html(html)
	assert parsed["headers"] == ["供应商", "报价"]
	assert parsed["rows"] == [["甲公司", "120000"]]


def test_parse_table_html_keeps_headerless_first_row() -> None:
	html = (
		"<table><tr><td>甲公司</td><td>120000</td></tr>"
		"<tr><td>乙公司</td><td>80000</td></tr></table>"
	)
	parsed = parse_table_html(html)
	assert parsed["headers"] == []
	assert parsed["rows"] == [["甲公司", "120000"], ["乙公司", "80000"]]


def test_parse_table_html_expands_rowspan_and_colspan() -> None:
	html = (
		'<table><tr><th rowspan="2">供应商</th><th colspan="2">报价</th></tr>'
		"<tr><th>未税</th><th>含税</th></tr>"
		"<tr><td>甲公司</td><td>100000</td><td>106000</td></tr></table>"
	)
	parsed = parse_table_html(html)
	assert parsed["headers"] == ["供应商", "报价 / 未税", "报价 / 含税"]
	assert parsed["rows"] == [["甲公司", "100000", "106000"]]


def test_official_mineru_http_contract(monkeypatch: pytest.MonkeyPatch) -> None:
	captured: dict = {}

	class Response:
		content = b'{"content_list": [{"type": "text", "text": "ok", "page_idx": 0}]}'

		def raise_for_status(self) -> None:
			return None

	def fake_post(url: str, **kwargs):
		captured["url"] = url
		captured.update(kwargs)
		return Response()

	monkeypatch.setattr("app.services.ingest.backends.mineru.httpx.post", fake_post)
	raw = _post_multipart(
		"http://mineru:8000/file_parse",
		filename="sample.pdf",
		content=b"%PDF",
		timeout_s=30,
	)
	assert raw.startswith(b"{")
	assert captured["url"].endswith("/file_parse")
	assert set(captured["files"]) == {"files"}
	assert captured["data"]["return_content_list"] == "true"
	assert captured["data"]["response_format_zip"] == "false"


def test_mineru_unreachable_is_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
	def fake_post(url: str, **_kwargs) -> httpx.Response:
		raise httpx.ConnectError(
			"[Errno 61] Connection refused",
			request=httpx.Request("POST", url),
		)

	monkeypatch.setattr("app.services.ingest.backends.mineru.httpx.post", fake_post)
	with pytest.raises(MinerUClientError) as exc_info:
		_post_multipart(
			"http://127.0.0.1:6006/file_parse",
			filename="sample.pdf",
			content=b"%PDF",
			timeout_s=5,
		)
	assert exc_info.value.code == "mineru_unreachable"
	assert exc_info.value.retryable is False


def test_auto_degrades_to_pymupdf_when_mineru_unreachable(
	monkeypatch: pytest.MonkeyPatch,
) -> None:
	"""Upgrade path + unreachable MinerU must degrade to PyMuPDF, not retry-loop."""
	import fitz

	doc = fitz.open()
	page = doc.new_page()
	page.insert_text((72, 72), "Supplier quote table page with extractable text.", fontsize=12)
	content = doc.tobytes()
	doc.close()

	class UnreachableMinerU:
		name = "mineru"
		version = "test"

		def parse(self, request: ParseRequest):
			raise MinerUClientError(
				"MinerU unreachable: [Errno 61] Connection refused",
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

	ir = parse_pdf_routed(
		content=content,
		filename="crosstable-like.pdf",
		title="table",
		settings=Settings(
			mineru_enabled=True,
			mineru_mode="auto",
			ask_mode="stub",
			metadata_backend="json",
		),
		mineru_backend=UnreachableMinerU(),
	)
	assert ir.nodes
	assert ir.parser_report.partial is True
	assert ir.parser_report.metrics.get("route") == "pymupdf_degrade"
	assert any("已用基础解析" in w for w in ir.parser_report.warnings)


@pytest.mark.parametrize(
	("status", "code", "retryable"),
	[
		(400, "mineru_request_rejected", False),
		(429, "mineru_rate_limited", True),
		(503, "mineru_service_error", True),
	],
)
def test_mineru_http_error_taxonomy(
	monkeypatch: pytest.MonkeyPatch,
	status: int,
	code: str,
	retryable: bool,
) -> None:
	def fake_post(url: str, **_kwargs) -> httpx.Response:
		return httpx.Response(
			status,
			text="upstream error",
			request=httpx.Request("POST", url),
		)

	monkeypatch.setattr("app.services.ingest.backends.mineru.httpx.post", fake_post)
	with pytest.raises(MinerUClientError) as exc_info:
		_post_multipart(
			"http://mineru:8000/file_parse",
			filename="sample.pdf",
			content=b"%PDF",
			timeout_s=30,
		)

	assert exc_info.value.code == code
	assert exc_info.value.retryable is retryable
	assert exc_info.value.status_code == status


def test_backend_unwraps_official_results_by_filename() -> None:
	def post_fn(*_args, **_kwargs) -> bytes:
		content_list = json.dumps(
			[{"type": "text", "text": "真实响应", "page_idx": 0}],
			ensure_ascii=False,
		)
		return json.dumps(
			{
				"results": {
					"sample.pdf": {
						"content_list": content_list,
					}
				}
			},
			ensure_ascii=False,
		).encode()

	backend = MinerUBackend(base_url="http://mineru:8000", post_fn=post_fn)
	ir = backend.parse(ParseRequest(content=b"%PDF", filename="sample.pdf", title="sample"))
	assert ir.nodes[0].text == "真实响应"


@pytest.mark.parametrize(
	("content_list", "message"),
	[
		("{not-json", "invalid JSON"),
		('{"type": "text"}', "decode to a list"),
		(123, "list or JSON string"),
	],
)
def test_mineru_rejects_invalid_content_list_contract(
	content_list,
	message: str,
) -> None:
	with pytest.raises(ValueError, match=message):
		mineru_json_to_ir(
			payload={"results": {"sample": {"content_list": content_list}}},
			filename="sample.pdf",
			title="sample",
		)


def test_mineru_json_to_ir_preserves_structure() -> None:
	payload = json.loads((FIXTURES / "mineru_content_list_complex.json").read_text())
	ir = mineru_json_to_ir(
		payload=payload,
		filename="complex.pdf",
		title="复杂文档",
		content=b"%PDF-fake",
		parser_version="fake-complex-1.0",
		latency_ms=12.5,
	)
	assert ir.parser_report.backend == "mineru"
	assert ir.parser_report.parser_version == "fake-complex-1.0"
	assert ir.parser_report.mode == "mineru"
	assert ir.parser_report.latency_ms == 12.5
	headings = [n for n in ir.nodes if n.type == NodeType.HEADING]
	assert [n.path for n in headings] == [
		"复杂文档样例",
		"复杂文档样例 / 双栏左：考勤须知",
		"复杂文档样例 / 双栏右：出差报销",
	]
	tables = [n for n in ir.nodes if n.type == NodeType.TABLE]
	assert len(tables) == 1
	assert all(n.table_id and n.table_json for n in tables)
	assert tables[0].page_start == 1
	assert tables[0].page_end == 2
	assert tables[0].table_json["rows"] == [
		["甲公司", "120000"],
		["乙公司", "80000"],
		["丙公司", "95000"],
	]
	assert tables[0].meta["continuation_pages"] == [2]
	assert any(n.type == NodeType.FIGURE and "断电" in (n.text or "") for n in ir.nodes)
	assert any("E = mc^2" in (n.text or "") for n in ir.nodes)
	assert all("reading_order" in n.meta for n in ir.nodes)
	assert all("bbox" in n.meta for n in ir.nodes if n.meta.get("bbox"))

	chunks = chunk_document(ir)
	assert chunks
	payloads = chunks_to_payloads(
		chunks,
		doc_id=ir.id,
		filename=ir.filename,
		document_version_id="66666666-6666-6666-6666-666666666666",
	)
	table_records = [p for p in payloads if p.get("record_type") == "table"]
	assert table_records
	assert any("120000" in (p.get("text") or "") for p in table_records)
	assert {p.get("table_id") for p in table_records} == {tables[0].table_id}
	assert all(p.get("page_start") == 1 and p.get("page_end") == 2 for p in table_records)


def test_adjacent_tables_without_continuation_stay_separate() -> None:
	payload = {
		"content_list": [
			{
				"type": "table",
				"table_caption": ["一季度报价"],
				"table_body": (
					"<table><tr><th>供应商</th><th>报价</th></tr>"
					"<tr><td>甲</td><td>1</td></tr></table>"
				),
				"page_idx": 0,
			},
			{
				"type": "table",
				"table_caption": ["二季度报价"],
				"table_body": (
					"<table><tr><th>供应商</th><th>报价</th></tr>"
					"<tr><td>乙</td><td>2</td></tr></table>"
				),
				"page_idx": 1,
			},
		]
	}
	ir = mineru_json_to_ir(payload=payload, filename="tables.pdf", title="tables")
	tables = [node for node in ir.nodes if node.type == NodeType.TABLE]
	assert len(tables) == 2
	assert tables[0].table_id != tables[1].table_id


def test_continuation_skips_page_noise_and_accepts_missing_headers() -> None:
	payload = {
		"content_list": [
			{
				"type": "table",
				"table_caption": ["供应商报价表"],
				"table_body": (
					"<table><tr><th>供应商</th><th>报价</th></tr>"
					"<tr><td>甲</td><td>1</td></tr></table>"
				),
				"page_idx": 0,
			},
			{"type": "footer", "text": "内部资料", "page_idx": 0},
			{"type": "page_number", "text": "1", "page_idx": 0},
			{"type": "discarded", "text": "重复页眉", "page_idx": 1},
			{"type": "page_header", "text": "报价清单", "page_idx": 1},
			{
				"type": "table",
				"table_caption": ["供应商报价表（续）"],
				"table_body": (
					"<table><tr><td>乙</td><td>2</td></tr>"
					"<tr><td>丙</td><td>3</td></tr></table>"
				),
				"page_idx": 1,
			},
		]
	}
	ir = mineru_json_to_ir(payload=payload, filename="continued.pdf", title="continued")
	tables = [node for node in ir.nodes if node.type == NodeType.TABLE]
	assert len(tables) == 1
	assert tables[0].page_end == 2
	assert tables[0].table_json["headers"] == ["供应商", "报价"]
	assert tables[0].table_json["rows"] == [["甲", "1"], ["乙", "2"], ["丙", "3"]]
	assert all("内部资料" not in node.text for node in ir.nodes)


def test_headerless_tables_merge_only_with_strong_continuation() -> None:
	payload = {
		"content_list": [
			{
				"type": "table",
				"table_caption": ["无表头明细"],
				"table_body": "<table><tr><td>甲</td><td>1</td></tr></table>",
				"page_idx": 0,
			},
			{
				"type": "table",
				"table_caption": ["无表头明细（续）"],
				"table_body": "<table><tr><td>乙</td><td>2</td></tr></table>",
				"page_idx": 1,
			},
		]
	}
	ir = mineru_json_to_ir(payload=payload, filename="headerless.pdf", title="headerless")
	tables = [node for node in ir.nodes if node.type == NodeType.TABLE]
	assert len(tables) == 1
	assert tables[0].table_json["headers"] == []
	assert tables[0].table_json["rows"] == [["甲", "1"], ["乙", "2"]]


def test_page_number_caption_alone_does_not_merge_tables() -> None:
	payload = {
		"content_list": [
			{
				"type": "table",
				"table_caption": ["供应商报价表"],
				"table_body": (
					"<table><tr><th>供应商</th><th>报价</th></tr>"
					"<tr><td>甲</td><td>1</td></tr></table>"
				),
				"page_idx": 0,
			},
			{
				"type": "table",
				"table_caption": ["供应商报价表（第2页）"],
				"continued": "false",
				"table_body": (
					"<table><tr><th>供应商</th><th>报价</th></tr>"
					"<tr><td>乙</td><td>2</td></tr></table>"
				),
				"page_idx": 1,
			},
		]
	}
	ir = mineru_json_to_ir(payload=payload, filename="pages.pdf", title="pages")
	tables = [node for node in ir.nodes if node.type == NodeType.TABLE]
	assert len(tables) == 2


def test_mineru_empty_content_list_refuses_silent() -> None:
	with pytest.raises(ValueError, match="empty content_list"):
		mineru_json_to_ir(
			payload={"version": "x", "content_list": []},
			filename="empty.pdf",
			title="empty",
		)


def test_fake_mineru_scanned_ready() -> None:
	backend = FakeMinerUBackend()
	scanned = TESTDATA / "pdf" / "leave-scanned.pdf"
	if not scanned.is_file():
		pytest.skip("leave-scanned.pdf missing")
	ir = backend.parse(
		ParseRequest(
			content=scanned.read_bytes(),
			filename="leave-scanned.pdf",
			title="扫描请假",
		)
	)
	assert ir.nodes
	assert ir.parser_report.backend == "mineru"
	assert any("三个工作日" in (n.text or "") for n in ir.nodes)
	assert ir.parser_report.latency_ms is not None


def test_fake_mineru_default_merges_explicit_continuation() -> None:
	ir = FakeMinerUBackend().parse(
		ParseRequest(content=b"%PDF", filename="complex.pdf", title="complex")
	)
	tables = [node for node in ir.nodes if node.type == NodeType.TABLE]
	assert len(tables) == 1
	assert tables[0].page_start == 1
	assert tables[0].page_end == 2
	assert len(tables[0].table_json["rows"]) == 3


def test_mineru_reports_page_progress_and_checks_cancellation() -> None:
	progress: list[tuple[str, int | None, int | None]] = []
	cancel_checks = 0

	def check_cancel() -> None:
		nonlocal cancel_checks
		cancel_checks += 1

	ir = FakeMinerUBackend().parse(
		ParseRequest(
			content=b"%PDF",
			filename="complex.pdf",
			title="complex",
			progress_callback=lambda phase, current, total: progress.append(
				(phase, current, total)
			),
			cancel_check=check_cancel,
		)
	)

	assert ir.nodes
	assert ("mineru_page", 1, 2) in progress
	assert ("mineru_page", 2, 2) in progress
	assert cancel_checks >= len(ir.nodes)


def test_mineru_blocking_request_is_cooperatively_cancelled() -> None:
	started = threading.Event()
	release = threading.Event()
	checks = 0

	class Cancelled(RuntimeError):
		pass

	def blocking_post(**_kwargs) -> bytes:
		started.set()
		release.wait(timeout=5)
		return b'{"content_list":[{"type":"text","text":"late","page_idx":0}]}'

	def check_cancel() -> None:
		nonlocal checks
		checks += 1
		if started.is_set() and checks >= 2:
			raise Cancelled("cancel requested")

	backend = MinerUBackend(
		base_url="http://mineru:8000",
		max_retries=0,
		post_fn=blocking_post,
	)
	t0 = time.monotonic()
	try:
		with pytest.raises(Cancelled):
			backend.parse(
				ParseRequest(
					content=b"%PDF",
					filename="large.pdf",
					title="large",
					cancel_check=check_cancel,
				)
			)
	finally:
		release.set()

	assert time.monotonic() - t0 < 1.5


def test_route_digital_pdf_stays_pymupdf() -> None:
	digital = TESTDATA / "pdf" / "leave-digital.pdf"
	if not digital.is_file():
		pytest.skip("leave-digital.pdf missing")
	settings = Settings(
		mineru_enabled=True,
		mineru_use_fake=True,
		mineru_mode="auto",
		ask_mode="stub",
		metadata_backend="json",
	)
	progress: list[tuple[str, int | None, int | None]] = []
	ir = parse_pdf_routed(
		content=digital.read_bytes(),
		filename="leave-digital.pdf",
		title="数字请假",
		settings=settings,
		mineru_backend=FakeMinerUBackend(),
		progress_callback=lambda phase, current, total: progress.append(
			(phase, current, total)
		),
	)
	assert ir.nodes
	assert ir.parser_report.backend == "pymupdf"
	assert ir.parser_report.mode == "text"
	assert ir.parser_report.metrics.get("route") == "pymupdf"
	assert any("人力资源前台" in (n.text or "") for n in ir.nodes)
	assert progress
	assert all(item[0] == "pymupdf_page" for item in progress)


def test_route_scanned_uses_mineru_fake() -> None:
	scanned = TESTDATA / "pdf" / "leave-scanned.pdf"
	if not scanned.is_file():
		pytest.skip("leave-scanned.pdf missing")
	settings = Settings(
		mineru_enabled=True,
		mineru_use_fake=True,
		mineru_mode="auto",
		ask_mode="stub",
		metadata_backend="json",
	)
	ir = parse_pdf_routed(
		content=scanned.read_bytes(),
		filename="leave-scanned.pdf",
		title="扫描请假",
		settings=settings,
		mineru_backend=FakeMinerUBackend(),
	)
	assert ir.nodes
	assert ir.parser_report.backend == "mineru"
	assert ir.parser_report.parser_version
	assert ir.parser_report.latency_ms is not None
	assert any("三个工作日" in (n.text or "") for n in ir.nodes)
	# ready 路径：可切片
	chunks = chunk_document(ir)
	assert chunks


def test_text_only_scanned_pdf_never_calls_mineru() -> None:
	scanned = TESTDATA / "pdf" / "leave-scanned.pdf"
	if not scanned.is_file():
		pytest.skip("leave-scanned.pdf missing")

	class ForbiddenMinerU:
		def parse(self, _request: ParseRequest):
			raise AssertionError("text-only policy must never call MinerU")

	with pytest.raises(ValueError, match="scan recognition is disabled"):
		parse_pdf_routed(
			content=scanned.read_bytes(),
			filename="leave-scanned.pdf",
			title="扫描请假",
			settings=Settings(
				mineru_enabled=True,
				mineru_mode="mineru",
				ask_mode="stub",
				metadata_backend="json",
			),
			mineru_backend=ForbiddenMinerU(),
			enhanced_parser_allowed=False,
		)


def test_route_scanned_without_mineru_explicit_fail() -> None:
	scanned = TESTDATA / "pdf" / "leave-scanned.pdf"
	if not scanned.is_file():
		pytest.skip("leave-scanned.pdf missing")
	settings = Settings(
		mineru_enabled=False,
		mineru_use_fake=False,
		mineru_mode="auto",
		ask_mode="stub",
		metadata_backend="json",
	)
	with pytest.raises(ValueError, match="MinerU|extractable|OCR"):
		parse_pdf_routed(
			content=scanned.read_bytes(),
			filename="leave-scanned.pdf",
			title="扫描请假",
			settings=settings,
			mineru_backend=None,
		)


def test_mineru_degrade_keeps_pymupdf_partial() -> None:
	"""MinerU 失败但 PyMuPDF 有节点 → degrade，不静默清空。"""
	import fitz

	from app.services.ingest.ir import DocumentIR, Node, ParserReport
	from app.services.ingest.parsers.pdf_route import should_upgrade_to_mineru

	doc = fitz.open()
	page = doc.new_page()
	page.insert_text((72, 72), "Keep this digital text page.", fontsize=12)
	# 再加一页空白模拟复杂（路由仍会先跑 pymupdf）
	doc.new_page()
	content = doc.tobytes()
	doc.close()

	failing = FakeMinerUBackend(fail=True)
	settings = Settings(
		mineru_enabled=True,
		mineru_mode="auto",
		ask_mode="stub",
		metadata_backend="json",
	)
	# 强制升级路径：用 mineru_mode=mineru 会直接失败；这里测 degrade 需 pymupdf 有节点且 upgrade
	# 构造：先确认纯文本不升级
	ir_text = parse_pdf_routed(
		content=content,
		filename="mixed.pdf",
		title="mixed",
		settings=Settings(mineru_enabled=False, ask_mode="stub", metadata_backend="json"),
	)
	# 若无复杂信号则不会调用 MinerU；手动验证 degrade 辅助逻辑
	partial = DocumentIR(
		id="d1",
		title="t",
		source_format="pdf",
		nodes=[
			Node(id="n1", type=NodeType.PAGE, text="ok", page_start=1, page_end=1),
		],
		parser_report=ParserReport(
			source_format="pdf",
			parser="pymupdf",
			needs_ocr_pages=[2],
			partial=True,
		),
	)
	assert should_upgrade_to_mineru(partial) is True

	# 强制 mineru 模式 + fail → 无 pymupdf 救援时应显式失败
	with pytest.raises(ValueError, match="MinerU"):
		parse_pdf_routed(
			content=content,
			filename="force.pdf",
			title="force",
			settings=Settings(
				mineru_enabled=True,
				mineru_mode="mineru",
				ask_mode="stub",
				metadata_backend="json",
			),
			mineru_backend=failing,
		)

	# auto + 扫描件 + fail → 显式失败（无 pymupdf 节点）
	scanned = TESTDATA / "pdf" / "leave-scanned.pdf"
	if scanned.is_file():
		with pytest.raises(MinerUClientError) as exc_info:
			parse_pdf_routed(
				content=scanned.read_bytes(),
				filename="leave-scanned.pdf",
				title="scan",
				settings=settings,
				mineru_backend=failing,
			)
		assert exc_info.value.retryable is True
		assert exc_info.value.parser_report is not None
		assert exc_info.value.parser_report["metrics"]["route"] == "mineru_failed"

	assert ir_text.nodes  # 数字页路径不回归


def test_prepare_ingest_scanned_with_fake_mineru_ready() -> None:
	scanned = TESTDATA / "pdf" / "leave-scanned.pdf"
	if not scanned.is_file():
		pytest.skip("leave-scanned.pdf missing")
	settings = Settings(
		ingest_pipeline="v2",
		mineru_enabled=True,
		mineru_use_fake=True,
		mineru_mode="auto",
		ask_mode="stub",
		metadata_backend="json",
	)
	prepared = prepare_ingest(
		settings=settings,
		filename="leave-scanned.pdf",
		content=scanned.read_bytes(),
		library_id="lib-scan",
	)
	assert prepared.pipeline == "v2"
	assert prepared.chunks
	report = prepared.parser_report
	assert report.backend == "mineru"
	assert report.parser_version
	assert report.latency_ms is not None
	assert report.metrics.get("route") == "mineru"


def test_fake_backend_raises_on_fail_flag() -> None:
	backend = FakeMinerUBackend(fail=True)
	with pytest.raises(MinerUClientError):
		backend.parse(
			ParseRequest(content=b"%PDF", filename="x.pdf", title="x")
		)
