"""Optional OCR / VLM adapters — 默认 stub，按需启用。"""

from app.services.ingest.adapters.ocr import OcrAdapter, get_ocr_adapter
from app.services.ingest.adapters.vlm import VlmAdapter, get_vlm_adapter

__all__ = ["OcrAdapter", "VlmAdapter", "get_ocr_adapter", "get_vlm_adapter"]
