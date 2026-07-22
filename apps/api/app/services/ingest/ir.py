"""Document IR — 所有格式汇入的统一中间表示（L2 输出 / L3 输入）。

WHY: Ask/索引不直接啃原文件；citation 与切片都绑定在 Node/Chunk 上，
才能做到「看见的 ≈ 模型用的」与可追溯的 section/page。
"""

from __future__ import annotations

import hashlib
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class NodeType(StrEnum):
	HEADING = "heading"
	PARAGRAPH = "paragraph"
	LIST = "list"
	TABLE = "table"
	CODE = "code"
	FIGURE = "figure"
	FOOTNOTE = "footnote"
	SLIDE = "slide"
	# PDF 页级占位：扫描/复杂页在结构还原前先挂在页节点上
	PAGE = "page"


class SplitStrategy(StrEnum):
	"""切片策略标签 — char_window 仅作无结构 fallback，不得当唯一默认。"""

	HEADING = "heading"
	TABLE = "table"
	CODE = "code"
	PAGE = "page"
	RECURSIVE = "recursive"
	CHAR_WINDOW = "char_window"


class ParserReport(BaseModel):
	"""页/文件级解析诚实账本：禁止静默空 ready。"""

	source_format: str = ""
	parser: str = ""
	text_pages: list[int] = Field(default_factory=list)
	ocr_pages: list[int] = Field(default_factory=list)
	vlm_pages: list[int] = Field(default_factory=list)
	failed_pages: list[int] = Field(default_factory=list)
	needs_ocr_pages: list[int] = Field(default_factory=list)
	vlm_pending_pages: list[int] = Field(default_factory=list)
	warnings: list[str] = Field(default_factory=list)
	partial: bool = False
	notes: str = ""

	def to_public_dict(self) -> dict[str, Any]:
		return self.model_dump()


class Node(BaseModel):
	id: str
	type: NodeType
	path: str | None = None
	level: int | None = None
	page_start: int | None = None
	page_end: int | None = None
	text: str = ""
	table_json: dict[str, Any] | list[Any] | None = None
	figure_desc: str | None = None
	confidence: float | None = None
	# 关联：表格/图片 id，供 extract_table / quote 使用
	table_id: str | None = None
	figure_id: str | None = None
	meta: dict[str, Any] = Field(default_factory=dict)


class Chunk(BaseModel):
	chunk_index: int
	# 送入 embedding 的全文（通常 preamble + body）
	text: str
	# 引用 / UI / LLM 主展示：不含 preamble
	body: str
	preamble: str = ""
	section_path: str | None = None
	heading_text: str | None = None
	page_start: int | None = None
	page_end: int | None = None
	page_label: str | None = None
	node_ids: list[str] = Field(default_factory=list)
	table_id: str | None = None
	figure_id: str | None = None
	split_strategy: SplitStrategy = SplitStrategy.HEADING
	source_format: str = ""
	content_hash: str = ""
	meta: dict[str, Any] = Field(default_factory=dict)

	def embed_text(self) -> str:
		"""索引向量用 preamble+body；BM25/展示仍优先 body。"""
		preamble = (self.preamble or "").strip()
		body = (self.body or "").strip()
		if preamble and body:
			return f"{preamble}\n\n{body}"
		return body or preamble or self.text

	def display_text(self) -> str:
		return (self.body or self.text or "").strip()


class DocumentIR(BaseModel):
	id: str
	library_id: str = ""
	source: str = ""
	source_format: str = ""
	title: str = ""
	filename: str = ""
	content_hash: str = ""
	version: int = 1
	nodes: list[Node] = Field(default_factory=list)
	parser_report: ParserReport = Field(default_factory=ParserReport)
	meta: dict[str, Any] = Field(default_factory=dict)

	def content_fingerprint(self) -> str:
		if self.content_hash:
			return self.content_hash
		joined = "\n".join(f"{n.type}:{n.text}" for n in self.nodes)
		return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:32]


def content_hash_bytes(content: bytes) -> str:
	return hashlib.sha256(content).hexdigest()[:32]


def format_page_label(page_start: int | None, page_end: int | None = None) -> str | None:
	"""页码范围标签 — 替代「取 chunk 内最后一个 ## Page N」的旧逻辑。"""
	if page_start is None:
		return None
	if page_end is None or page_end == page_start:
		return f"p.{page_start}"
	return f"p.{page_start}-{page_end}"


def build_preamble(
	*,
	title: str,
	section_path: str | None = None,
	heading_text: str | None = None,
	page_start: int | None = None,
	page_end: int | None = None,
) -> str:
	"""Anthropic/FCC 思路：每块补 1～3 句定位，提升检索召回且不污染 UI body。"""
	parts: list[str] = []
	doc_title = (title or "").strip() or "未命名文档"
	parts.append(f"文档《{doc_title}》")
	if section_path:
		parts.append(section_path)
	elif heading_text:
		parts.append(heading_text)
	if page_start is not None:
		if page_end is None or page_end == page_start:
			parts.append(f"第{page_start}页")
		else:
			parts.append(f"第{page_start}-{page_end}页")
	return " · ".join(parts)
