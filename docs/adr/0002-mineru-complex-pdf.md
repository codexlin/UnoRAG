# ADR 0002 — MinerU 补充复杂 / 扫描 PDF

**状态：** Accepted（2026-07-23）  
**上下文：** Phase 2C 需处理扫描件、双栏、复杂表、公式页；不得替换已验证的 PyMuPDF 数字 PDF 路径。

## 决策

1. **契约：** `DocumentParserBackend`；PyMuPDF 与 MinerU 均输出 `DocumentIR`。
2. **路由（`mineru_mode=auto`）：** 先 PyMuPDF；仅当扫描/失败/复杂页信号触发时升级整本 MinerU。正常数字 PDF 不调用 MinerU。
3. **MinerU 为独立 HTTP 服务：** `MINERU_URL` + timeout/retry；失败显式 degrade（有 PyMuPDF 节点则 partial）或 fail（无节点），禁止静默空文档。
4. **适配器：** `content_list` JSON → nodes（heading/table/figure/equation + page/bbox/reading_order），表格进入既有 table IndexRecord 链。
5. **默认关闭：** `MINERU_ENABLED=false`；测试可用 `MINERU_USE_FAKE=true`。

## 后果

- `parser_report` 暴露 `backend` / `parser_version` / `mode` / `failed_pages` / `latency_ms` / 轻量 `metrics`。
- 无 MinerU 时扫描件仍诚实失败（错误信息提示启用 MinerU/OCR）。
- 后续可换 MinerU 服务实现而不改 chunker / retrieval。
