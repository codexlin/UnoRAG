# 后续验收钩子（占位）

本目录只登记入口，不实现完整演练。S1/S2 脚本通过后再补。

| ID | 主题 | 建议入口 |
|---|---|---|
| B2 | 备份恢复演练 | [`deploy/compose/scripts/backup.sh`](../../../deploy/compose/scripts/backup.sh) · [`restore.sh`](../../../deploy/compose/scripts/restore.sh) · [`docs/acceptance/backup-restore-verification.md`](../../../docs/acceptance/backup-restore-verification.md) |
| R1 | Worker drain / 停 worker | 停 lifecycle worker → 观察 job 排队 → 恢复 |
| R2 | Qdrant 短暂不可用 | 停 Qdrant → Ask/ingest 失败模式 → 恢复后一致性 |
| R3 | 模型不可用 | 临时错误 `ASK_MODE` / 上游 5xx → 拒答与降级 |
| R4 | MinerU 不可用 | 断 MinerU → 扫描件降级 / circuit breaker（见产品 runbook） |
| Obs | 观测 | API `ask.trace` 日志、workspace audit、`pnpm lifecycle:inspect` |

建议新增脚本命名：`b2_restore_drill.sh`、`r_fault_injection.sh`（勿与 S1/S2 混在同一退出码语义里）。
