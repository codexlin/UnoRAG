"""DOCX parser — python-docx styles → heading 树 / 表 / 段落。"""

from __future__ import annotations

import re
from uuid import uuid4

from app.services.ingest.ir import (
	DocumentIR,
	Node,
	NodeType,
	ParserReport,
	content_hash_bytes,
)

_HEADING_STYLE = re.compile(r"heading\s*(\d+)", re.IGNORECASE)


def parse_docx(
	*,
	content: bytes,
	filename: str,
	title: str,
	doc_id: str | None = None,
	library_id: str = "",
) -> DocumentIR:
	try:
		from docx import Document
		from docx.oxml.ns import qn
		from docx.table import Table as DocxTable
		from docx.text.paragraph import Paragraph
	except ImportError as exc:
		raise ValueError(
			"DOCX support requires python-docx; install project dependencies (python-docx)"
		) from exc

	import io

	document = Document(io.BytesIO(content))
	nodes: list[Node] = []
	heading_stack: list[tuple[int, str]] = []
	table_id_seq = 0

	def section_path() -> str | None:
		if not heading_stack:
			return None
		return " / ".join(h[1] for h in heading_stack)

	# 按文档顺序遍历：段落与表格交错
	body = document.element.body
	for child in body.iterchildren():
		tag = child.tag
		if tag == qn("w:p"):
			para = Paragraph(child, document)
			text = (para.text or "").strip()
			if not text:
				continue
			style_name = ""
			try:
				style_name = (para.style.name or "") if para.style else ""
			except Exception:
				style_name = ""
			match = _HEADING_STYLE.search(style_name)
			if match:
				level = int(match.group(1))
				while heading_stack and heading_stack[-1][0] >= level:
					heading_stack.pop()
				heading_stack.append((level, text))
				nodes.append(
					Node(
						id=str(uuid4()),
						type=NodeType.HEADING,
						path=section_path(),
						level=level,
						text=text,
						confidence=0.9,
					)
				)
			else:
				nodes.append(
					Node(
						id=str(uuid4()),
						type=NodeType.PARAGRAPH,
						path=section_path(),
						text=text,
						confidence=0.85,
					)
				)
		elif tag == qn("w:tbl"):
			table = DocxTable(child, document)
			table_id_seq += 1
			table_id = f"t{table_id_seq}"
			rows_data: list[list[str]] = []
			for row in table.rows:
				rows_data.append([(cell.text or "").strip() for cell in row.cells])
			headers = rows_data[0] if rows_data else []
			body_rows = rows_data[1:] if len(rows_data) > 1 else []
			table_json = {"headers": headers, "rows": body_rows}
			textual_parts = [" | ".join(headers)] if headers else []
			for row in body_rows:
				textual_parts.append(" | ".join(row))
			textual = "\n".join(textual_parts).strip()
			if not textual:
				continue
			nodes.append(
				Node(
					id=str(uuid4()),
					type=NodeType.TABLE,
					path=section_path(),
					text=textual,
					table_json=table_json,
					table_id=table_id,
					confidence=0.9,
				)
			)

	if not nodes:
		raise ValueError("DOCX produced no content nodes")

	doc_title = title
	for node in nodes:
		if node.type == NodeType.HEADING and node.level == 1:
			doc_title = node.text
			break

	return DocumentIR(
		id=doc_id or str(uuid4()),
		library_id=library_id,
		source=filename,
		source_format="docx",
		title=doc_title,
		filename=filename,
		content_hash=content_hash_bytes(content),
		nodes=nodes,
		parser_report=ParserReport(
			source_format="docx",
			parser="python_docx",
			notes="heading styles + tables preserved",
		),
	)
