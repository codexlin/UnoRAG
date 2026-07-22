from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import PurePosixPath

logger = logging.getLogger(__name__)

# legacy extract_text 仍支持的集合；v2 另含 .docx（见 ingest.router）
SUPPORTED_EXTENSIONS = {".txt", ".md", ".markdown", ".pdf"}
_PAGE_RE = re.compile(r"(?m)^## Page (\d+)\s*$")
_NOISY_PREFIX_RE = re.compile(
	r"^(学号|编号|姓名|班级|指导教师)[：:\s]*",
	re.IGNORECASE,
)


@dataclass
class ParsedDocument:
	filename: str
	title: str
	text: str
	content_type: str
	parser: str


def clean_display_title(raw: str, *, filename: str | None = None) -> str:
	"""Normalize upload stems into readable display names."""
	stem = (raw or "").strip()
	if not stem and filename:
		stem = PurePosixPath(filename).stem.strip()
	stem = stem or "未命名文档"
	cleaned = stem
	# Strip repeated noisy form-field prefixes (e.g. 学号：2022…)
	for _ in range(4):
		nxt = _NOISY_PREFIX_RE.sub("", cleaned).strip(" -_./\\")
		if nxt == cleaned:
			break
		cleaned = nxt
	cleaned = cleaned or stem
	# Extremely short stems stay usable but callers may warn in UI.
	return cleaned[:512]


def _guess_title(filename: str) -> str:
	stem = PurePosixPath(filename).stem.strip() or "未命名文档"
	return clean_display_title(stem, filename=filename)


def infer_page_label(text: str) -> str | None:
	"""Best-effort page from embedded `## Page N` markers.

	Legacy only：取**第一个**标记作为主页面（旧逻辑取最后一个会导致
	「标 p.2 但正文从 Page 1 起」）。v2 PDF 应使用 chunk.page_start/end。
	"""
	matches = list(_PAGE_RE.finditer(text or ""))
	if not matches:
		return None
	if len(matches) == 1:
		return f"p.{matches[0].group(1)}"
	first = int(matches[0].group(1))
	last = int(matches[-1].group(1))
	if first == last:
		return f"p.{first}"
	return f"p.{first}-{last}"


def extract_text(
	*,
	filename: str,
	content: bytes,
	content_type: str | None = None,
) -> ParsedDocument:
	name = (filename or "untitled.txt").strip() or "untitled.txt"
	suffix = PurePosixPath(name).suffix.lower()
	if suffix not in SUPPORTED_EXTENSIONS:
		raise ValueError(f"unsupported file type: {suffix or '(none)'}; use txt/md/pdf")

	if suffix in {".txt", ".md", ".markdown"}:
		text = _decode_text(content)
		return ParsedDocument(
			filename=name,
			title=_guess_title(name),
			text=text,
			content_type=content_type or "text/plain",
			parser="text",
		)

	text = _extract_pdf(content)
	return ParsedDocument(
		filename=name,
		title=_guess_title(name),
		text=text,
		content_type=content_type or "application/pdf",
		parser="pymupdf",
	)


def _decode_text(content: bytes) -> str:
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


def _extract_pdf(content: bytes) -> str:
	try:
		import fitz
	except ImportError as exc:
		raise ValueError("PDF support requires pymupdf; install project dependencies") from exc

	document = fitz.open(stream=content, filetype="pdf")
	try:
		pages: list[str] = []
		for index, page in enumerate(document, start=1):
			page_text = (page.get_text("text") or "").strip()
			if page_text:
				pages.append(f"## Page {index}\n\n{page_text}")
		text = "\n\n".join(pages).strip()
		if not text:
			raise ValueError("PDF has no extractable text (possibly scanned)")
		return text
	finally:
		document.close()
