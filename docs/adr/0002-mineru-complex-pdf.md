# ADR 0002 — MinerU 补充复杂 / 扫描 PDF

**状态：** 已迁移到 TypeScript；运行时边界以 [ADR-0005](./0005-typescript-core-runtime.md) 为准

> 当前 TypeScript 运行时已实现 `self_hosted` 与 `302ai` 两种 MinerU Provider。
> 302 的成本预算、完整结构化指标和跨重启去重仍是后续工作；下文对应段落会
> 明确标记为计划项。

**上下文：** 复杂 PDF 需要扫描、双栏、复杂表和公式能力；普通数字 PDF 保留
LiteParse 本地路径，避免所有文档无条件出域。

## 决策

1. **契约：** `DurableParserProvider`；LiteParse 与 MinerU 均输出 `DocumentIR`。
2. **路由：** 先由 LiteParse 分析；OCR、表格、图形、高复杂度或知识库
   `parse_preference=quality` 会偏好 MinerU。Provider 的实际选择仍受部署与出域策略约束。
3. **统一语义、分离传输：** `self_hosted` 遵循同步 `POST /file_parse` +
   multipart `files` 契约；`302ai` 使用 upload → create task → poll → ZIP。
   两者只在 provider adapter 内不同，统一输出 `DocumentIR`，失败显式
   degrade（有 LiteParse 节点则 partial）或 fail（无节点），禁止静默空文档。
4. **耐久执行：** 302 提交、轮询和结果获取运行在 DBOS ingest workflow 中；
   取消和超时检查贯穿轮询。Provider 内层按错误类型退避：同一 idempotency key 重试 submit，
   同一远端 task 重试 poll/fetch；耗尽后再交给 DBOS 外层恢复。跨进程重启的外部提交去重仍需专项故障验收。
5. **文档出域必须显式授权：** 302 provider 要求
   `EXTERNAL_PARSER_ALLOWED=true`；API key 仅由运行时 Secret 注入 worker，不能进入
   ConfigMap、payload、日志或 parser report。结果下载不向文件域转发 Bearer
   token，并校验 HTTPS/302 域名。
6. **适配器：** 支持直接 `content_list` 及 `results[filename].content_list` 包装；`content_list` 可为数组或 JSON 字符串，非法字符串显式失败。输出 heading/table/figure/equation + page/bbox/reading_order，表格进入既有 table IndexRecord 链。
7. **表格边界：** 展开 `rowspan` / `colspan`，无 `<th>` 时不臆造表头；页眉、页脚、页码等辅助块不进入正文且不打断续表。仅对相邻页、列结构兼容且有明确 continuation 信号（或相同上游 table id）的表做跨页合并；`第 N 页` 只参与 caption 归一化，不能单独触发合并。
8. **标题路径：** 按 `text_level` 维护 heading stack，向 chunker 提供完整 section path。
9. **默认私有：** 默认 Provider 为 `self_hosted`；302 必须同时设置
   `MINERU_PROVIDER=302ai`、`EXTERNAL_PARSER_ALLOWED=true` 和 worker Secret 中的
   `MINERU_API_KEY`。

## 产品配置边界（P1）

**原则：** 部署管理员管基础设施；Workspace/知识库用户只调业务意图。

| 层 | 可配置项 | 禁止暴露给终端用户 |
|---|---|---|
| **Deploy-only**（`runtime.env` / Secret / Helm） | `MINERU_PROVIDER`、`MINERU_API_KEY`（worker-only）、`EXTERNAL_PARSER_ALLOWED`、Base URL、超时、容量 | Provider URL、API Key、超时、容量、成本费率 |
| **Library intent**（`parse_preference` + `scan_handling`） | `auto` 自动识别；`quality` 强制高质量解析；`local_only` 严格不出域；`scan_handling` 控制是否允许扫描件 / 仅文本 | 不得选择 `self_hosted` vs `302ai` |

**映射（fail-closed）：**

```text
parse_preference=quality + deploy 允许增强 → prefer MinerU（不挑供应商）
parse_preference=quality + EXTERNAL_PARSER_ALLOWED=false 且 Provider=302ai
  → 回退本地，parser_report.metrics.degrade_reason=external_parser_forbidden
parse_preference=local_only 或 scan_handling=disabled
  → enhanced_parser_allowed=false（本库不出域 / 仅文本）
```

UI / API 展示（来自 `parser_report` + job）：实际解析器（LiteParse / 自建 MinerU / 302）、是否出域、任务状态（含等待 302）、降级原因、解析质量提示；`provider_task_id` 仅脱敏 `first8…last4`。

## 后果

- `parser_report` 暴露 `backend` / `parser_version` / `mode` / `failed_pages` / `latency_ms` / 轻量 `metrics`。
- 无 MinerU 时扫描件仍诚实失败（错误信息提示启用 MinerU/OCR）。
- 可在自建与 302 MinerU 间切换而不改 chunker / retrieval；切换权仅在部署层。

## Ops：302 可观测性与成本（计划项）

**关联字段：** `trace_id`（可选，job payload）→ `job_id` → `document_id` →
`provider_task_id`（外部仅脱敏：`first8…last4`）。完整 task id 只留在 job
payload `mineru_provider_state.task_id`，不进 `parser_report` / UI。

**日志事件（JSON 行，`event=`）：**

| event | 何时 | 看什么 |
|---|---|---|
| `mineru.302.upload` / `create` | 上传 / 创建任务 | `latency_ms`、`page_count`、`estimated_cost` |
| `mineru.302.pending` | poll 未完成 | `wait_s`、`poll_count`、`provider_latency_ms` |
| `mineru.302.long_pending` | wait ≥ `MINERU_302_LONG_PENDING_S` | 为何慢 |
| `mineru.302.complete` | 成功 | 总成本估计、等待时长 |
| `mineru.302.fail` | 超时 / 429 / 5xx / invalid | `error_code`、`metric`、`phase` |
| `mineru.302.budget_exceeded` / `budget_near_limit` | 日预算门禁 | `spent` / `budget` |
| `mineru.302.duplicate_submit` | 无 task_id 却带非失败 prior state | 重复计费风险 |

Worker 另有：`document_ingest.mineru_pending … provider_task_id=… wait_s=…`。

**环境变量（非密钥，worker 生效；均为 deploy-only）：**

- `MINERU_302_COST_PER_PAGE`（默认 `0.02`，占位单价）
- `MINERU_302_DAILY_BUDGET`（默认 `0`=关闭；超出则 fail-closed 拒绝新 submit）
- `MINERU_302_BUDGET_WARN_RATIO`（默认 `0.8`）
- `MINERU_302_LONG_PENDING_S`（默认 `300`）

进程内计数器键：`mineru_302_upload|create|complete|fail|429|5xx|timeout|invalid_result|pending|budget_exceeded`。
无 Prometheus 时靠结构化日志；workspace 日/月汇总 UI 为后续项。
客户监控系统可对 `mineru.302.fail` / `long_pending` / `budget_*` 增加规则。
