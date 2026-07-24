"""多粒度 IndexRecord — Phase 2A/2B：chunk / section / table（同 collection，靠 record_type 过滤）。"""

from __future__ import annotations

import hashlib
import re
from typing import Any, Literal
from uuid import uuid5, UUID

from pydantic import BaseModel, Field

from app.services.ingest.ir import Chunk

RecordType = Literal["chunk", "section", "document", "table", "table_summary"]

# 稳定命名空间，用于 Qdrant point id
_POINT_NS = UUID("a6c3e8f0-2b1d-4e9a-9c7f-1d2e3f4a5b6c")

# section 正文过长时按字符软切（不引入 LLM summary）
DEFAULT_SECTION_MAX_CHARS = 2400
# 大表按连续行组拆分；每组复制 headers
DEFAULT_TABLE_MAX_ROWS = 40
DEFAULT_TABLE_MAX_TOKENS = 1400


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
	# 整表行数（每个 row group 复制），用于全表加载完整性校验
	table_row_count: int | None = None
	table_caption: str | None = None
	table_quality: dict[str, Any] = Field(default_factory=dict)
	summary_rows: list[dict[str, Any]] = Field(default_factory=list)
	footnotes: list[str] = Field(default_factory=list)
	header_rows: list[list[str]] = Field(default_factory=list)
	table_columns: list[dict[str, Any]] = Field(default_factory=list)
	cell_rows: list[dict[str, Any]] = Field(default_factory=list)
	content_hash: str = ""
	source_format: str = ""
	filename: str | None = None

	def point_uuid(self) -> str:
		"""确定性 Qdrant point id（reindex 幂等）。"""
		return str(uuid5(_POINT_NS, self.record_id))


def generation_point_uuid(generation_id: str, record_id: str) -> str:
	"""A generation owns a stable, disjoint Qdrant point namespace."""
	resolved_generation = (generation_id or "").strip()
	if not resolved_generation:
		raise ValueError("generation_id is required")
	return str(uuid5(_POINT_NS, f"{resolved_generation}:{record_id}"))


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


def table_summary_record_id(doc_id: str, table_id: str) -> str:
	digest = hashlib.sha1(f"{doc_id}|{table_id}|summary".encode("utf-8")).hexdigest()[:16]
	return f"tblsum:{digest}"


def _table_group_to_text(headers: list[str], rows: list[list[str]]) -> str:
	lines = [" | ".join(str(h) for h in headers)] if headers else []
	for row in rows:
		lines.append(" | ".join(str(c) for c in row))
	return "\n".join(lines).strip()


