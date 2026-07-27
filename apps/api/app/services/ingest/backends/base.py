"""DocumentParserBackend — 所有 PDF/复杂文档解析器的统一契约。

WHY: PyMuPDF 与 MinerU 输出必须同为 DocumentIR，才能共用 chunker / table IndexRecord / citation。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Protocol, runtime_checkable

from app.services.ingest.ir import CancelCheck, DocumentIR, ParseProgressCallback


@dataclass
class ParseRequest:
	content: bytes
	filename: str
	title: str
	doc_id: str | None = None
	library_id: str = ""
	options: Any | None = None
	progress_callback: ParseProgressCallback | None = None
	cancel_check: CancelCheck | None = None
	# Provider-owned resumable state (for example an external async task id).
	# Secrets must never be stored here.
	provider_state: dict[str, Any] | None = None
	provider_state_callback: Callable[[dict[str, Any]], None] | None = None


@runtime_checkable
class DocumentParserBackend(Protocol):
	"""后端须产出 DocumentIR；失败显式抛错，禁止静默空文档。"""

	@property
	def name(self) -> str: ...

	@property
	def version(self) -> str: ...

	def parse(self, request: ParseRequest) -> DocumentIR: ...
