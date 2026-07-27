# ADR 0002 — MinerU 补充复杂 / 扫描 PDF

**状态：** Accepted（2026-07-23）
**上下文：** Phase 2C 需处理扫描件、双栏、复杂表、公式页；不得替换已验证的 PyMuPDF 数字 PDF 路径。

## 决策

1. **契约：** `DocumentParserBackend`；PyMuPDF 与 MinerU 均输出 `DocumentIR`。
2. **路由（`mineru_mode=auto`）：** 先 PyMuPDF；仅当扫描/失败/复杂页信号触发时升级整本 MinerU。正常数字 PDF 不调用 MinerU。
3. **统一语义、分离传输：** `self_hosted` 遵循同步 `POST /file_parse` +
   multipart `files` 契约；`302ai` 使用 upload → create task → poll → ZIP。
   两者只在 provider adapter 内不同，统一输出 `DocumentIR`，失败显式
   degrade（有 PyMuPDF 节点则 partial）或 fail（无节点），禁止静默空文档。
4. **异步任务不占 worker：** 302 task id 持久化到 job payload，poll 未完成时
   释放 lease 并延迟续跑，且不消耗 attempt；最长等待由
   `MINERU_302_MAX_WAIT_S` 限制。
5. **文档出域必须显式授权：** 302 provider 要求
   `EXTERNAL_PARSER_ALLOWED=true`；API key 仅由运行时 Secret 注入 worker，不能进入
   ConfigMap、payload、日志或 parser report。结果下载不向文件域转发 Bearer
   token，并校验 HTTPS/302 域名。
6. **适配器：** 支持直接 `content_list` 及 `results[filename].content_list` 包装；`content_list` 可为数组或 JSON 字符串，非法字符串显式失败。输出 heading/table/figure/equation + page/bbox/reading_order，表格进入既有 table IndexRecord 链。
7. **表格边界：** 展开 `rowspan` / `colspan`，无 `<th>` 时不臆造表头；页眉、页脚、页码等辅助块不进入正文且不打断续表。仅对相邻页、列结构兼容且有明确 continuation 信号（或相同上游 table id）的表做跨页合并；`第 N 页` 只参与 caption 归一化，不能单独触发合并。
8. **标题路径：** 按 `text_level` 维护 heading stack，向 chunker 提供完整 section path。
9. **默认关闭：** `MINERU_ENABLED=false`；测试可用 `MINERU_USE_FAKE=true`。

## 后果

- `parser_report` 暴露 `backend` / `parser_version` / `mode` / `failed_pages` / `latency_ms` / 轻量 `metrics`。
- 无 MinerU 时扫描件仍诚实失败（错误信息提示启用 MinerU/OCR）。
- 可在自建与 302 MinerU 间切换而不改 chunker / retrieval。
