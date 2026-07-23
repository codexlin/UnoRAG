"""Optional OCR / VLM / MinerU adapters — 默认 stub，按需启用。"""

from app.services.ingest.adapters.mineru_ir import content_list_to_nodes, mineru_json_to_ir
from app.services.ingest.adapters.ocr import OcrAdapter, get_ocr_adapter
from app.services.ingest.adapters.vlm import VlmAdapter, get_vlm_adapter

__all__ = [
	"OcrAdapter",
	"VlmAdapter",
	"content_list_to_nodes",
	"get_ocr_adapter",
	"get_vlm_adapter",
	"mineru_json_to_ir",
]
