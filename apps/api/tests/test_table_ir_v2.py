"""TableIR v2 normalization, native tabular parsing, and layered indexing."""

from __future__ import annotations

import io
from pathlib import Path

from openpyxl import Workbook

from app.services.ingest.adapters.mineru_ir import mineru_json_to_ir
from app.services.ingest.chunker import chunk_document
from app.services.ingest.index_record import build_table_records_from_chunks
from app.services.ingest.ir import NodeType
from app.services.ingest.parsers.pdf_route import probe_needs_mineru
from app.services.ingest.parsers.tabular import parse_csv, parse_xlsx
from app.services.ingest.pipeline import chunks_to_payloads
from app.services.ingest.table_ir import normalize_table
from app.services.table_query import (
	build_table_query_plan,
	execute_table_query,
	locate_best_table_instance,
)

TESTDATA = Path(__file__).resolve().parents[3] / "testdata"


def test_table_ir_infers_header_normalizes_values_and_separates_summary() -> None:
	table = normalize_table(
		table_id="t1",
		headers=[],
		rows=[
			["序号", "项目名称", "中标金额(元)", "中标日期"],
			["1", "云平台", "12.5万", "2026-07-01"],
			["汇总说明：共1项"] * 4,
		],
		page_start=1,
		page_end=3,
		allow_header_inference=True,
		cross_page_merged=True,
	)

	assert table.headers() == ["序号", "项目名称", "中标金额(元)", "中标日期"]
	assert len(table.rows) == 1
	assert len(table.summary_rows) == 1
	assert table.rows[0].cells[2].normalized_value == 125_000
	assert table.columns[2].data_type == "currency"
	assert table.columns[2].unit == "CNY"
	assert table.quality_report.header_inferred is True
	assert table.quality_report.cross_page_merged is True
	assert table.quality_report.executable is True


def test_headerless_table_fails_closed_for_execution() -> None:
	table = normalize_table(
		table_id="t1",
		headers=[],
		rows=[["甲", "1"], ["乙", "2"]],
	)
	assert table.headers() == []
	assert table.quality_report.executable is False
	assert "table has no explicit header" in table.quality_report.warnings


def test_mineru_td_header_and_empty_page_placeholders_preserve_cross_page_table() -> None:
	payload = {
		"version": "3.4.4",
		"content_list": [
			{
				"type": "table",
				"page_idx": 0,
				"table_body": (
					"<table><tr><td>序号</td><td>项目名称</td><td>金额(元)</td></tr>"
					"<tr><td>1</td><td>云平台</td><td>100000</td></tr>"
					"<tr><td colspan='3'>汇总说明：共1项</td></tr></table>"
				),
			},
			{"type": "table", "page_idx": 1, "bbox": [0, 10, 100, 200]},
			{"type": "table", "page_idx": 2, "bbox": [0, 10, 100, 80]},
		],
	}
	ir = mineru_json_to_ir(payload=payload, filename="cross.pdf", title="cross")
	table = next(node for node in ir.nodes if node.type == NodeType.TABLE)

	assert table.page_start == 1
	assert table.page_end == 3
	assert table.table_ir is not None
	assert table.table_ir.headers() == ["序号", "项目名称", "金额(元)"]
	assert table.table_ir.legacy_rows() == [["1", "云平台", "100000"]]
	assert len(table.table_ir.summary_rows) == 1
	assert table.table_ir.quality_report.cross_page_merged is True


def test_token_budget_splits_wide_rows_and_adds_table_summary_record() -> None:
	table = normalize_table(
		table_id="t1",
		headers=["项目", "详细说明"],
		rows=[[str(index), "复杂说明" * 80] for index in range(6)],
		caption="项目明细",
	)
	from app.services.ingest.ir import DocumentIR, Node

	doc = DocumentIR(
		id="doc-1",
		title="项目",
		source_format="xlsx",
		nodes=[
			Node(
				id="n1",
				type=NodeType.TABLE,
				table_id="t1",
				text="table",
				table_json={
					"headers": table.headers(),
					"rows": table.legacy_rows(),
				},
				table_ir=table,
			)
		],
	)
	chunks = chunk_document(doc)
	groups = build_table_records_from_chunks(
		chunks,
		doc_id="doc-1",
		max_rows=40,
		max_tokens=180,
	)
	assert len(groups) == 6
	assert all(group.row_start == group.row_end for group in groups)
	assert groups[0].cell_rows[0]["cells"][0]["raw_text"] == "0"
	assert groups[0].table_columns[0]["normalized_name"] == "项目"

	payloads = chunks_to_payloads(
		chunks,
		doc_id="doc-1",
		document_version_id="55555555-5555-5555-5555-555555555555",
		include_sections=False,
	)
	summaries = [item for item in payloads if item["record_type"] == "table_summary"]
	assert len(summaries) == 1
	assert summaries[0]["table_id"] == "t1"
	assert "字段：项目、详细说明" in summaries[0]["body"]
	assert summaries[0]["table_quality"]["executable"] is True


