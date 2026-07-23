"""多粒度 IndexRecord — Phase 2A/2B：chunk / section / table（同 collection，靠 record_type 过滤）。"""

from __future__ import annotations

import hashlib
import re
from typing import Any, Literal
from uuid import uuid5, UUID

from pydantic import BaseModel, Field

from app.services.ingest.ir import Chunk

RecordType = Literal["chunk", "section", "document", "table"]

# 稳定命名空间，用于 Qdrant point id
_POINT_NS = UUID("a6c3e8f0-2b1d-4e9a-9c7f-1d2e3f4a5b6c")

# section 正文过长时按字符软切（不引入 LLM summary）
DEFAULT_SECTION_MAX_CHARS = 2400
# 大表按连续行组拆分；每组复制 headers
DEFAULT_TABLE_MAX_ROWS = 40


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
	source_node_ids: list[str] = Field(default_factory=list)
	chunk_index: int | None = None  # chunk 粒度沿用；section 可用 part 序号
	page_start: int | None = None
	page_end: int | None = None
	page_label: str | None = None
	table_id: str | None = None
	headers: list[str] = Field(default_factory=list)
	rows: list[list[str]] = Field(default_factory=list)
	row_start: int | None = None
	row_end: int | None = None
	content_hash: str = ""
	source_format: str = ""
	filename: str | None = None

	def point_uuid(self) -> str:
		"""确定性 Qdrant point id（reindex 幂等）。"""
		return str(uuid5(_POINT_NS, self.record_id))


def chunk_record_id(doc_id: str, chunk_index: int) -> str:
	return f"chk:{doc_id}:{int(chunk_index)}"


def section_record_id(
	doc_id: str,
	section_path: str,
	*,
	occurrence: int = 0,
	part: int = 0,
) -> str:
	digest = hashlib.sha1(
		f"{doc_id}|{section_path}|{occurrence}|{part}".encode("utf-8")
	).hexdigest()[:16]
	return f"sec:{digest}"


def table_record_id(
	doc_id: str,
	table_id: str,
	row_start: int,
	row_end: int,
) -> str:
	"""确定性 table point id：doc_id + table_id + row_range。"""
	digest = hashlib.sha1(
		f"{doc_id}|{table_id}|{int(row_start)}|{int(row_end)}".encode("utf-8")
	).hexdigest()[:16]
	return f"tbl:{digest}"


def _table_group_to_text(headers: list[str], rows: list[list[str]]) -> str:
	lines = [" | ".join(str(h) for h in headers)] if headers else []
	for row in rows:
		lines.append(" | ".join(str(c) for c in row))
	return "\n".join(lines).strip()

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
	"""按连续同 section_path 的 chunk 跑聚合 → section IndexRecord（按 chunk 组装 part）。

	仅合并相邻同 path 的 chunks；同名但非相邻（如 A→B→A）生成独立 section，
	并用 occurrence 区分确定性 ID。无 path / ``__root__`` 同样按连续跑拆分。
	"""
	# 连续跑分组（相邻同 path 才合并）
	runs: list[tuple[str, list[Chunk]]] = []
	for chunk in chunks:
		key = (chunk.section_path or "").strip() or "__root__"
		if runs and runs[-1][0] == key:
			runs[-1][1].append(chunk)
		else:
			runs.append((key, [chunk]))

	occurrence_counts: dict[str, int] = {}
	records: list[IndexRecord] = []
	for path, group in runs:
		occurrence = occurrence_counts.get(path, 0)
		occurrence_counts[path] = occurrence + 1
		display_path = None if path == "__root__" else path
		heading = next((c.heading_text for c in group if c.heading_text), None)
		if not heading and display_path:
			heading = display_path.split("/")[-1]
		source_format = next((c.source_format for c in group if c.source_format), "")

		# 以 chunk 为单位装入 part，避免字符切分后 source_chunk_ids 错绑
		part_chunks: list[list[Chunk]] = []
		current: list[Chunk] = []
		current_len = 0

		def _flush() -> None:
			nonlocal current, current_len
			if current:
				part_chunks.append(current)
			current = []
			current_len = 0

		for chunk in group:
			body = chunk.display_text()
			if not body:
				continue
			# 单 chunk 超长：单独切字，来源仍只指向该 chunk
			if len(body) > max_chars:
				_flush()
				for piece in _split_long_text(body, max_chars):
					# 用临时 chunk 副本承载切段正文
					part_chunks.append(
						[
							chunk.model_copy(
								update={
									"body": piece,
									"text": piece,
								}
							)
						]
					)
				continue
			sep = 2 if current else 0  # "\n\n"
			if current and current_len + sep + len(body) > max_chars:
				_flush()
			current.append(chunk)
			current_len += sep + len(body)
		_flush()

		prefix_bits = [b for b in [display_path, heading] if b]
		prefix = " / ".join(dict.fromkeys(prefix_bits))
		for part_idx, members in enumerate(part_chunks):
			bodies = [m.display_text() for m in members if m.display_text()]
			part_body = "\n\n".join(bodies).strip()
			if not part_body:
				continue
			source_ids = [chunk_record_id(doc_id, m.chunk_index) for m in members]
			# 去重保序（同一 chunk 被切多段时仍指向同一 id）
			source_ids = list(dict.fromkeys(source_ids))
			page_starts = [int(m.page_start) for m in members if m.page_start is not None]
			page_ends = [int(m.page_end) for m in members if m.page_end is not None]
			embed = f"{prefix}\n\n{part_body}" if prefix else part_body
			rid = section_record_id(
				doc_id, path, occurrence=occurrence, part=part_idx
			)
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
					source_chunk_ids=source_ids,
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


