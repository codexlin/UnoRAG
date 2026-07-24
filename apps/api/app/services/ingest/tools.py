"""L4 Agent tools — 服务函数；TOOL_ASK=false 时 ask 仍走短路径 retrieve→generate。

工具不替代简单事实问答；用于按章/按页/按表补读与规范引用。
"""

from __future__ import annotations

from typing import Any

from app.services.retrieval import RetrievalService
from app.settings import Settings


def search_docs(
	retrieval: RetrievalService,
	*,
	query: str,
	library_id: str,
	top_k: int | None = None,
) -> list[dict[str, Any]]:
	"""向量+关键词检索（复用现有 hybrid/rerank）。"""
	return retrieval.search(query=query, library_id=library_id, top_k=top_k)


def read_section(
	retrieval: RetrievalService,
	*,
	library_id: str,
	section_path: str,
	doc_id: str | None = None,
	limit: int = 20,
) -> list[dict[str, Any]]:
	"""按 section_path 拉回该节相关 chunk（payload 过滤 best-effort）。"""
	chunks = retrieval.list_chunks(
		library_id=library_id,
	)
	needle = section_path.strip()
	matched: list[dict[str, Any]] = []
	for chunk in chunks:
		# list_chunks 目前字段较少；有 section_path 时匹配，否则用 text 包含
		path = str(chunk.get("section_path") or "")
		text = str(chunk.get("text") or "")
		if doc_id and str(chunk.get("doc_id") or "") != doc_id:
			continue
		if path == needle or needle in path or (needle and needle in text[:200]):
			matched.append(chunk)
		if len(matched) >= limit:
			break
	return matched


def read_page(
	retrieval: RetrievalService,
	*,
	library_id: str,
	page: int,
	doc_id: str | None = None,
	limit: int = 20,
) -> list[dict[str, Any]]:
	"""PDF/PPT 按页读取：匹配 page_start/end 或 page 标签。"""
	chunks = retrieval.list_chunks(
		library_id=library_id,
	)
	matched: list[dict[str, Any]] = []
	label = f"p.{page}"
	for chunk in chunks:
		if doc_id and str(chunk.get("doc_id") or "") != doc_id:
			continue
		ps = chunk.get("page_start")
		pe = chunk.get("page_end")
		page_field = str(chunk.get("page") or "")
		in_range = False
		if ps is not None:
			end = int(pe) if pe is not None else int(ps)
			in_range = int(ps) <= page <= end
		elif page_field == label or page_field.startswith(f"p.{page}-") or page_field.endswith(f"-{page}"):
			in_range = True
		if in_range:
			matched.append(chunk)
		if len(matched) >= limit:
			break
	return matched


def extract_table(
	retrieval: RetrievalService,
	*,
	library_id: str,
	table_id: str | None = None,
	doc_id: str | None = None,
	limit: int = 10,
) -> list[dict[str, Any]]:
	"""返回带 table_id 的 chunk（结构化表优先走此工具）。"""
	chunks = retrieval.list_chunks(
		library_id=library_id,
	)
	matched: list[dict[str, Any]] = []
	for chunk in chunks:
		if doc_id and str(chunk.get("doc_id") or "") != doc_id:
			continue
		tid = chunk.get("table_id")
		if not tid:
			continue
		if table_id and tid != table_id:
			continue
		matched.append(chunk)
		if len(matched) >= limit:
			break
	return matched


def quote_source(citation: dict[str, Any]) -> dict[str, Any]:
	"""规范 citation 包：保证 body/section/page 字段齐全。"""
	body = str(citation.get("body") or citation.get("text") or citation.get("snippet") or "")
	return {
		"id": citation.get("id"),
		"index": citation.get("index"),
		"title": citation.get("title"),
		"doc_id": citation.get("doc_id"),
		"filename": citation.get("filename"),
		"document_version_id": citation.get("document_version_id"),
		"generation_id": citation.get("generation_id"),
		"page": citation.get("page"),
		"page_start": citation.get("page_start"),
		"page_end": citation.get("page_end"),
		"section_path": citation.get("section_path"),
		"table_id": citation.get("table_id"),
		"preamble": citation.get("preamble"),
		"body": body,
		"snippet": str(citation.get("snippet") or body[:280]),
		"text": body,
		"score": citation.get("score"),
	}


def tool_ask_enabled(settings: Settings) -> bool:
	return bool(getattr(settings, "tool_ask", False))
