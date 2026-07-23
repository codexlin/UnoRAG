"""Document parser backends — PyMuPDF (default) + MinerU (complex/scan)."""

from app.services.ingest.backends.base import DocumentParserBackend, ParseRequest
from app.services.ingest.backends.mineru import (
	FakeMinerUBackend,
	MinerUBackend,
	MinerUClientError,
	get_mineru_backend,
)
from app.services.ingest.backends.pymupdf import PyMuPDFBackend

__all__ = [
	"DocumentParserBackend",
	"FakeMinerUBackend",
	"MinerUBackend",
	"MinerUClientError",
	"ParseRequest",
	"PyMuPDFBackend",
	"get_mineru_backend",
]