def test_csv_and_xlsx_use_native_table_ir() -> None:
	csv_ir = parse_csv(
		content="供应商,报价(元)\n甲公司,120000\n".encode(),
		filename="quote.csv",
		title="报价",
	)
	assert csv_ir.source_format == "csv"
	assert csv_ir.nodes[0].table_ir is not None
	assert csv_ir.nodes[0].table_ir.rows[0].cells[1].normalized_value == 120_000

	workbook = Workbook()
	sheet = workbook.active
	sheet.title = "报价单"
	sheet.append(["供应商", "报价(元)"])
	sheet.append(["甲公司", 120000])
	buffer = io.BytesIO()
	workbook.save(buffer)
	xlsx_ir = parse_xlsx(
		content=buffer.getvalue(),
		filename="quote.xlsx",
		title="报价",
	)
	assert xlsx_ir.source_format == "xlsx"
	assert xlsx_ir.nodes[0].table_ir is not None
	assert xlsx_ir.nodes[0].table_ir.caption == "报价单"


def test_ruled_digital_pdf_routes_to_mineru_probe() -> None:
	fixture = TESTDATA / "ab" / "crosstable-large.pdf"
	assert probe_needs_mineru(fixture.read_bytes()) is True


def test_table_row_hit_has_priority_and_summary_is_fallback() -> None:
	summary = {
		"record_type": "table_summary",
		"doc_id": "doc-summary",
		"document_version_id": "v1",
		"table_id": "t-summary",
		"headers": ["项目", "金额"],
		"score": 0.99,
	}
	row = {
		"record_type": "table",
		"doc_id": "doc-row",
		"document_version_id": "v1",
		"table_id": "t-row",
		"headers": ["项目", "金额"],
		"rows": [["目标项目", "100"]],
		"score": 0.7,
	}
	assert locate_best_table_instance([summary, row])["table_id"] == "t-row"
	assert locate_best_table_instance([summary])["table_id"] == "t-summary"


def test_locate_prefers_schema_fit_over_higher_retrieval_score() -> None:
	quote = {
		"record_type": "table",
		"doc_id": "doc-quote",
		"document_version_id": "v1",
		"table_id": "t-quote",
		"headers": ["序号", "设备名称", "单价（元）", "合计（元）"],
		"score": 0.4,
	}
	cross = {
		"record_type": "table",
		"doc_id": "doc-cross",
		"document_version_id": "v1",
		"table_id": "t-cross",
		"headers": ["序号", "项目名称", "中标金额(元)"],
		"score": 0.99,
	}
	q = "序号为1的设备是什么？单价和合计金额是多少？"
	assert locate_best_table_instance([cross, quote], question=q)["table_id"] == "t-quote"


def test_max_amount_query_executes_against_full_table_schema() -> None:
	headers = ["序号", "项目名称", "中标供应商", "中标金额(元)"]
	rows = [
		["4", "垃圾分类智能监管平台", "中移建设", "5,376,538"],
		["57", "医疗信息系统升级", "海康威视", "5,673,173"],
	]
	plan = build_table_query_plan(
		"中标金额最高的项目是什么，金额是多少？",
		headers=headers,
	)
	assert plan["operation"] == "max"
	assert plan["column"] == "中标金额(元)"
	result = execute_table_query(plan, headers=headers, rows=rows)
	assert result["ok"] is True
	assert result["answer_value"] == 5_673_173
	assert result["matched_rows"][0]["项目名称"] == "医疗信息系统升级"
