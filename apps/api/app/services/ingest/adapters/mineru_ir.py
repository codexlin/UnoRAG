"""MinerU content_list JSON → DocumentIR.

保留 page / heading / table / figure / bbox / reading_order，供 citation 与 table IndexRecord。
兼容常见 content_list 字段（text_level、table_body HTML、img_caption 等）。
"""

from __future__ import annotations

import re
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

_TAG_RE = re.compile(r"<[^>]+>")


class _TableHTMLParser(HTMLParser):
	def __init__(self) -> None:
		super().__init__()
		self.rows: list[list[str]] = []
		self._row: list[str] = []
		self._cell: list[str] = []
		self._in_cell = False

	def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
		if tag == "tr":
			self._row = []
		elif tag in {"td", "th"}:
			self._cell = []
			self._in_cell = True

	def handle_endtag(self, tag: str) -> None:
		if tag in {"td", "th"} and self._in_cell:
			self._row.append("".join(self._cell).strip())
			self._cell = []
			self._in_cell = False
		elif tag == "tr" and self._row:
			self.rows.append(self._row)
			self._row = []

	def handle_data(self, data: str) -> None:
		if self._in_cell:
			self._cell.append(data)


def parse_table_html(html: str) -> dict[str, Any]:
	"""简单 HTML table → {headers, rows}；无表结构时退回单行文本。"""
	parser = _TableHTMLParser()
	try:
		parser.feed(html or "")
	except Exception:
		text = _TAG_RE.sub(" ", html or "").strip()
		return {"headers": [], "rows": [[text]] if text else []}
	rows = parser.rows
	if not rows:
		text = _TAG_RE.sub(" ", html or "").strip()
		return {"headers": [], "rows": [[text]] if text else []}
	headers = rows[0]
	body = rows[1:] if len(rows) > 1 else []
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

		if kind in {"text", "discarded"}:
			text = str(item.get("text") or item.get("content") or "").strip()
			if not text or kind == "discarded":
				continue
			level = item.get("text_level")
			if level is not None:
				try:
					lvl = int(level)
				except (TypeError, ValueError):
					lvl = 0
				if lvl >= 1:
					nodes.append(
						Node(
							id=str(uuid4()),
							type=NodeType.HEADING,
							level=lvl,
							path=text,
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
			table_seq += 1
			table_id = f"mineru-t{table_seq}"
			html = str(item.get("table_body") or item.get("html") or "")
			table_json = item.get("table_json")
			if not isinstance(table_json, dict):
				table_json = parse_table_html(html) if html else {"headers": [], "rows": []}
			caption = _join_caption(item.get("table_caption") or item.get("caption"))
			headers = table_json.get("headers") or []
			rows = table_json.get("rows") or []
			textual = []
			if caption:
				textual.append(caption)
			if headers:
				textual.append(" | ".join(str(h) for h in headers))
			for row in rows:
				textual.append(" | ".join(str(c) for c in row))
			body = "\n".join(textual).strip() or html.strip()
			if not body and not headers and not rows:
				continue
			meta["caption"] = caption
			nodes.append(
				Node(
					id=str(uuid4()),
					type=NodeType.TABLE,
					page_start=page,
					page_end=page,
					text=body,
					table_json=table_json,
					table_id=table_id,
					confidence=0.72,
					meta=meta,
				)
			)
			continue

		if kind in {"image", "figure", "chart"}:
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
	content_list = payload.get("content_list")
	if content_list is None and isinstance(payload.get("result"), dict):
		content_list = payload["result"].get("content_list")
	if content_list is None and isinstance(payload.get("data"), dict):
		content_list = payload["data"].get("content_list")
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
