# ADR 0001 — OCR / VLM 适配器选型

**状态：** Superseded by [ADR-0002](./0002-mineru-complex-pdf.md) and
[ADR-0005](./0005-typescript-core-runtime.md)

**上下文：** 本文记录 Python 原型期的 Tesseract/VLM 方向，不是当前运行时配置。

## 决策

1. **历史 OCR 决策：** 接口 `OcrAdapter`；默认实现优先 **Tesseract**（`pytesseract` + 系统二进制）。未安装时返回 Stub，调用显式报错，由 `PDF_SCAN_STRATEGY=partial|fail` 决定整本失败或跳过页。
2. **VLM：** 接口 `VlmAdapter`；可选 OpenAI-compatible 多模态 chat（如 `qwen-vl-plus`）。无密钥时 NoOp，页标记 `vlm_pending`，不假装已理解。
3. **默认关闭：** `OCR_ENABLED=false`、`VLM_ENABLED=false`，避免全量成本。

## 后果

- 扫描件诚实失败 / 部分入库，UI 可见 notice。
- 后续可替换 PaddleOCR 等实现而不改 PDF 路由。

当前实现由 TypeScript `ParserProvider` 统一承载，本地 PDF 使用 LiteParse，扫描和
复杂 PDF 可进入自建或 302.AI MinerU。当前配置见 ADR-0002；不要重新引入上述
Python 环境变量。
