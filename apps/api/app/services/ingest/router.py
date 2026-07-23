"""L1 parse router — 扩展名 +（PDF）页信号 → 具体 parser。"""

from __future__ import annotations

from pathlib import PurePosixPath
from typing import Any

from app.services.ingest.adapters.ocr import get_ocr_adapter
from app.services.ingest.adapters.vlm import get_vlm_adapter
from app.services.ingest.ir import DocumentIR
from app.services.ingest.parsers.docx import parse_docx
from app.services.ingest.parsers.md import parse_markdown
from app.services.ingest.parsers.pdf import PdfParseOptions
from app.services.ingest.parsers.pdf_route import parse_pdf_routed
from app.services.ingest.parsers.txt import parse_txt
from app.settings import Settings

# v2 管线已接通的格式（随阶段扩展）
V2_EXTENSIONS = {".txt", ".md", ".markdown", ".pdf", ".docx"}
SUPPORTED_EXTENSIONS = V2_EXTENSIONS | {".txt", ".md", ".markdown", ".pdf"}


def detect_format(filename: str) -> str:
	suffix = PurePosixPath(filename or "").suffix.lower()
	if suffix in {".md", ".markdown"}:
		return "md"
	if suffix == ".txt":
		return "txt"
	if suffix == ".pdf":
		return "pdf"
	if suffix == ".docx":
		return "docx"
	return suffix.lstrip(".") or "unknown"


def use_v2_pipeline(settings: Settings, filename: str) -> bool:
	"""INGEST_PIPELINE=v2 时启用 IR 路径；legacy 强制旧抽字+字窗。"""
	mode = (settings.ingest_pipeline or "v2").strip().lower()
	if mode != "v2":
		return False
	suffix = PurePosixPath(filename or "").suffix.lower()
	return suffix in V2_EXTENSIONS


def parse_to_ir(
	*,
	filename: str,
	content: bytes,
	title: str,
	settings: Settings,
	doc_id: str | None = None,
	library_id: str = "",
	content_type: str | None = None,
) -> DocumentIR:
	fmt = detect_format(filename)
	suffix = PurePosixPath(filename or "").suffix.lower()
	if suffix not in SUPPORTED_EXTENSIONS and fmt not in {"txt", "md", "pdf", "docx"}:
		raise ValueError(
			f"unsupported file type: {suffix or '(none)'}; use txt/md/pdf/docx"
		)

	if fmt == "txt":
		return parse_txt(
			content=content,
			filename=filename,
			title=title,
			doc_id=doc_id,
			library_id=library_id,
		)
	if fmt == "md":
		return parse_markdown(
			content=content,
			filename=filename,
			title=title,
			doc_id=doc_id,
			library_id=library_id,
		)
	if fmt == "docx":
		return parse_docx(
			content=content,
			filename=filename,
			title=title,
			doc_id=doc_id,
			library_id=library_id,
		)
	if fmt == "pdf":
		ocr_adapter = get_ocr_adapter(enabled=settings.ocr_enabled)
		vlm_adapter = get_vlm_adapter(
			enabled=settings.vlm_enabled,
			api_key=settings.llm_api_key,
			base_url=settings.llm_base_url,
			model=settings.vlm_model,
		)
		options = PdfParseOptions(
			scan_strategy=settings.pdf_scan_strategy,  # type: ignore[arg-type]
			ocr_enabled=settings.ocr_enabled,
			vlm_enabled=settings.vlm_enabled,
			ocr_adapter=ocr_adapter,
			vlm_adapter=vlm_adapter,
		)
		# Phase 2C：数字 PDF→PyMuPDF；扫描/复杂→MinerU（独立服务）
		return parse_pdf_routed(
			content=content,
			filename=filename,
			title=title,
			settings=settings,
			doc_id=doc_id,
			library_id=library_id,
			options=options,
		)

	raise ValueError(f"unsupported format for v2 ingest: {fmt}")


def legacy_flat_text(*, filename: str, content: bytes, content_type: str | None = None) -> dict[str, Any]:
	"""委托旧 documents.extract_text，供 INGEST_PIPELINE=legacy。"""
	from app.services.documents import extract_text

	parsed = extract_text(filename=filename, content=content, content_type=content_type)
	return {
		"filename": parsed.filename,
		"title": parsed.title,
		"text": parsed.text,
		"content_type": parsed.content_type,
		"parser": parsed.parser,
	}
