"""TXT parser — 编码探测 + 空行分段；弱结构（confidence=low）。"""

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

_HEADING_HINT = re.compile(
	r"^(第[一二三四五六七八九十百千\d]+[章节条款部篇]|[一二三四五六七八九十]+[、.．]|[（(]?\d+[）).．])"
)


def decode_text_bytes(content: bytes) -> str:
	for encoding in ("utf-8", "utf-8-sig", "gb18030", "latin-1"):
		try:
			text = content.decode(encoding)
			break
		except UnicodeDecodeError:
			continue
	else:
		text = content.decode("utf-8", errors="replace")
	cleaned = text.replace("\r\n", "\n").replace("\r", "\n").strip()
	if not cleaned:
		raise ValueError("file is empty after decoding")
	return cleaned


def parse_txt(
	*,
	content: bytes,
	filename: str,
	title: str,
	doc_id: str | None = None,
	library_id: str = "",
) -> DocumentIR:
	text = decode_text_bytes(content)
	blocks = re.split(r"\n\s*\n+", text)
	nodes: list[Node] = []
	for block in blocks:
		piece = block.strip()
		if not piece:
			continue
		first_line = piece.split("\n", 1)[0].strip()
		# 短行 + 编号/章节启发 → 低置信 heading，便于结构切片
		is_heading = len(first_line) <= 40 and bool(_HEADING_HINT.match(first_line)) and "\n" not in piece
		nodes.append(
			Node(
				id=str(uuid4()),
				type=NodeType.HEADING if is_heading else NodeType.PARAGRAPH,
				path=None,
				level=2 if is_heading else None,
				text=piece,
				confidence=0.4 if is_heading else 0.7,
			)
		)
	if not nodes:
		raise ValueError("TXT produced no content nodes")

	return DocumentIR(
		id=doc_id or str(uuid4()),
		library_id=library_id,
		source=filename,
		source_format="txt",
		title=title,
		filename=filename,
		content_hash=content_hash_bytes(content),
		nodes=nodes,
		parser_report=ParserReport(
			source_format="txt",
			parser="txt_paragraph",
			notes="paragraph split; heading heuristics confidence=low",
		),
	)