def _estimate_tokens(text: str) -> int:
	"""Dependency-free conservative token estimate for mixed Chinese/Latin text."""
	cjk = sum(
		1
		for char in text
		if "\u3400" <= char <= "\u9fff"
		or "\u3040" <= char <= "\u30ff"
		or "\uac00" <= char <= "\ud7af"
	)
	return cjk + max(1, (len(text) - cjk + 3) // 4)


def _slice_table_rows(
	headers: list[str],
	rows: list[list[str]],
	*,
	max_rows: int,
	max_tokens: int,
) -> list[tuple[int, int, list[list[str]]]]:
	if not rows:
		return [(0, -1, [])]
	header_tokens = _estimate_tokens(" | ".join(headers))
	result: list[tuple[int, int, list[list[str]]]] = []
	start = 0
	current: list[list[str]] = []
	current_tokens = header_tokens
	for index, row in enumerate(rows):
		row_tokens = _estimate_tokens(" | ".join(row))
		over_budget = current and (
			len(current) >= max_rows or current_tokens + row_tokens > max_tokens
		)
		if over_budget:
			result.append((start, index - 1, current))
			start = index
			current = []
			current_tokens = header_tokens
		current.append(row)
		current_tokens += row_tokens
	if current:
		result.append((start, start + len(current) - 1, current))
	return result


def build_table_summary_records_from_chunks(
	chunks: list[Chunk],
	*,
	doc_id: str,
	library_id: str = "",
	document_version_id: str | None = None,
	tenant_id: str = "default",
	workspace_id: str = "default",
	filename: str | None = None,
) -> list[IndexRecord]:
	"""One schema/summary vector per logical table for table discovery."""
	records: list[IndexRecord] = []
	for chunk in chunks:
		table_id = (chunk.table_id or "").strip()
		if not table_id:
			continue
		meta = chunk.meta or {}
		headers = [str(value) for value in (meta.get("headers") or [])]
		rows = list(meta.get("rows") or [])
		caption = str(meta.get("table_caption") or chunk.heading_text or "").strip()
		parts = [caption] if caption else [f"表格 {table_id}"]
		if headers:
			parts.append("字段：" + "、".join(headers))
		parts.append(f"共{len(rows)}条数据")
		footnotes = [str(value) for value in (meta.get("footnotes") or []) if str(value)]
		table_ir = meta.get("table_ir") if isinstance(meta.get("table_ir"), dict) else {}
		if footnotes:
			parts.append("备注：" + "；".join(footnotes[:3]))
		body = "；".join(parts)
		rid = table_summary_record_id(doc_id, table_id)
		records.append(
			IndexRecord(
				record_type="table_summary",
				record_id=rid,
				parent_record_id=chunk_record_id(doc_id, chunk.chunk_index),
				document_version_id=document_version_id,
				library_id=library_id,
				doc_id=doc_id,
				tenant_id=tenant_id,
				workspace_id=workspace_id,
				section_path=chunk.section_path,
				heading_text=chunk.heading_text,
				body=body,
				embed_text=body,
				source_chunk_ids=[chunk_record_id(doc_id, chunk.chunk_index)],
				source_node_ids=list(chunk.node_ids or []),
				page_start=chunk.page_start,
				page_end=chunk.page_end,
				page_label=chunk.page_label,
				table_id=table_id,
				headers=headers,
				table_row_count=len(rows),
				table_caption=caption or None,
				table_quality=dict(meta.get("table_quality") or {}),
				summary_rows=list(meta.get("summary_rows") or []),
				footnotes=footnotes,
				header_rows=[
					[str(cell) for cell in row]
					for row in (table_ir.get("header_rows") or [])
				],
				table_columns=[
					dict(column) for column in (table_ir.get("columns") or [])
					if isinstance(column, dict)
				],
				content_hash=hashlib.sha1(body.encode("utf-8")).hexdigest()[:16],
				source_format=chunk.source_format,
				filename=filename,
			)
		)
	return records

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
	max_tokens: int = DEFAULT_TABLE_MAX_TOKENS,
) -> list[IndexRecord]:
	"""从带 table_id + meta.headers/rows 的 chunk 生成 table IndexRecord。

	大表按连续行组分片，**headers 复制到每个 record**；确定性 ID 保证 reindex 幂等。
	"""
	records: list[IndexRecord] = []
	group_cap = max(1, int(max_rows))
	token_cap = max(128, int(max_tokens))
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
		table_row_count = len(rows)
		table_ir = meta.get("table_ir") if isinstance(meta.get("table_ir"), dict) else {}
		all_cell_rows = [
			dict(row) for row in (table_ir.get("rows") or []) if isinstance(row, dict)
		]
		# 空表也建一条（仅 headers），便于召回表结构
		row_slices = _slice_table_rows(
			headers,
			rows,
			max_rows=group_cap,
			max_tokens=token_cap,
		)

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
					table_row_count=table_row_count,
					table_caption=str(meta.get("table_caption") or "") or None,
					table_quality=dict(meta.get("table_quality") or {}),
					header_rows=[
						[str(cell) for cell in row]
						for row in (table_ir.get("header_rows") or [])
					],
					table_columns=[
						dict(column) for column in (table_ir.get("columns") or [])
						if isinstance(column, dict)
					],
					cell_rows=all_cell_rows[row_start : row_end + 1]
					if row_end >= row_start
					else [],
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
	if record.table_row_count is not None:
		payload["table_row_count"] = int(record.table_row_count)
	if record.table_caption:
		payload["table_caption"] = record.table_caption
	if record.table_quality:
		payload["table_quality"] = dict(record.table_quality)
	if record.summary_rows:
		payload["summary_rows"] = list(record.summary_rows)
	if record.footnotes:
		payload["footnotes"] = list(record.footnotes)
	if record.header_rows:
		payload["header_rows"] = [list(row) for row in record.header_rows]
	if record.table_columns:
		payload["table_columns"] = list(record.table_columns)
	if record.cell_rows:
		payload["cell_rows"] = list(record.cell_rows)
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
