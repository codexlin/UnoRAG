"""多粒度 IndexRecord — Phase 2A：chunk / section（同 collection，靠 record_type 过滤）。"""

from __future__ import annotations

import hashlib
import re
from collections import OrderedDict
from typing import Any, Literal
from uuid import uuid5, UUID

from pydantic import BaseModel, Field

from app.services.ingest.ir import Chunk

RecordType = Literal["chunk", "section", "document", "table"]

# 稳定命名空间，用于 Qdrant point id
_POINT_NS = UUID("a6c3e8f0-2b1d-4e9a-9c7f-1d2e3f4a5b6c")

# section 正文过长时按字符软切（不引入 LLM summary）
DEFAULT_SECTION_MAX_CHARS = 2400


class IndexRecord(BaseModel):
	record_type: RecordType
	record_id: str
	parent_record_id: str | None = None
	document_version_id: str | None = None
	library_id: str = ""
	doc_id: str = ""
	tenant_id: str = "default"
	workspace_id: str = "default"
	section_path: str | None = None
	heading_text: str | None = None
	body: str = ""
	embed_text: str = ""
	source_chunk_ids: list[str] = Field(default_factory=list)
	chunk_index: int | None = None  # chunk 粒度沿用；section 可用 part 序号
	page_start: int | None = None
	page_end: int | None = None
	page_label: str | None = None
	table_id: str | None = None
	content_hash: str = ""
	source_format: str = ""
	filename: str | None = None

	def point_uuid(self) -> str:
		"""确定性 Qdrant point id（reindex 幂等）。"""
		return str(uuid5(_POINT_NS, self.record_id))


def chunk_record_id(doc_id: str, chunk_index: int) -> str:
	return f"chk:{doc_id}:{int(chunk_index)}"


def section_record_id(doc_id: str, section_path: str, *, part: int = 0) -> str:
	digest = hashlib.sha1(
		f"{doc_id}|{section_path}|{part}".encode("utf-8")
	).hexdigest()[:16]
	return f"sec:{digest}"


def _split_long_text(text: str, max_chars: int) -> list[str]:
	raw = (text or "").strip()
	if not raw:
		return []
	if len(raw) <= max_chars:
		return [raw]
	parts: list[str] = []
	start = 0
	while start < len(raw):
		end = min(len(raw), start + max_chars)
		if end < len(raw):
			# 尽量在段落边界切开
			window = raw[start:end]
			cut = max(window.rfind("\n\n"), window.rfind("\n"), window.rfind("。"))
			if cut >= max_chars // 3:
				end = start + cut + 1
		parts.append(raw[start:end].strip())
		start = end
	return [p for p in parts if p]


def build_section_records_from_chunks(
	chunks: list[Chunk],
	*,
	doc_id: str,
	library_id: str = "",
	document_version_id: str | None = None,
	tenant_id: str = "default",
	workspace_id: str = "default",
	filename: str | None = None,
	max_chars: int = DEFAULT_SECTION_MAX_CHARS,
) -> list[IndexRecord]:
	"""按 section_path 聚合相邻 chunks → section IndexRecord（可分段）。"""
	groups: OrderedDict[str, list[Chunk]] = OrderedDict()
	for chunk in chunks:
		key = (chunk.section_path or "").strip() or "__root__"
		groups.setdefault(key, []).append(chunk)

	records: list[IndexRecord] = []
	for path, group in groups.items():
		bodies: list[str] = []
		source_ids: list[str] = []
		page_starts: list[int] = []
		page_ends: list[int] = []
		heading = None
		source_format = ""
		for chunk in group:
			body = chunk.display_text()
			if body:
				bodies.append(body)
			source_ids.append(chunk_record_id(doc_id, chunk.chunk_index))
			if chunk.page_start is not None:
				page_starts.append(int(chunk.page_start))
			if chunk.page_end is not None:
				page_ends.append(int(chunk.page_end))
			if not heading and chunk.heading_text:
				heading = chunk.heading_text
			if not source_format and chunk.source_format:
				source_format = chunk.source_format

		joined = "\n\n".join(bodies).strip()
		if not joined:
			continue
		display_path = None if path == "__root__" else path
		if not heading and display_path:
			heading = display_path.split("/")[-1]
		parts = _split_long_text(joined, max_chars)
		for part_idx, part_body in enumerate(parts):
			# embed_text：标题/路径 + 正文聚合（无 LLM summary）
			prefix_bits = [b for b in [display_path, heading] if b]
			prefix = " / ".join(dict.fromkeys(prefix_bits))  # 去重保序
			embed = f"{prefix}\n\n{part_body}" if prefix else part_body
			rid = section_record_id(doc_id, path, part=part_idx)
			records.append(
				IndexRecord(
					record_type="section",
					record_id=rid,
					parent_record_id=None,
					document_version_id=document_version_id,
					library_id=library_id,
					doc_id=doc_id,
					tenant_id=tenant_id,
					workspace_id=workspace_id,
					section_path=display_path,
					heading_text=heading,
					body=part_body,
					embed_text=embed,
					source_chunk_ids=list(source_ids),
					chunk_index=part_idx,
					page_start=min(page_starts) if page_starts else None,
					page_end=max(page_ends) if page_ends else None,
					page_label=str(min(page_starts)) if page_starts else None,
					content_hash=hashlib.sha1(part_body.encode("utf-8")).hexdigest()[:16],
					source_format=source_format,
					filename=filename,
				)
			)
	return records


def index_record_to_payload(record: IndexRecord) -> dict[str, Any]:
	"""转为 Qdrant upsert 用的 chunk-shaped dict。"""
	payload: dict[str, Any] = {
		"chunk_index": int(record.chunk_index or 0),
		"text": record.body,
		"body": record.body,
		"embed_text": record.embed_text or record.body,
		"record_type": record.record_type,
		"record_id": record.record_id,
		"source_chunk_ids": list(record.source_chunk_ids),
	}
	if record.parent_record_id:
		payload["parent_record_id"] = record.parent_record_id
	if record.document_version_id:
		payload["document_version_id"] = record.document_version_id
	if record.tenant_id:
		payload["tenant_id"] = record.tenant_id
	if record.workspace_id:
		payload["workspace_id"] = record.workspace_id
	if record.section_path:
		payload["section_path"] = record.section_path
	if record.heading_text:
		payload["heading_text"] = record.heading_text
	if record.page_label:
		payload["page"] = record.page_label
	if record.page_start is not None:
		payload["page_start"] = record.page_start
	if record.page_end is not None:
		payload["page_end"] = record.page_end
	if record.table_id:
		payload["table_id"] = record.table_id
	if record.content_hash:
		payload["content_hash"] = record.content_hash
	if record.source_format:
		payload["source_format"] = record.source_format
	if record.filename:
		payload["filename"] = record.filename
	payload["_point_id"] = record.point_uuid()
	return payload


_SECTION_CHAPTER = re.compile(
	r"(第\s*[0-9一二三四五六七八九十百千]+\s*[章节条款篇部]|本章|本节|该节|这一节|这一章|此节|此章)"
)
_SECTION_ABOUT = re.compile(r"(讲了什么|讲什么|有哪些规定|包含哪些|这一节|本节内容|章节内容)")


def looks_like_section_lookup(question: str) -> bool:
	q = (question or "").strip()
	if not q:
		return False
	if _SECTION_CHAPTER.search(q):
		return True
	if "节" in q and _SECTION_ABOUT.search(q):
		return True
	return False
