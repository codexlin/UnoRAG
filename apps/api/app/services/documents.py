from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import PurePosixPath

logger = logging.getLogger(__name__)

SUPPORTED_EXTENSIONS = {".txt", ".md", ".markdown", ".pdf"}


@dataclass
class ParsedDocument:
	filename: str
	title: str
	text: str
	content_type: str
	parser: str


def _guess_title(filename: str) -> str:
	stem = PurePosixPath(filename).stem.strip() or "未命名文档"
	return stem[:512]


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
