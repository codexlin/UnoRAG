"""PDF parser — 页级分流：text | suspect_scan | complex → IR。

WHY 页级而非整本：扫描/复杂页成本高；文本页可抽字+去页眉页脚；
page_start/end 绑定节点，杜绝「标 p.2 但正文从 Page 1 起」的旧 bug。
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from typing import Any, Literal
from uuid import uuid4

from app.services.ingest.ir import (
	DocumentIR,
	Node,
	NodeType,
	ParserReport,
	content_hash_bytes,
)

PageKind = Literal["text", "suspect_scan", "complex"]

# 页分类阈值（启发式，可后续测评调参）
_MIN_TEXT_CHARS = 40
_SCAN_MAX_CHARS = 25
_COMPLEX_IMAGE_AREA_RATIO = 0.35


@dataclass
class PdfParseOptions:
	"""扫描页策略：fail=整本失败；partial=仅成功页入库并标 partial。"""

	scan_strategy: Literal["fail", "partial"] = "partial"
	ocr_enabled: bool = False
	vlm_enabled: bool = False
	ocr_adapter: Any | None = None
	vlm_adapter: Any | None = None
	# Phase 2C：允许空 nodes 返回，供上层 MinerU 救援（禁止静默 ready）
	allow_empty: bool = False


def classify_page(*, char_count: int, image_area_ratio: float, image_count: int) -> PageKind:
	if char_count <= _SCAN_MAX_CHARS and (image_count > 0 or image_area_ratio > 0.2):
		return "suspect_scan"
	if image_area_ratio >= _COMPLEX_IMAGE_AREA_RATIO and char_count < 200:
		return "complex"
	if char_count < _MIN_TEXT_CHARS and image_count >= 1:
		return "complex" if image_area_ratio > 0.15 else "suspect_scan"
	return "text"


def parse_pdf(
	*,
	content: bytes,
	filename: str,
	title: str,
	doc_id: str | None = None,
	library_id: str = "",
	options: PdfParseOptions | None = None,
) -> DocumentIR:
	opts = options or PdfParseOptions()
	try:
		import fitz
	except ImportError as exc:
		raise ValueError("PDF support requires pymupdf; install project dependencies") from exc

	document = fitz.open(stream=content, filetype="pdf")
	report = ParserReport(source_format="pdf", parser="pymupdf_page_router")
	nodes: list[Node] = []
	page_line_bags: list[list[str]] = []

	try:
		page_infos: list[dict[str, Any]] = []
		for index, page in enumerate(document, start=1):
			raw = (page.get_text("text") or "").strip()
			char_count = len(re.sub(r"\s+", "", raw))
			images = page.get_images(full=True) or []
			image_count = len(images)
			# 面积比：优先 image blocks；失败则按图片数量近似（避免依赖不稳定 bbox API）
			page_rect = page.rect
			page_area = max(float(page_rect.width * page_rect.height), 1.0)
			image_area = 0.0
			try:
				for block in page.get_text("dict").get("blocks", []):
					if block.get("type") == 1:  # image block
						bbox = block.get("bbox") or [0, 0, 0, 0]
						image_area += abs((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
			except Exception:
				image_area = page_area * min(0.9, 0.2 * image_count)
			if image_area <= 0 and image_count:
				image_area = page_area * min(0.9, 0.2 * image_count)
			image_area_ratio = min(1.0, image_area / page_area)
			kind = classify_page(
				char_count=char_count,
				image_area_ratio=image_area_ratio,
				image_count=image_count,
			)
			page_infos.append(
				{
					"index": index,
					"kind": kind,
					"raw": raw,
					"char_count": char_count,
					"image_count": image_count,
					"image_area_ratio": image_area_ratio,
				}
			)
			page_line_bags.append([ln.strip() for ln in raw.splitlines() if ln.strip()])

		# 跨页重复行 → 页眉/页脚候选
		header_footer = _detect_repeated_lines(page_line_bags)

		for info in page_infos:
			index = int(info["index"])
			kind = info["kind"]
			raw = str(info["raw"])

			if kind == "text":
				cleaned = _strip_header_footer(raw, header_footer)
				cleaned = _dedupe_adjacent_lines(cleaned)
				if not cleaned.strip():
					report.failed_pages.append(index)
					report.warnings.append(f"page {index}: text page empty after cleanup")
					continue
				report.text_pages.append(index)
				nodes.append(
					Node(
						id=str(uuid4()),
						type=NodeType.PAGE,
						path=f"第{index}页",
						page_start=index,
						page_end=index,
						text=cleaned.strip(),
						confidence=0.85,
						meta={"page_kind": "text"},
					)
				)
				continue

			if kind == "suspect_scan":
				report.needs_ocr_pages.append(index)
				ocr_text = ""
				if opts.ocr_enabled and opts.ocr_adapter is not None:
					try:
						pix = document[index - 1].get_pixmap(dpi=150)
						ocr_text = opts.ocr_adapter.ocr_image(
							pix.tobytes("png"),
							page_number=index,
						)
					except Exception as exc:
						report.warnings.append(f"page {index}: OCR failed: {exc}")
						ocr_text = ""

				if ocr_text.strip():
					report.ocr_pages.append(index)
					nodes.append(
						Node(
							id=str(uuid4()),
							type=NodeType.PAGE,
							path=f"第{index}页",
							page_start=index,
							page_end=index,
							text=ocr_text.strip(),
							confidence=0.55,
							meta={"page_kind": "suspect_scan", "via": "ocr"},
						)
					)
				else:
					report.failed_pages.append(index)
					report.warnings.append(
						f"page {index}: scanned/low-text page needs OCR (not available or empty)"
					)
				continue

			# complex：先抽可得文字，并标记 vlm_pending
			cleaned = _strip_header_footer(raw, header_footer)
			cleaned = _dedupe_adjacent_lines(cleaned)
			vlm_note = ""
			if opts.vlm_enabled and opts.vlm_adapter is not None:
				try:
					pix = document[index - 1].get_pixmap(dpi=120)
					vlm_note = opts.vlm_adapter.describe_image(
						pix.tobytes("png"),
						page_number=index,
						hint="complex PDF page",
					)
					if vlm_note.strip():
						report.vlm_pages.append(index)
				except Exception as exc:
					report.warnings.append(f"page {index}: VLM failed: {exc}")
					report.vlm_pending_pages.append(index)
			else:
				report.vlm_pending_pages.append(index)

			parts = [p for p in (cleaned.strip(), vlm_note.strip()) if p]
			if not parts:
				report.failed_pages.append(index)
				report.warnings.append(f"page {index}: complex page with no extractable text")
				continue

			if cleaned.strip():
				report.text_pages.append(index)
			body = "\n\n".join(parts)
			nodes.append(
				Node(
					id=str(uuid4()),
					type=NodeType.PAGE,
					path=f"第{index}页",
					page_start=index,
					page_end=index,
					text=body,
					confidence=0.5,
					meta={
						"page_kind": "complex",
						"vlm_pending": index in report.vlm_pending_pages,
					},
					figure_desc=vlm_note or None,
				)
			)
	finally:
		document.close()

	# 整本策略
	if not nodes:
		report.backend = report.backend or "pymupdf"
		report.parser_version = report.parser_version or "1.0"
		report.mode = "text"
		report.partial = True
		report.notes = (
			"no extractable text via PyMuPDF (possibly scanned); "
			+ "; ".join(report.warnings[:3])
		)
		if opts.allow_empty:
			return DocumentIR(
				id=doc_id or str(uuid4()),
				library_id=library_id,
				source=filename,
				source_format="pdf",
				title=title,
				filename=filename,
				content_hash=content_hash_bytes(content),
				nodes=[],
				parser_report=report,
			)
		raise ValueError(
			"PDF has no extractable text (possibly scanned); "
			"enable MinerU (MINERU_ENABLED + MINERU_URL) or OCR; "
			+ "; ".join(report.warnings[:3])
		)

	if report.failed_pages or report.needs_ocr_pages:
		if opts.scan_strategy == "fail" and not report.text_pages and not report.ocr_pages:
			raise ValueError(
				"PDF scan/complex pages require OCR/VLM/MinerU; set PDF_SCAN_STRATEGY=partial "
				"to ingest successful pages only"
			)
		if opts.scan_strategy == "fail" and report.failed_pages and not (
			report.text_pages or report.ocr_pages or report.vlm_pages
		):
			raise ValueError(
				f"PDF pages failed without OCR/MinerU: {report.failed_pages}; "
				"enable MinerU/OCR or use PDF_SCAN_STRATEGY=partial"
			)
		# partial：有成功页则入库，UI 需提示
		if report.failed_pages or report.needs_ocr_pages or report.vlm_pending_pages:
			report.partial = True
			report.notes = (
				f"partial ingest: ok={len(report.text_pages)+len(report.ocr_pages)} "
				f"failed={len(report.failed_pages)} needs_ocr={len(report.needs_ocr_pages)} "
				f"vlm_pending={len(report.vlm_pending_pages)}"
			)

	report.backend = report.backend or "pymupdf"
	report.parser_version = report.parser_version or "1.0"
	report.mode = report.mode or "text"
	report.metrics = {
		**report.metrics,
		"node_count": len(nodes),
		"text_page_count": len(report.text_pages),
		"needs_ocr_count": len(report.needs_ocr_pages),
	}

	return DocumentIR(
		id=doc_id or str(uuid4()),
		library_id=library_id,
		source=filename,
		source_format="pdf",
		title=title,
		filename=filename,
		content_hash=content_hash_bytes(content),
		nodes=nodes,
		parser_report=report,
	)


def _detect_repeated_lines(page_bags: list[list[str]], *, min_pages: int = 3) -> set[str]:
	if len(page_bags) < min_pages:
		return set()
	counter: Counter[str] = Counter()
	for bag in page_bags:
		# 每页顶/底各取最多 2 行
		candidates = set(bag[:2] + bag[-2:])
		for line in candidates:
			if 2 <= len(line) <= 80:
				counter[line] += 1
	threshold = max(min_pages, int(len(page_bags) * 0.6))
	return {line for line, count in counter.items() if count >= threshold}


def _strip_header_footer(text: str, ban: set[str]) -> str:
	if not ban:
		return text
	kept = [ln for ln in text.splitlines() if ln.strip() not in ban]
	return "\n".join(kept)


def _dedupe_adjacent_lines(text: str) -> str:
	"""封面/缩微重复字：相邻完全相同行折叠。"""
	out: list[str] = []
	prev = None
	for line in text.splitlines():
		stripped = line.rstrip()
		if stripped == prev and stripped.strip():
			continue
		out.append(line)
		prev = stripped
	# 同一行内连续重复短 token（如「学号学号学号」）轻量压缩
	joined = "\n".join(out)
	joined = re.sub(r"([\u4e00-\u9fff]{1,4})\1{2,}", r"\1\1", joined)
	return joined
