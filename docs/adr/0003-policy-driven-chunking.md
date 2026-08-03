# ADR 0003 — Policy-driven Chunking

**状态：** Accepted（2026-07-23）
**上下文：** Phase 2D 需要支持结构、递归、固定窗口和语义切分，但不能让每种文件格式各自维护一套不可观测的分支。

## 决策

1. **结构优先：** `DocumentIR` 中的 heading、page、table、code 是第一决策信号。table/code 始终独立，heading/page 在不超限时保留边界；超长节点内再递归切分。
2. **统一 policy：** `ChunkingProfile` 统一承载 `target_chars`、`max_chars`、overlap、标题边界、语义阈值和表格行组大小。当前 profile 为 `precise | balanced | narrative | table_heavy`，默认 `balanced`。
3. **语义切分受限：** 仅对长、无 section、叙事型文本启用。它使用相邻句向量距离的百分位作为候选边界，并受 `max_chars` 硬上限约束；不会二次切 table/code，也不会覆盖明确标题边界。
4. **成本显式：** `ChunkingOptions.semanticEnabled` 默认为 `false`。关闭时 ingest 不产生额外 embedding 请求；启用时必须显式提供 semantic embedder，测试可注入确定性实现。
5. **可靠降级：** embedding 缺失、超时、维度错误、空向量或语义单元异常时回退 recursive；recursive 无结果才回退 char window。降级不得静默。
6. **可观测：** chunk 与 Qdrant payload 写入 `chunk_policy_version`、`chunk_profile`、`split_strategy`、`split_reason` 和语义统计；`parser_report.metrics.chunking` 汇总策略数量与 fallback 数量。
7. **表格 profile 生效：** `table_heavy` 将 table IndexRecord 行组从默认 40 行缩到 20 行，提升精确行召回；原始 table chunk 仍保留。

## Profile 语义

| Profile | 用途 | 主要变化 |
|---|---|---|
| `precise` | 条款、合同、精确事实 | target 较小，保留更多局部上下文 |
| `balanced` | 默认企业文档 | 兼顾召回、上下文和索引成本 |
| `narrative` | 长报告、叙事文本 | target 接近 max，适合可选语义边界 |
| `table_heavy` | 报表、清单 | table row group 缩至 20 行 |

## 验收边界

- 默认配置下既有 v2 切分与 HTTP 契约不变。
- heading/page/table/code 的结构边界优先级高于 semantic。
- semantic 成功和所有 fallback 均有确定性单测。
- profile、决策原因和 fallback 可从 parser report 与索引 payload 读取。
- profile 或 policy 变化必须跑黄金集；后续线上 A/B 以 `chunk_policy_version` 分组。

## 后果

- 当前策略是文档级 profile，尚未根据租户或单文档分类器自动选择；调用方可在配置层指定。
- semantic 会增加 ingest embedding 成本，只有评测证明收益后才应生产启用。
- policy version 改变可能导致 chunk 内容和 point id 变化，应通过 reindex 发布。
