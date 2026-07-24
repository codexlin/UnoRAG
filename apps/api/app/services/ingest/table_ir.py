"""Canonical table model and compatibility helpers.

TableIR keeps one logical table intact while retrieval records may store row
groups.  Legacy ``headers``/``rows`` remain available so Phase 2B callers do
not need a flag day migration.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, Field

TableDataType = Literal[
	"string",
	"integer",
	"number",
	"currency",
	"percentage",
	"date",
	"boolean",
]

_NUMBER_RE = re.compile(r"^[+-]?\d[\d,]*(?:\.\d+)?$")
_DATE_RE = re.compile(r"^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$")
_SUMMARY_RE = re.compile(r"^(合计|总计|小计|汇总|汇总说明|备注|注[:：])")
_NOTE_RE = re.compile(r"^说明[:：]")
_UNIT_ALIASES = {
	"人民币元": "CNY",
	"万元": "CNY_10K",
	"元": "CNY",
	"%": "percent",
	"％": "percent",
	"kg": "kg",
	"千克": "kg",
	"天": "day",
	"日": "day",
}


class TableCell(BaseModel):
	raw_text: str = ""
	normalized_value: str | int | float | bool | None = None
	page: int | None = None
	bbox: list[float] | None = None
	confidence: float | None = None
	rowspan: int = 1
	colspan: int = 1


class TableColumn(BaseModel):
	name: str
	normalized_name: str
	data_type: TableDataType = "string"
	unit: str | None = None


class TableRow(BaseModel):
	cells: list[TableCell] = Field(default_factory=list)


class TableSummaryRow(BaseModel):
	raw_text: str
	cells: list[TableCell] = Field(default_factory=list)
	page: int | None = None


class TableQualityReport(BaseModel):
	score: float = 1.0
	executable: bool = True
	header_inferred: bool = False
	header_confidence: float | None = None
	expected_columns: int = 0
	irregular_row_count: int = 0
	low_confidence_cell_count: int = 0
	cross_page_merged: bool = False
	warnings: list[str] = Field(default_factory=list)


class TableIR(BaseModel):
	version: str = "v2"
	table_id: str
	page_start: int | None = None
	page_end: int | None = None
	caption: str = ""
	header_rows: list[list[str]] = Field(default_factory=list)
	columns: list[TableColumn] = Field(default_factory=list)
	rows: list[TableRow] = Field(default_factory=list)
	summary_rows: list[TableSummaryRow] = Field(default_factory=list)
	footnotes: list[str] = Field(default_factory=list)
	quality_report: TableQualityReport = Field(default_factory=TableQualityReport)

	def headers(self) -> list[str]:
		return [column.name for column in self.columns]

	def legacy_rows(self) -> list[list[str]]:
		return [[cell.raw_text for cell in row.cells] for row in self.rows]

	def summary_text(self) -> str:
		parts = [self.caption.strip()] if self.caption.strip() else []
		headers = self.headers()
		if headers:
			parts.append("字段：" + "、".join(headers))
		parts.append(f"共{len(self.rows)}条数据")
		units = [
			f"{column.normalized_name}={column.unit}"
			for column in self.columns
			if column.unit
		]
		if units:
			parts.append("单位：" + "，".join(units))
		if self.summary_rows:
			summary_bits = [
				row.raw_text.strip()
				for row in self.summary_rows
				if (row.raw_text or "").strip()
			]
			if summary_bits:
				parts.append("汇总：" + "；".join(summary_bits[:5]))
		if self.footnotes:
			parts.append("备注：" + "；".join(self.footnotes[:3]))
		return "；".join(parts)


def normalize_table(
	*,
	table_id: str,
	headers: list[Any] | None,
	rows: list[list[Any]] | None,
	page_start: int | None = None,
	page_end: int | None = None,
	caption: str = "",
	header_rows: list[list[Any]] | None = None,
	footnotes: list[Any] | None = None,
	confidence: float | None = None,
	allow_header_inference: bool = False,
	cross_page_merged: bool = False,
) -> TableIR:
	"""Build TableIR v2, conservatively repairing common parser artifacts."""
	raw_rows = [[_text(cell) for cell in row] for row in (rows or [])]
	resolved_headers = [_text(value) for value in (headers or [])]
	resolved_header_rows = [
		[_text(value) for value in row] for row in (header_rows or [])
	]
	header_inferred = False
	header_confidence: float | None = None

	if not resolved_headers and allow_header_inference and _looks_like_header_row(raw_rows):
		resolved_headers = raw_rows.pop(0)
		resolved_header_rows = [list(resolved_headers)]
		header_inferred = True
		header_confidence = 0.86
	elif resolved_headers and not resolved_header_rows:
		resolved_header_rows = [list(resolved_headers)]

	expected_columns = len(resolved_headers)
	if not expected_columns and raw_rows:
		expected_columns = max(len(row) for row in raw_rows)

	summary_rows: list[TableSummaryRow] = []
	data_rows: list[list[str]] = []
	irregular = 0
	for row in raw_rows:
		if _is_summary_row(row):
			unique = list(dict.fromkeys(cell for cell in row if cell))
			text = " | ".join(unique)
			summary_rows.append(
				TableSummaryRow(
					raw_text=text,
					cells=[
						TableCell(
							raw_text=text,
							normalized_value=text,
							page=page_end or page_start,
							confidence=confidence,
							colspan=max(1, expected_columns),
						)
					],
					page=page_end or page_start,
				)
			)
			continue
		if expected_columns and len(row) != expected_columns:
			irregular += 1
			row = [*row[:expected_columns], *([""] * max(0, expected_columns - len(row)))]
		data_rows.append(row)

	columns = _infer_columns(resolved_headers, data_rows)
	table_rows: list[TableRow] = []
	low_confidence = 0
	cell_page = page_start if page_end in {None, page_start} else None
	for row in data_rows:
		cells: list[TableCell] = []
		for index, raw in enumerate(row):
			column = columns[index] if index < len(columns) else None
			cell_confidence = confidence
			if cell_confidence is not None and cell_confidence < 0.6:
				low_confidence += 1
			cells.append(
				TableCell(
					raw_text=raw,
					normalized_value=_normalize_value(raw, column),
					page=cell_page,
					confidence=cell_confidence,
				)
			)
		table_rows.append(TableRow(cells=cells))

	warnings: list[str] = []
	if header_inferred:
		warnings.append("table header inferred from first data row")
	if not headers and not header_inferred:
		warnings.append("table has no explicit header")
	if irregular:
		warnings.append(f"{irregular} rows have irregular column counts")
	if summary_rows:
		warnings.append(f"{len(summary_rows)} summary rows separated from data")
	if page_start is not None and page_end not in {None, page_start}:
		warnings.append("cell-level page unavailable for cross-page merged table")

	score = 1.0
	if not headers and not header_inferred:
		score -= 0.35
	if header_inferred:
		score -= 0.08
	if irregular:
		score -= min(0.3, irregular / max(1, len(raw_rows)) * 0.5)
	if low_confidence:
		score -= min(0.3, low_confidence / max(1, len(data_rows) * expected_columns) * 0.5)
	score = round(max(0.0, min(1.0, score)), 3)
	executable = bool(resolved_headers) and score >= 0.65 and irregular <= max(
		1, len(data_rows) // 20
	)

	return TableIR(
		table_id=table_id,
		page_start=page_start,
		page_end=page_end if page_end is not None else page_start,
		caption=caption.strip(),
		header_rows=resolved_header_rows,
		columns=columns,
		rows=table_rows,
		summary_rows=summary_rows,
		footnotes=[_text(value) for value in (footnotes or []) if _text(value)],
		quality_report=TableQualityReport(
			score=score,
			executable=executable,
			header_inferred=header_inferred,
			header_confidence=header_confidence,
			expected_columns=expected_columns,
			irregular_row_count=irregular,
			low_confidence_cell_count=low_confidence,
			cross_page_merged=cross_page_merged,
			warnings=warnings,
		),
	)


def table_ir_from_legacy(
	table_json: dict[str, Any] | list[Any] | None,
	*,
	table_id: str,
	page_start: int | None = None,
	page_end: int | None = None,
	caption: str = "",
	confidence: float | None = None,
	allow_header_inference: bool = False,
) -> TableIR:
	if isinstance(table_json, dict) and table_json.get("table_ir_version") == "v2":
		payload = table_json.get("table_ir")
		if isinstance(payload, dict):
			return TableIR.model_validate(payload)
	if isinstance(table_json, list):
		rows = table_json
		headers: list[Any] = []
	else:
		payload = table_json if isinstance(table_json, dict) else {}
		headers = list(payload.get("headers") or [])
		rows = list(payload.get("rows") or [])
		caption = str(payload.get("caption") or caption)
	return normalize_table(
		table_id=table_id,
		headers=headers,
		rows=rows,
		page_start=page_start,
		page_end=page_end,
		caption=caption,
		confidence=confidence,
		allow_header_inference=allow_header_inference,
	)


def table_ir_to_legacy(table: TableIR) -> dict[str, Any]:
	"""Return the old surface plus an embedded lossless v2 representation."""
	return {
		"headers": table.headers(),
		"rows": table.legacy_rows(),
		"caption": table.caption,
		"header_rows": table.header_rows,
		"summary_rows": [row.raw_text for row in table.summary_rows],
		"footnotes": list(table.footnotes),
		"quality_report": table.quality_report.model_dump(),
		"table_ir_version": "v2",
	}


def _text(value: Any) -> str:
	return str(value or "").strip()


def _looks_like_header_row(rows: list[list[str]]) -> bool:
	if len(rows) < 2:
		return False
	first = rows[0]
	second = rows[1]
	if len(first) < 2 or len(first) != len(second):
		return False
	if any(not cell for cell in first):
		return False
	label_count = sum(not _NUMBER_RE.match(cell.replace(" ", "")) for cell in first)
	second_numeric = sum(_NUMBER_RE.match(cell.replace(" ", "")) is not None for cell in second)
	header_words = sum(
		any(token in cell for token in ("名称", "序号", "金额", "日期", "单位", "供应商", "数量", "项目"))
		for cell in first
	)
	return label_count == len(first) and (header_words >= 1 or second_numeric >= 1)


def _is_summary_row(row: list[str]) -> bool:
	nonempty = [cell.strip() for cell in row if cell.strip()]
	if not nonempty:
		return False
	first = nonempty[0]
	if _SUMMARY_RE.match(first) is not None:
		return True
	if _NOTE_RE.match(first) is not None:
		return len(nonempty) <= 2 or len(set(nonempty)) == 1
	return False


def _normalize_header(value: str) -> tuple[str, str | None]:
	name = value.strip()
	unit: str | None = None
	for raw, normalized in _UNIT_ALIASES.items():
		if raw in name:
			unit = normalized
			name = re.sub(rf"[\(（]?\s*{re.escape(raw)}\s*[\)）]?", "", name).strip()
			break
	return name or value.strip(), unit


def _infer_columns(headers: list[str], rows: list[list[str]]) -> list[TableColumn]:
	columns: list[TableColumn] = []
	for index, header in enumerate(headers):
		normalized_name, unit = _normalize_header(header)
		values = [row[index] for row in rows if index < len(row) and row[index].strip()]
		data_type: TableDataType = "string"
		if unit == "percent" or any("%" in value or "％" in value for value in values[:20]):
			data_type = "percentage"
		elif (unit and unit.startswith("CNY")) or any(
			token in header for token in ("金额", "报价", "单价", "总价")
		):
			data_type = "currency"
			unit = unit or "CNY"
		elif values and all(_DATE_RE.match(value) for value in values[:20]):
			data_type = "date"
		elif values and all(_NUMBER_RE.match(value.replace(" ", "")) for value in values[:20]):
			data_type = (
				"integer"
				if all("." not in value for value in values[:20])
				else "number"
			)
		columns.append(
			TableColumn(
				name=header,
				normalized_name=normalized_name,
				data_type=data_type,
				unit=unit,
			)
		)
	return columns


def _normalize_value(raw: str, column: TableColumn | None) -> str | int | float | bool | None:
	value = raw.strip()
	if not value:
		return None
	if column is None:
		return value
	if column.data_type == "date":
		match = _DATE_RE.match(value)
		if match:
			try:
				return date(*(int(part) for part in match.groups())).isoformat()
			except ValueError:
				return value
	if column.data_type == "percentage":
		number = value.replace(",", "").replace("%", "").replace("％", "").strip()
		try:
			return float(number) / 100.0
		except ValueError:
			return value
	if column.data_type in {"integer", "number", "currency"}:
		number = value.replace(",", "").replace("¥", "").replace("￥", "").strip()
		multiplier = 1
		for suffix, factor in (("亿元", 100_000_000), ("万元", 10_000), ("万", 10_000), ("千", 1_000), ("元", 1)):
			if number.endswith(suffix):
				number = number[: -len(suffix)].strip()
				multiplier = factor
				break
		try:
			numeric = float(number) * multiplier
			return int(numeric) if numeric.is_integer() else numeric
		except ValueError:
			return value
	return value
