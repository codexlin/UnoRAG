"""PyMuPDF backend — 默认数字 PDF 路径，委托 parsers.pdf。"""

from __future__ import annotations

from app.services.ingest.backends.base import ParseRequest
from app.services.ingest.ir import DocumentIR
from app.services.ingest.parsers.pdf import parse_pdf

PYMUPDF_BACKEND_VERSION = "1.0"


class PyMuPDFBackend:
	@property
	def name(self) -> str:
		return "pymupdf"

	@property
	def version(self) -> str:
		return PYMUPDF_BACKEND_VERSION

	def parse(self, request: ParseRequest) -> DocumentIR:
		ir = parse_pdf(
			content=request.content,
			filename=request.filename,
			title=request.title,
			doc_id=request.doc_id,
			library_id=request.library_id,
			options=request.options,
		)
		report = ir.parser_report
		report.backend = report.backend or self.name
		report.parser_version = report.parser_version or self.version
		report.mode = report.mode or "text"
		return ir
