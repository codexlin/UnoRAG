# 验收钩子入口

S1/S2 通过后的 B2 / B3–B4 / R1–R4 / 观测入口。脚本已实现，可重复执行。

| ID | 主题 | 脚本 / 文档 |
|---|---|---|
| B2 | 独立环境 backup→restore | [`../b2_restore_drill.sh`](../b2_restore_drill.sh) · [`../compose.b2-infra.yml`](../compose.b2-infra.yml) · 清单 [`../../../docs/acceptance/backup-restore-verification.md`](../../../docs/acceptance/backup-restore-verification.md) |
| B3/B4 | 升级 + 应用/数据回滚 | [`../b3_b4_upgrade_rollback.sh`](../b3_b4_upgrade_rollback.sh)（复用 B2 infra compose） |
| R1–R4 | 故障注入 | [`../r_fault_injection.sh`](../r_fault_injection.sh)（`MERIKNOW_R_CASES='R1 R2 R3 R4'`） |
| Obs | 最低观测 | [`../../../docs/acceptance/observability-min-runbook.md`](../../../docs/acceptance/observability-min-runbook.md) |

证据报告：[`../../../docs/acceptance/reports/2026-07-26-pilot-rc-b2-r-fault.md`](../../../docs/acceptance/reports/2026-07-26-pilot-rc-b2-r-fault.md)。

退出码与 S1/S2 一致：`0` PASS · `1` FAIL · `2` BLOCKED。
