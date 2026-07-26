"""Ingest pipeline facade — parse → structure-aware chunk → payload dicts.

documents.py / ask router 保持薄封装；业务策略集中在此。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any
from uuid import uuid4

from app.services.documents import clean_display_title
from app.services.ingest.chunk_policy import SemanticEmbedder
from app.services.ingest.chunker import ChunkerConfig, chunk_document
from app.services.ingest.ir import (
	CancelCheck,
	Chunk,
	DocumentIR,
	ParserReport,
	ParseProgressCallback,
)
from app.services.ingest.router import parse_to_ir, use_v2_pipeline
from app.settings import Settings


@dataclass
class PreparedIngest:
	doc_id: str
	title: str
	filename: str
	content_type: str
	source_format: str
	chunks: list[Chunk]
	parser_report: ParserReport
	ir: DocumentIR | None = None
	# legacy 路径扁平正文（模拟入库 / 旧 chunk）
	legacy_text: str | None = None
	pipeline: str = "v2"

	def notice(self) -> str | None:
		report = self.parser_report
		if report.partial:
			return (
				"部分页未解析"
				+ (f"（失败页 {report.failed_pages}）" if report.failed_pages else "")
				+ (f"；需 OCR：{report.needs_ocr_pages}" if report.needs_ocr_pages else "")
				+ (
					f"；VLM 待处理：{report.vlm_pending_pages}"
					if report.vlm_pending_pages
					else ""
				)
			)
		if report.warnings:
			return report.warnings[0]
		return None


def prepare_ingest(
	*,
	settings: Settings,
	filename: str,
	content: bytes,
	library_id: str,
	display_name: str | None = None,
	doc_id: str | None = None,
	content_type: str | None = None,
	semantic_embedder: SemanticEmbedder | None = None,
	parser_progress_callback: ParseProgressCallback | None = None,
	cancel_check: CancelCheck | None = None,
) -> PreparedIngest:
	name = (filename or "untitled.txt").strip() or "untitled.txt"
	suffix = PurePosixPath(name).suffix.lower()
	resolved_doc_id = doc_id or str(uuid4())
	title_hint = clean_display_title(
		(display_name or "").strip() or PurePosixPath(name).stem,
		filename=name,
	)

	if not use_v2_pipeline(settings, name):
		from app.services.documents import extract_text
		from app.services.chunking import chunk_text

		# legacy：pdf 在 A 期也可走此路径；B 后默认 v2
		parsed = extract_text(filename=name, content=content, content_type=content_type)
		title = clean_display_title(
			(display_name or "").strip() or parsed.title,
			filename=parsed.filename,
		)
		pieces = chunk_text(
			parsed.text,
			chunk_size=settings.chunk_size,
			chunk_overlap=settings.chunk_overlap,
		)
		if not pieces:
			raise ValueError("text is empty after cleaning")
		# 包装为最小 Chunk，payload 兼容旧字段
		from app.services.documents import infer_page_label
		from app.services.ingest.ir import Chunk as IRChunk, SplitStrategy

		chunks: list[Chunk] = []
		for piece in pieces:
			page = infer_page_label(piece.text)
			chunks.append(
				IRChunk(
					chunk_index=piece.index,
					text=piece.text,
					body=piece.text,
					preamble="",
					page_label=page,
					split_strategy=SplitStrategy.CHAR_WINDOW,
					source_format=suffix.lstrip(".") or "txt",
				)
			)
		return PreparedIngest(
			doc_id=resolved_doc_id,
			title=title,
			filename=parsed.filename,
			content_type=parsed.content_type,
			source_format=suffix.lstrip(".") or "txt",
			chunks=chunks,
			parser_report=ParserReport(
				source_format=suffix.lstrip(".") or "txt",
				parser="legacy",
				notes="INGEST_PIPELINE=legacy",
			),
			legacy_text=parsed.text,
			pipeline="legacy",
		)

	ir = parse_to_ir(
		filename=name,
		content=content,
		title=title_hint,
		settings=settings,
		doc_id=resolved_doc_id,
		library_id=library_id,
		content_type=content_type,
		progress_callback=parser_progress_callback,
		cancel_check=cancel_check,
	)
	if display_name and display_name.strip():
		ir.title = clean_display_title(display_name, filename=name)

	resolved_semantic_embedder = semantic_embedder
	if (
		settings.semantic_chunking_enabled
		and resolved_semantic_embedder is None
		and settings.has_llm_key
	):
		from app.services.llm import EmbeddingService

		resolved_semantic_embedder = EmbeddingService(settings).embed_texts

	chunks = chunk_document(
		ir,
		config=ChunkerConfig(
			chunk_size=settings.chunk_size,
			chunk_overlap=settings.chunk_overlap,
			profile_name=settings.chunking_profile,
			policy_version=settings.chunk_policy_version,
			semantic_enabled=settings.semantic_chunking_enabled,
			semantic_min_chars=settings.semantic_chunk_min_chars,
			semantic_break_percentile=settings.semantic_chunk_break_percentile,
		),
		semantic_embedder=resolved_semantic_embedder,
	)
	if not chunks:
		raise ValueError("document produced no chunks after structure-aware split")

	ctype = content_type or _guess_content_type(suffix)
	return PreparedIngest(
		doc_id=ir.id,
		title=ir.title or title_hint,
		filename=ir.filename or name,
		content_type=ctype,
		source_format=ir.source_format,
		chunks=chunks,
		parser_report=ir.parser_report,
		ir=ir,
		pipeline="v2",
	)


def chunks_to_payloads(
	chunks: list[Chunk],
	*,
	filename: str | None = None,
	doc_id: str | None = None,
	library_id: str | None = None,
	document_version_id: str | None = None,
	generation_id: str | None = None,
	lifecycle_visibility: str | None = None,
	tenant_id: str = "default",
	workspace_id: str = "default",
	include_sections: bool = True,
	include_tables: bool = True,
) -> list[dict[str, Any]]:
	"""IR Chunk → Qdrant/ingest dict；可选附带 section / table 粒度 records。"""
	from app.services.ingest.index_record import (
		IndexRecord,
		build_section_records_from_chunks,
		build_table_records_from_chunks,
		build_table_summary_records_from_chunks,
		chunk_record_id,
		generation_point_uuid,
		index_record_to_payload,
	)
	from app.services.ingest.qdrant_payload import validate_index_write_payload

	resolved_doc = (doc_id or "").strip() or "unknown"
	version_id = (document_version_id or "").strip()
	if not version_id:
		raise ValueError(
			"document_version_id is required; pass app.document_versions.id "
			"from the control plane (derive_document_version_id was removed in L6)"
		)
	payloads: list[dict[str, Any]] = []
	for chunk in chunks:
		body = chunk.display_text()
		rid = chunk_record_id(resolved_doc, chunk.chunk_index)
		item: dict[str, Any] = {
			"chunk_index": chunk.chunk_index,
			# text：LLM/抽屉主展示 = body（看见的≈模型用的）
			"text": body,
			"body": body,
			"embed_text": chunk.embed_text(),
			"split_strategy": str(chunk.split_strategy),
			"source_format": chunk.source_format,
			"record_type": "chunk",
			"record_id": rid,
			"document_version_id": version_id,
			"tenant_id": tenant_id,
			"workspace_id": workspace_id,
			"_point_id": IndexRecord(
				record_type="chunk",
				record_id=rid,
				doc_id=resolved_doc,
			).point_uuid(),
		}
		if chunk.preamble:
			item["preamble"] = chunk.preamble
		if chunk.section_path:
			item["section_path"] = chunk.section_path
		if chunk.heading_text:
			item["heading_text"] = chunk.heading_text
		if chunk.page_label:
			item["page"] = chunk.page_label
		if chunk.page_start is not None:
			item["page_start"] = chunk.page_start
		if chunk.page_end is not None:
			item["page_end"] = chunk.page_end
		if chunk.table_id:
			item["table_id"] = chunk.table_id
		if chunk.figure_id:
			item["figure_id"] = chunk.figure_id
		if chunk.node_ids:
			item["node_ids"] = list(chunk.node_ids)
		if chunk.content_hash:
			item["content_hash"] = chunk.content_hash
		for key in (
			"chunk_policy_version",
			"chunk_profile",
			"split_reason",
			"target_chars",
			"max_chars",
			"table_rows_per_record",
			"table_tokens_per_record",
			"semantic_distance_threshold",
			"semantic_unit_count",
			"semantic_fallback",
		):
			if chunk.meta.get(key) is not None:
				item[key] = chunk.meta[key]
		if filename:
			item["filename"] = filename
		payloads.append(validate_index_write_payload(item))

	if include_sections and chunks:
		sections = build_section_records_from_chunks(
			chunks,
			doc_id=resolved_doc,
			library_id=library_id or "",
			document_version_id=version_id,
			tenant_id=tenant_id,
			workspace_id=workspace_id,
			filename=filename,
		)
		for record in sections:
			payloads.append(index_record_to_payload(record))
	if include_tables and chunks:
		table_rows_per_record = next(
			(
				int(chunk.meta["table_rows_per_record"])
				for chunk in chunks
				if chunk.meta.get("table_rows_per_record") is not None
			),
			40,
		)
		table_tokens_per_record = next(
			(
				int(chunk.meta["table_tokens_per_record"])
				for chunk in chunks
				if chunk.meta.get("table_tokens_per_record") is not None
			),
			1400,
		)
		tables = build_table_records_from_chunks(
			chunks,
			doc_id=resolved_doc,
			library_id=library_id or "",
			document_version_id=version_id,
			tenant_id=tenant_id,
			workspace_id=workspace_id,
			filename=filename,
			max_rows=table_rows_per_record,
			max_tokens=table_tokens_per_record,
		)
		for record in tables:
			payloads.append(index_record_to_payload(record))
		table_summaries = build_table_summary_records_from_chunks(
			chunks,
			doc_id=resolved_doc,
			library_id=library_id or "",
			document_version_id=version_id,
			tenant_id=tenant_id,
			workspace_id=workspace_id,
			filename=filename,
		)
		for record in table_summaries:
			payloads.append(index_record_to_payload(record))
	if generation_id:
		for index, payload in enumerate(payloads):
			record_id = str(payload.get("record_id") or "").strip()
			if not record_id:
				raise ValueError("generation payload requires record_id")
			enriched = dict(payload)
			enriched["generation_id"] = generation_id
			enriched["lifecycle_visibility"] = lifecycle_visibility or "staging"
			enriched["_point_id"] = generation_point_uuid(generation_id, record_id)
			payloads[index] = validate_index_write_payload(enriched)
	return payloads

def _guess_content_type(suffix: str) -> str:
	return {
		".txt": "text/plain",
		".md": "text/markdown",
		".markdown": "text/markdown",
		".pdf": "application/pdf",
		".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".csv": "text/csv",
		".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	}.get(suffix, "application/octet-stream")
