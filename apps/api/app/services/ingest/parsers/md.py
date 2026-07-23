"""Markdown parser — 轻量 AST：heading / list / code / table / paragraph → IR。

策略选择：不引入重量级 Markdown 引擎；制度/手册类文档的 heading 树才是切片主信号。
"""

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
from app.services.ingest.parsers.txt import decode_text_bytes
from app.services.ingest.table_ir import (
	normalize_table,
	table_ir_from_legacy,
	table_ir_to_legacy,
)

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
_FENCE_RE = re.compile(r"^```")
_TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$")
_LIST_RE = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+")


def _parse_table_block(lines: list[str], *, table_id: str) -> tuple[dict, str]:
	rows: list[list[str]] = []
	for line in lines:
		if _TABLE_SEP_RE.match(line):
			continue
		cells = [c.strip() for c in line.strip().strip("|").split("|")]
		if cells:
			rows.append(cells)
	headers = rows[0] if rows else []
	body = rows[1:] if len(rows) > 1 else []
	table_ir = normalize_table(
		table_id=table_id,
		headers=headers,
		rows=body,
		confidence=0.95,
	)
	table_json = table_ir_to_legacy(table_ir)
	# 文本化行：供 embedding / 无表工具时的可读回退
	textual_parts = [" | ".join(headers)] if headers else []
	for row in body:
		textual_parts.append(" | ".join(row))
	return table_json, "\n".join(textual_parts)


def parse_markdown(
	*,
	content: bytes,
	filename: str,
	title: str,
	doc_id: str | None = None,
	library_id: str = "",
) -> DocumentIR:
	text = decode_text_bytes(content)
	lines = text.split("\n")
	nodes: list[Node] = []
	heading_stack: list[tuple[int, str]] = []  # (level, title)
	i = 0
	para_buf: list[str] = []
	list_buf: list[str] = []
	table_id_seq = 0

	def flush_para() -> None:
		nonlocal para_buf
		body = "\n".join(para_buf).strip()
		para_buf = []
		if not body:
			return
		path = _section_path(heading_stack)
		nodes.append(
			Node(
				id=str(uuid4()),
				type=NodeType.PARAGRAPH,
				path=path,
				text=body,
				confidence=0.9,
			)
		)

	def flush_list() -> None:
		nonlocal list_buf
		body = "\n".join(list_buf).strip()
		list_buf = []
		if not body:
			return
		nodes.append(
			Node(
				id=str(uuid4()),
				type=NodeType.LIST,
				path=_section_path(heading_stack),
				text=body,
				confidence=0.85,
			)
		)

	while i < len(lines):
		line = lines[i]

		# fenced code
		if _FENCE_RE.match(line.strip()):
			flush_para()
			flush_list()
			fence = line.strip()
			lang = fence[3:].strip()
			i += 1
			code_lines: list[str] = []
			while i < len(lines) and not _FENCE_RE.match(lines[i].strip()):
				code_lines.append(lines[i])
				i += 1
			if i < len(lines):
				i += 1
			nodes.append(
				Node(
					id=str(uuid4()),
					type=NodeType.CODE,
					path=_section_path(heading_stack),
					text="\n".join(code_lines),
					confidence=0.95,
					meta={"language": lang},
				)
			)
			continue

		# table: header + separator
		if (
			"|" in line
			and i + 1 < len(lines)
			and _TABLE_SEP_RE.match(lines[i + 1])
		):
			flush_para()
			flush_list()
			table_lines = [line, lines[i + 1]]
			i += 2
			while i < len(lines) and "|" in lines[i] and lines[i].strip():
				table_lines.append(lines[i])
				i += 1
			table_id_seq += 1
			table_id = f"t{table_id_seq}"
			table_json, textual = _parse_table_block(table_lines, table_id=table_id)
			nodes.append(
				Node(
					id=str(uuid4()),
					type=NodeType.TABLE,
					path=_section_path(heading_stack),
					text=textual,
					table_json=table_json,
					table_ir=table_ir_from_legacy(
						table_json,
						table_id=table_id,
						confidence=0.95,
					),
					table_id=table_id,
					confidence=0.9,
				)
			)
			continue

		heading_match = _HEADING_RE.match(line)
		if heading_match:
			flush_para()
			flush_list()
			level = len(heading_match.group(1))
			heading_text = heading_match.group(2).strip()
			while heading_stack and heading_stack[-1][0] >= level:
				heading_stack.pop()
			heading_stack.append((level, heading_text))
			path = " / ".join(h[1] for h in heading_stack)
			nodes.append(
				Node(
					id=str(uuid4()),
					type=NodeType.HEADING,
					path=path,
					level=level,
					text=heading_text,
					confidence=0.95,
				)
			)
			i += 1
			continue

		if _LIST_RE.match(line):
			flush_para()
			list_buf.append(line.rstrip())
			i += 1
			continue

		if list_buf and line.strip() == "":
			flush_list()
			i += 1
			continue

		if list_buf and not _LIST_RE.match(line) and line.strip():
			# continuation of list item
			list_buf.append(line.rstrip())
			i += 1
			continue

		if line.strip() == "":
			flush_para()
			flush_list()
			i += 1
			continue

		para_buf.append(line.rstrip())
		i += 1

	flush_para()
	flush_list()

	if not nodes:
		raise ValueError("Markdown produced no content nodes")

	# 文档级 title：优先 H1
	doc_title = title
	for node in nodes:
		if node.type == NodeType.HEADING and node.level == 1 and node.text:
			doc_title = node.text
			break

	return DocumentIR(
		id=doc_id or str(uuid4()),
		library_id=library_id,
		source=filename,
		source_format="md",
		title=doc_title,
		filename=filename,
		content_hash=content_hash_bytes(content),
		nodes=nodes,
		parser_report=ParserReport(
			source_format="md",
			parser="markdown_ast_lite",
			notes="heading/list/code/table structure preserved",
		),
	)


def _section_path(stack: list[tuple[int, str]]) -> str | None:
	if not stack:
		return None
	return " / ".join(item[1] for item in stack)
