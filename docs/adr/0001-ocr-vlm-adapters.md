# ADR 0001 — OCR / VLM 适配器选型

**状态：** Accepted（2026-07-23）  
**上下文：** Phase C 需为扫描页 / 复杂页预留视觉能力，但不阻塞 MD/TXT/文本 PDF 主路径。

## 决策

1. **OCR：** 接口 `OcrAdapter`；默认实现优先 **Tesseract**（`pytesseract` + 系统二进制）。未安装时返回 Stub，调用显式报错，由 `PDF_SCAN_STRATEGY=partial|fail` 决定整本失败或跳过页。
2. **VLM：** 接口 `VlmAdapter`；可选 OpenAI-compatible 多模态 chat（如 `qwen-vl-plus`）。无密钥时 NoOp，页标记 `vlm_pending`，不假装已理解。
3. **默认关闭：** `OCR_ENABLED=false`、`VLM_ENABLED=false`，避免全量成本。

## 后果

- 扫描件诚实失败 / 部分入库，UI 可见 notice。
- 后续可替换 PaddleOCR 等实现而不改 PDF 路由。
