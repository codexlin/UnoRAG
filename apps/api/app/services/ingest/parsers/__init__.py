"""L1 parsers: bytes → DocumentIR."""

from app.services.ingest.parsers.docx import parse_docx
from app.services.ingest.parsers.md import parse_markdown
from app.services.ingest.parsers.pdf import parse_pdf
from app.services.ingest.parsers.txt import parse_txt

__all__ = ["parse_docx", "parse_markdown", "parse_pdf", "parse_txt"]
