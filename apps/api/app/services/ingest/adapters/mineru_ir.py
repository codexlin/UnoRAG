"""MinerU content_list JSON → DocumentIR.

保留 page / heading / table / figure / bbox / reading_order，供 citation 与 table IndexRecord。
兼容常见 content_list 字段（text_level、table_body HTML、img_caption 等）。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any
from uuid import uuid4

from app.services.ingest.ir import (
	DocumentIR,
	Node,
	NodeType,
	ParserReport,
	content_hash_bytes,
)
from app.services.ingest.table_ir import (
	normalize_table,
	table_ir_to_legacy,
)

_TAG_RE = re.compile(r"<[^>]+>")
_STRONG_CONTINUATION_RE = re.compile(
	r"(?:[（(]\s*(?:续|continued)\s*[）)]|(?:续表|续上表)|continued)",
	re.IGNORECASE,
)
_PAGE_MARKER_RE = re.compile(r"第\s*\d+\s*页", re.IGNORECASE)
_IGNORABLE_PAGE_KINDS = {
	"discarded",
	"header",
	"footer",
	"page_header",
	"page_footer",
	"page_number",
	"aside_text",
	"page_aside_text",
	"page_footnote",
}


@dataclass
class _TableCell:
	text: str
	is_header: bool
	rowspan: int = 1
	colspan: int = 1


class _TableHTMLParser(HTMLParser):
	def __init__(self) -> None:
		super().__init__()
		self.rows: list[list[_TableCell]] = []
		self._row: list[_TableCell] = []
		self._cell: list[str] = []
		self._in_cell = False
		self._cell_is_header = False
		self._rowspan = 1
		self._colspan = 1

	def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
		if tag == "tr":
			self._row = []
		elif tag in {"td", "th"}:
			attr_map = {key.lower(): value for key, value in attrs}
			self._cell = []
			self._in_cell = True
			self._cell_is_header = tag == "th"
			self._rowspan = _positive_span(attr_map.get("rowspan"))
			self._colspan = _positive_span(attr_map.get("colspan"))

	def handle_endtag(self, tag: str) -> None:
		if tag in {"td", "th"} and self._in_cell:
			self._row.append(
				_TableCell(
					text="".join(self._cell).strip(),
					is_header=self._cell_is_header,
					rowspan=self._rowspan,
					colspan=self._colspan,
				)
			)
			self._cell = []
			self._in_cell = False
		elif tag == "tr" and self._row:
			self.rows.append(self._row)
			self._row = []

	def handle_data(self, data: str) -> None:
		if self._in_cell:
			self._cell.append(data)


def _positive_span(value: str | None) -> int:
	try:
		return min(100, max(1, int(value or 1)))
	except (TypeError, ValueError):
		return 1


def _expand_table_rows(
	raw_rows: list[list[_TableCell]],
) -> tuple[list[list[str]], list[list[bool]]]:
	grid: dict[tuple[int, int], tuple[str, bool]] = {}
	max_col = 0
	for row_idx, raw_row in enumerate(raw_rows):
		col_idx = 0
		for cell in raw_row:
			while (row_idx, col_idx) in grid:
				col_idx += 1
			for row_offset in range(cell.rowspan):
				for col_offset in range(cell.colspan):
					grid[(row_idx + row_offset, col_idx + col_offset)] = (
						cell.text,
						cell.is_header,
					)
			col_idx += cell.colspan
			max_col = max(max_col, col_idx)

	if not grid:
		return [], []
	row_count = max(row for row, _ in grid) + 1
	max_col = max(max_col, max(col for _, col in grid) + 1)
	rows: list[list[str]] = []
	header_flags: list[list[bool]] = []
	for row_idx in range(row_count):
		rows.append([grid.get((row_idx, col), ("", False))[0] for col in range(max_col)])
		header_flags.append(
			[grid.get((row_idx, col), ("", False))[1] for col in range(max_col)]
		)
	return rows, header_flags


def _header_row_count(rows: list[list[str]], flags: list[list[bool]]) -> int:
	count = 0
	for row, row_flags in zip(rows, flags, strict=True):
		nonempty = [idx for idx, value in enumerate(row) if value.strip()]
		if not nonempty or not all(row_flags[idx] for idx in nonempty):
			break
		count += 1
	return count


def _flatten_headers(rows: list[list[str]]) -> list[str]:
	if not rows:
		return []
	headers: list[str] = []
	for column in zip(*rows, strict=True):
		parts = list(dict.fromkeys(value.strip() for value in column if value.strip()))
		headers.append(" / ".join(parts))
	return headers


def parse_table_html(html: str) -> dict[str, Any]:
	"""HTML table → {headers, rows}，展开 rowspan/colspan 且不臆造表头。"""
	parser = _TableHTMLParser()
	try:
		parser.feed(html or "")
	except Exception:
		text = _TAG_RE.sub(" ", html or "").strip()
		return {"headers": [], "rows": [[text]] if text else []}
	rows, header_flags = _expand_table_rows(parser.rows)
	if not rows:
		text = _TAG_RE.sub(" ", html or "").strip()
		return {"headers": [], "rows": [[text]] if text else []}
	header_count = _header_row_count(rows, header_flags)
	headers = _flatten_headers(rows[:header_count])
	body = rows[header_count:]
	return {"headers": headers, "rows": body}


def _page_number(item: dict[str, Any]) -> int:
	idx = item.get("page_idx", item.get("page", 0))
	try:
		return int(idx) + 1
	except (TypeError, ValueError):
		return 1


def _bbox(item: dict[str, Any]) -> list[float] | None:
	raw = item.get("bbox")
	if not isinstance(raw, (list, tuple)) or len(raw) < 4:
		return None
	try:
		return [float(raw[0]), float(raw[1]), float(raw[2]), float(raw[3])]
	except (TypeError, ValueError):
		return None


def _join_caption(value: Any) -> str:
	if value is None:
		return ""
	if isinstance(value, str):
		return value.strip()
	if isinstance(value, list):
		parts = [str(x).strip() for x in value if str(x).strip()]
		return " ".join(parts)
	return str(value).strip()


def content_list_to_nodes(content_list: list[dict[str, Any]]) -> list[Node]:
	"""按 reading order 将 MinerU content_list 转为 IR nodes。"""
	nodes: list[Node] = []
	table_seq = 0
	figure_seq = 0
	heading_stack: list[str] = []
	last_table: Node | None = None

	for order, item in enumerate(content_list):
		if not isinstance(item, dict):
			continue
		kind = str(item.get("type") or "text").lower()
		page = _page_number(item)
		bbox = _bbox(item)
		meta: dict[str, Any] = {
			"reading_order": order,
			"mineru_type": kind,
		}
		if bbox is not None:
			meta["bbox"] = bbox

		# 页眉/页脚等辅助块不进入正文，也不打断紧邻跨页表的续接判断。
		if kind in _IGNORABLE_PAGE_KINDS:
			continue

		if kind == "text":
			last_table = None
			text = str(item.get("text") or item.get("content") or "").strip()
			if not text:
				continue
			level = item.get("text_level")
			if level is not None:
				try:
					lvl = int(level)
				except (TypeError, ValueError):
					lvl = 0
				if lvl >= 1:
					heading_stack = heading_stack[: max(0, lvl - 1)]
					heading_stack.append(text)
					nodes.append(
						Node(
							id=str(uuid4()),
							type=NodeType.HEADING,
							level=lvl,
							path=" / ".join(heading_stack),
							page_start=page,
							page_end=page,
							text=text,
							confidence=0.75,
							meta=meta,
						)
					)
					continue
			nodes.append(
				Node(
					id=str(uuid4()),
					type=NodeType.PARAGRAPH,
					page_start=page,
					page_end=page,
					text=text,
					confidence=0.7,
					meta=meta,
				)
			)
			continue

		if kind == "list":
			last_table = None
			text = str(item.get("text") or item.get("content") or "").strip()
			if not text and isinstance(item.get("list_items"), list):
				text = "\n".join(str(x).strip() for x in item["list_items"] if str(x).strip())
			if not text:
				continue
			nodes.append(
				Node(
					id=str(uuid4()),
					type=NodeType.LIST,
					page_start=page,
					page_end=page,
					text=text,
					confidence=0.7,
					meta=meta,
				)
			)
			continue

		if kind == "table":
			html = str(item.get("table_body") or item.get("html") or "")
			table_json = item.get("table_json")
			if not isinstance(table_json, dict):
				table_json = parse_table_html(html) if html else {"headers": [], "rows": []}
			caption = _join_caption(item.get("table_caption") or item.get("caption"))
			footnote = _join_caption(item.get("table_footnote") or item.get("footnote"))
			headers = table_json.get("headers") or []
			rows = table_json.get("rows") or []
			source_table_id = str(item.get("table_id") or item.get("id") or "").strip()
			if _is_table_continuation(
				previous=last_table,
				page=page,
				caption=caption,
				headers=headers,
				rows=rows,
				source_table_id=source_table_id,
				item=item,
			):
				_merge_table_continuation(
					last_table,
					page=page,
					caption=caption,
					rows=rows,
					bbox=bbox,
				)
				continue

			# MinerU may emit a body only on the first page plus empty table
			# placeholders on continuation pages. They still carry provenance.
			if not html and not headers and not rows and last_table is not None:
				if last_table.page_end is not None and page == last_table.page_end + 1:
					last_table.page_end = page
					last_table.meta.setdefault("continuation_pages", []).append(page)
					if bbox is not None:
						last_table.meta.setdefault("page_bboxes", []).append(
							{"page": page, "bbox": bbox}
						)
					_refresh_node_table_ir(last_table, cross_page_merged=True)
					continue

			table_seq += 1
			table_id = source_table_id or f"mineru-t{table_seq}"
			table_ir = normalize_table(
				table_id=table_id,
				headers=list(headers),
				rows=list(rows),
				page_start=page,
				page_end=page,
				caption=caption,
				footnotes=[footnote] if footnote else [],
				confidence=0.72,
				allow_header_inference=True,
			)
			table_json = table_ir_to_legacy(table_ir)
			headers = table_ir.headers()
			rows = table_ir.legacy_rows()
			textual = []
			if caption:
				textual.append(caption)
			if headers:
				textual.append(" | ".join(str(h) for h in headers))
			for row in rows:
				textual.append(" | ".join(str(c) for c in row))
			body = "\n".join(textual).strip() or html.strip()
			if not body and not headers and not rows:
				last_table = None
				continue
			meta["caption"] = caption
			meta["source_table_id"] = source_table_id
			table_node = Node(
				id=str(uuid4()),
				type=NodeType.TABLE,
				page_start=page,
				page_end=page,
				text=body,
				table_json=table_json,
				table_ir=table_ir,
				table_id=table_id,
				confidence=0.72,
				meta=meta,
			)
			nodes.append(table_node)
			last_table = table_node
			continue

		if kind in {"image", "figure", "chart"}:
			last_table = None
			figure_seq += 1
			figure_id = f"mineru-f{figure_seq}"
			caption = _join_caption(
				item.get("img_caption")
				or item.get("image_caption")
				or item.get("caption")
				or item.get("figure_caption")
			)
			footnote = _join_caption(item.get("img_footnote") or item.get("footnote"))
			parts = [p for p in (caption, footnote) if p]
			desc = " ".join(parts).strip()
			if not desc:
				desc = f"[figure {figure_seq}]"
			meta["caption"] = caption
			nodes.append(
				Node(
					id=str(uuid4()),
					type=NodeType.FIGURE,
					page_start=page,
					page_end=page,
					text=desc,
					figure_desc=desc,
					figure_id=figure_id,
					confidence=0.65,
					meta=meta,
				)
			)
			continue

		if kind in {"equation", "formula"}:
			last_table = None
			latex = str(
				item.get("text") or item.get("latex") or item.get("content") or ""
			).strip()
			if not latex:
				continue
			meta["text_format"] = str(item.get("text_format") or "latex")
			nodes.append(
				Node(
					id=str(uuid4()),
					type=NodeType.PARAGRAPH,
					page_start=page,
					page_end=page,
					text=latex,
					confidence=0.68,
					meta=meta,
				)
			)
			continue

		if kind == "code":
			last_table = None
			code = str(
				item.get("code_body") or item.get("text") or item.get("content") or ""
			).strip()
			if not code:
				continue
			nodes.append(
				Node(
					id=str(uuid4()),
					type=NodeType.CODE,
					page_start=page,
					page_end=page,
					text=code,
					confidence=0.7,
					meta=meta,
				)
			)
			continue

		# 未知类型：尽量保留文本
		last_table = None
		fallback = str(item.get("text") or item.get("content") or "").strip()
		if fallback:
			nodes.append(
				Node(
					id=str(uuid4()),
					type=NodeType.PARAGRAPH,
					page_start=page,
					page_end=page,
					text=fallback,
					confidence=0.5,
					meta=meta,
				)
			)

	return nodes


def _normalized_caption(caption: str) -> str:
	without_marker = _STRONG_CONTINUATION_RE.sub("", caption or "")
	without_marker = _PAGE_MARKER_RE.sub("", without_marker)
	without_empty_parens = re.sub(r"[（(]\s*[）)]", "", without_marker)
	return re.sub(r"\s+", "", without_empty_parens).strip("：:.-_")


def _table_width(headers: list[Any], rows: list[Any]) -> int:
	width = len(headers)
	for row in rows:
		if isinstance(row, (list, tuple)):
			width = max(width, len(row))
	return width


def _is_true(value: Any) -> bool:
	if value is True or value == 1:
		return True
	if isinstance(value, str):
		return value.strip().lower() in {"true", "1", "yes"}
	return False


def _is_table_continuation(
	*,
	previous: Node | None,
	page: int,
	caption: str,
	headers: list[Any],
	rows: list[Any],
	source_table_id: str,
	item: dict[str, Any],
) -> bool:
	if previous is None or previous.page_end is None or page != previous.page_end + 1:
		return False
	previous_json = previous.table_json if isinstance(previous.table_json, dict) else {}
	previous_headers = [str(value).strip() for value in previous_json.get("headers") or []]
	current_headers = [str(value).strip() for value in headers]
	previous_rows = list(previous_json.get("rows") or [])
	previous_width = _table_width(previous_headers, previous_rows)
	current_width = _table_width(current_headers, rows)
	if current_width <= 0:
		return False
	if previous_width and current_width and previous_width != current_width:
		return False
	if previous_headers and current_headers and current_headers != previous_headers:
		return False

	previous_source_id = str((previous.meta or {}).get("source_table_id") or "")
	if source_table_id and previous_source_id and source_table_id == previous_source_id:
		return True
	has_explicit_flag = any(
		_is_true(item.get(key))
		for key in ("is_continued", "continued", "is_table_continuation")
	)
	has_caption_marker = bool(_STRONG_CONTINUATION_RE.search(caption or ""))
	if not has_explicit_flag and not has_caption_marker:
		return False

	previous_caption = str((previous.meta or {}).get("caption") or "")
	if has_explicit_flag:
		return True
	normalized_current = _normalized_caption(caption)
	normalized_previous = _normalized_caption(previous_caption)
	return bool(
		normalized_current
		and normalized_previous
		and normalized_current == normalized_previous
	)


def _merge_table_continuation(
	previous: Node,
	*,
	page: int,
	caption: str,
	rows: list[Any],
	bbox: list[float] | None,
) -> None:
	table_json = previous.table_json if isinstance(previous.table_json, dict) else {}
	existing_rows = list(table_json.get("rows") or [])
	table_json["rows"] = [*existing_rows, *rows]
	previous.table_json = table_json
	previous.page_end = page
	meta = previous.meta or {}
	meta.setdefault("continuation_pages", []).append(page)
	if bbox is not None:
		meta.setdefault("page_bboxes", []).append({"page": page, "bbox": bbox})
	if caption:
		meta.setdefault("continuation_captions", []).append(caption)
	previous.meta = meta
	_refresh_node_table_ir(previous, cross_page_merged=True)
	table_json = previous.table_json if isinstance(previous.table_json, dict) else {}
	textual = []
	base_caption = str(meta.get("caption") or "")
	if base_caption:
		textual.append(base_caption)
	headers = table_json.get("headers") or []
	if headers:
		textual.append(" | ".join(str(value) for value in headers))
	for row in table_json.get("rows") or []:
		textual.append(" | ".join(str(value) for value in row))
	previous.text = "\n".join(textual).strip()


def _refresh_node_table_ir(previous: Node, *, cross_page_merged: bool) -> None:
	table_json = previous.table_json if isinstance(previous.table_json, dict) else {}
	meta = previous.meta or {}
	existing_ir = previous.table_ir
	table_ir = normalize_table(
		table_id=previous.table_id or "table",
		headers=list(table_json.get("headers") or []),
		rows=list(table_json.get("rows") or []),
		page_start=previous.page_start,
		page_end=previous.page_end,
		caption=str(meta.get("caption") or ""),
		footnotes=(
			list(existing_ir.footnotes)
			if existing_ir is not None
			else list(table_json.get("footnotes") or [])
		),
		confidence=previous.confidence,
		cross_page_merged=cross_page_merged,
	)
	if existing_ir is not None and existing_ir.summary_rows:
		seen = {row.raw_text for row in table_ir.summary_rows}
		table_ir.summary_rows.extend(
			row for row in existing_ir.summary_rows if row.raw_text not in seen
		)
		table_ir.quality_report.warnings = list(
			dict.fromkeys(
				[
					*table_ir.quality_report.warnings,
					f"{len(table_ir.summary_rows)} summary rows separated from data",
				]
			)
		)
	if existing_ir is not None and existing_ir.quality_report.header_inferred:
		table_ir.quality_report.header_inferred = True
		table_ir.quality_report.header_confidence = (
			existing_ir.quality_report.header_confidence
		)
		table_ir.quality_report.score = min(
			table_ir.quality_report.score,
			existing_ir.quality_report.score,
		)
		table_ir.quality_report.warnings = list(
			dict.fromkeys(
				[
					"table header inferred from first data row",
					*table_ir.quality_report.warnings,
				]
			)
		)
	previous.table_ir = table_ir
	previous.table_json = table_ir_to_legacy(table_ir)


def _decode_content_list(value: Any) -> list[Any] | None:
	if value is None:
		return None
	if isinstance(value, list):
		return value
	if isinstance(value, str):
		try:
			decoded = json.loads(value)
		except json.JSONDecodeError as exc:
			raise ValueError("MinerU content_list is invalid JSON") from exc
		if isinstance(decoded, list):
			return decoded
		raise ValueError("MinerU content_list JSON must decode to a list")
	raise ValueError("MinerU content_list must be a list or JSON string")


def _extract_content_list(payload: dict[str, Any], *, filename: str) -> list[Any] | None:
	if "content_list" in payload:
		return _decode_content_list(payload.get("content_list"))
	for wrapper in ("result", "data"):
		nested = payload.get(wrapper)
		if isinstance(nested, dict):
			found = _extract_content_list(nested, filename=filename)
			if found is not None:
				return found

	results = payload.get("results")
	if isinstance(results, dict):
		basename = filename.replace("\\", "/").rsplit("/", 1)[-1]
		stem = basename.rsplit(".", 1)[0]
		candidates = [
			results.get(filename),
			results.get(basename),
			results.get(stem),
		]
		if len(results) == 1:
			candidates.append(next(iter(results.values())))
		for candidate in candidates:
			if isinstance(candidate, dict):
				found = _extract_content_list(candidate, filename=filename)
				if found is not None:
					return found
	elif isinstance(results, list):
		for candidate in results:
			if isinstance(candidate, dict):
				found = _extract_content_list(candidate, filename=filename)
				if found is not None:
					return found
	return None


def mineru_json_to_ir(
	*,
	payload: dict[str, Any],
	filename: str,
	title: str,
	content: bytes | None = None,
	doc_id: str | None = None,
	library_id: str = "",
	parser_version: str = "unknown",
	latency_ms: float | None = None,
	failed_pages: list[int] | None = None,
) -> DocumentIR:
	"""将 MinerU 服务响应（或 content_list 包装）转为 DocumentIR。"""
	content_list = _extract_content_list(payload, filename=filename)
	if not isinstance(content_list, list):
		raise ValueError("MinerU response missing content_list")

	nodes = content_list_to_nodes(content_list)
	pages = sorted({n.page_start for n in nodes if n.page_start is not None})
	failed = list(failed_pages or payload.get("failed_pages") or [])
	version = str(
		payload.get("version")
		or payload.get("parser_version")
		or parser_version
		or "unknown"
	)
	report = ParserReport(
		source_format="pdf",
		parser="mineru",
		backend="mineru",
		parser_version=version,
		mode="mineru",
		text_pages=pages,
		failed_pages=[int(p) for p in failed],
		partial=bool(failed),
		latency_ms=latency_ms,
		notes=str(payload.get("notes") or ""),
		metrics={
			"node_count": len(nodes),
			"table_count": sum(1 for n in nodes if n.type == NodeType.TABLE),
			"figure_count": sum(1 for n in nodes if n.type == NodeType.FIGURE),
			"heading_count": sum(1 for n in nodes if n.type == NodeType.HEADING),
		},
	)
	if not nodes:
		raise ValueError(
			"MinerU returned empty content_list (no nodes); refusing silent empty document"
		)
	if failed:
		report.warnings.append(f"MinerU failed pages: {failed}")
		report.notes = report.notes or f"partial via MinerU; failed_pages={failed}"

	digest = content_hash_bytes(content) if content is not None else ""
	return DocumentIR(
		id=doc_id or str(uuid4()),
		library_id=library_id,
		source=filename,
		source_format="pdf",
		title=title,
		filename=filename,
		content_hash=digest,
		nodes=nodes,
		parser_report=report,
		meta={"parser_backend": "mineru", "parser_version": version},
	)
