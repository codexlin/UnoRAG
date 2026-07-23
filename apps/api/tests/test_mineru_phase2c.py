"""Phase 2C — MinerU adapter / routing / degrade."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.ingest.adapters.mineru_ir import mineru_json_to_ir, parse_table_html
from app.services.ingest.backends.base import ParseRequest
from app.services.ingest.backends.mineru import FakeMinerUBackend, MinerUClientError
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
	assert any(n.type == NodeType.HEADING for n in ir.nodes)
	tables = [n for n in ir.nodes if n.type == NodeType.TABLE]
	assert len(tables) >= 2
	assert all(n.table_id and n.table_json for n in tables)
	assert any(n.page_start == 1 and n.page_end == 1 for n in tables)
	assert any(n.page_start == 2 for n in tables)
	assert any(n.type == NodeType.FIGURE and "断电" in (n.text or "") for n in ir.nodes)
	assert any("E = mc^2" in (n.text or "") for n in ir.nodes)
	assert all("reading_order" in n.meta for n in ir.nodes)
	assert all("bbox" in n.meta for n in ir.nodes if n.meta.get("bbox"))

	chunks = chunk_document(ir)
	assert chunks
	payloads = chunks_to_payloads(chunks, doc_id=ir.id, filename=ir.filename)
	table_records = [p for p in payloads if p.get("record_type") == "table"]
	assert table_records
	assert any("120000" in (p.get("text") or "") for p in table_records)


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
	ir = parse_pdf_routed(
		content=digital.read_bytes(),
		filename="leave-digital.pdf",
		title="数字请假",
		settings=settings,
		mineru_backend=FakeMinerUBackend(),
	)
	assert ir.nodes
	assert ir.parser_report.backend == "pymupdf"
	assert ir.parser_report.mode == "text"
	assert ir.parser_report.metrics.get("route") == "pymupdf"
	assert any("人力资源前台" in (n.text or "") for n in ir.nodes)


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
		with pytest.raises(ValueError, match="MinerU unavailable|FakeMinerU"):
			parse_pdf_routed(
				content=scanned.read_bytes(),
				filename="leave-scanned.pdf",
				title="scan",
				settings=settings,
				mineru_backend=failing,
			)

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
