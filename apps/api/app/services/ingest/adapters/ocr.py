"""OCR adapter interface.

选型说明见 docs/adr/0001-ocr-vlm-adapters.md：
默认尝试系统 Tesseract（若已安装 pytesseract + tesseract）；
否则提供 Stub，调用时返回明确错误而非静默空串（由 PDF 层决定 fail/partial）。
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class OcrAdapter(Protocol):
	def ocr_image(self, image_bytes: bytes, *, page_number: int | None = None) -> str:
		"""Return extracted text; raise on hard failure."""
		...


class TesseractOcrAdapter:
	"""Default impl when pytesseract + local tesseract binary are available."""

	def ocr_image(self, image_bytes: bytes, *, page_number: int | None = None) -> str:
		try:
			import pytesseract
			from PIL import Image
			import io
		except ImportError as exc:
			raise RuntimeError(
				"OCR requested but pytesseract/Pillow not installed; "
				"pip/uv add pytesseract pillow, and install tesseract binary"
			) from exc

		image = Image.open(io.BytesIO(image_bytes))
		# chi_sim+eng 常见中英混排；本机未装语言包时 tesseract 会报错上抛
		text = pytesseract.image_to_string(image, lang="chi_sim+eng")
		return (text or "").strip()


class StubOcrAdapter:
	"""No-op stub: always errors so callers mark needs_ocr / failed_pages honestly."""

	def ocr_image(self, image_bytes: bytes, *, page_number: int | None = None) -> str:
		raise RuntimeError(
			"OCR is not configured (OCR_ENABLED=false or no Tesseract). "
			"Scan pages require OCR or PDF_SCAN_STRATEGY=partial"
		)


def get_ocr_adapter(*, enabled: bool) -> OcrAdapter | None:
	if not enabled:
		return None
	try:
		import pytesseract  # noqa: F401
		from PIL import Image  # noqa: F401

		# Probe binary
		pytesseract.get_tesseract_version()
		return TesseractOcrAdapter()
	except Exception:
		return StubOcrAdapter()