def build_table_records_from_chunks(
	chunks: list[Chunk],
	*,
	doc_id: str,
	library_id: str = "",
	document_version_id: str | None = None,
	tenant_id: str = "default",
	workspace_id: str = "default",
	filename: str | None = None,
	max_rows: int = DEFAULT_TABLE_MAX_ROWS,
) -> list[IndexRecord]:
	"""从带 table_id + meta.headers/rows 的 chunk 生成 table IndexRecord。

	大表按连续行组分片，**headers 复制到每个 record**；确定性 ID 保证 reindex 幂等。
	"""
	records: list[IndexRecord] = []
	group_cap = max(1, int(max_rows))
	for chunk in chunks:
		table_id = (chunk.table_id or "").strip()
		if not table_id:
			continue
		meta = chunk.meta or {}
		headers = [str(h) for h in (meta.get("headers") or [])]
		raw_rows = meta.get("rows") or []
		rows = [[str(c) for c in row] for row in raw_rows]
		if not headers and not rows:
			# 兼容：无结构化 meta 时跳过（仍保留 chunk 粒度）
			continue
		source_chunk = chunk_record_id(doc_id, chunk.chunk_index)
		source_nodes = list(chunk.node_ids or [])
		# 空表也建一条（仅 headers），便于召回表结构
		if not rows:
			row_slices = [(0, -1, [])]
		else:
			row_slices = []
			for start in range(0, len(rows), group_cap):
				end = min(len(rows), start + group_cap) - 1
				row_slices.append((start, end, rows[start : end + 1]))

		for part_idx, (row_start, row_end, part_rows) in enumerate(row_slices):
			body = _table_group_to_text(headers, part_rows)
			if not body:
				continue
			prefix_bits = [b for b in [chunk.section_path, chunk.heading_text, f"表格 {table_id}"] if b]
			prefix = " / ".join(dict.fromkeys(prefix_bits))
			embed = f"{prefix}\n\n{body}" if prefix else body
			rid = table_record_id(doc_id, table_id, row_start, row_end)
			records.append(
				IndexRecord(
					record_type="table",
					record_id=rid,
					parent_record_id=source_chunk,
					document_version_id=document_version_id,
					library_id=library_id,
					doc_id=doc_id,
					tenant_id=tenant_id,
					workspace_id=workspace_id,
					section_path=chunk.section_path,
					heading_text=chunk.heading_text,
					body=body,
					embed_text=embed,
					source_chunk_ids=[source_chunk],
					source_node_ids=source_nodes,
					chunk_index=part_idx,
					page_start=chunk.page_start,
					page_end=chunk.page_end,
					page_label=chunk.page_label or (
						str(chunk.page_start) if chunk.page_start is not None else None
					),
					table_id=table_id,
					headers=headers,
					rows=part_rows,
					row_start=row_start,
					row_end=row_end,
					content_hash=hashlib.sha1(body.encode("utf-8")).hexdigest()[:16],
					source_format=chunk.source_format,
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
	if record.source_node_ids:
		payload["source_node_ids"] = list(record.source_node_ids)
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
	if record.headers:
		payload["headers"] = list(record.headers)
	if record.rows:
		payload["rows"] = [list(r) for r in record.rows]
	if record.row_start is not None:
		payload["row_start"] = int(record.row_start)
	if record.row_end is not None:
		payload["row_end"] = int(record.row_end)
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
