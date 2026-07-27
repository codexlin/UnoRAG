# 试点验收与正式发布（L9）

本目录是 **L9 试点验收包**：把私有部署从「能装」推进到可签字的 go/no-go。
不包含虚构客户试点数据；操作员用自有工作区与代表性文件集填写模板。

产品北极星与剩余工程缺口见 [`../PRODUCT.md`](../PRODUCT.md) · [`../ROADMAP.md`](../ROADMAP.md)。

## 文档

| 文档 | 用途 |
|---|---|
| [`../runbooks/pilot-acceptance.md`](../runbooks/pilot-acceptance.md) | 试点执行 runbook（顺序、SLO、故障演练、结论） |
| [`pilot-go-no-go-template.md`](./pilot-go-no-go-template.md) | 版本化验收报告 + go/no-go 填空模板 |
| [`reports/2026-07-25-local-hybrid-pilot.md`](./reports/2026-07-25-local-hybrid-pilot.md) | 本机混合拓扑试点记录（**条件 GO**，非 production-ready） |
| [`production-ready-checklist.md`](./production-ready-checklist.md) | 宣称 production-ready 前的定义清单 |
| [`backup-restore-verification.md`](./backup-restore-verification.md) | 绑定 L8 `backup.sh` / `restore.sh` 的恢复验收 |
| [`../runbooks/quality-release-gates.md`](../runbooks/quality-release-gates.md) | L7 质量门禁（隔离 fuse 必过） |
| [`../runbooks/private-deployment.md`](../runbooks/private-deployment.md) | L8 安装 / 升级 / 备份 |

## 自动化

| 脚本 | 用途 |
|---|---|
| [`../../deploy/compose/scripts/pilot-smoke.sh`](../../deploy/compose/scripts/pilot-smoke.sh) | Compose 全栈冒烟：login → upload → ask → Public API v1 真实 Service Key Retrieve/Ask 与权限/契约反测 → replace → delete |
| [`../../deploy/compose/scripts/pilot-preflight.sh`](../../deploy/compose/scripts/pilot-preflight.sh) | 离线隔离单测 + CI 质量门禁（无 Compose 也可跑） |
| [`../../scripts/acceptance/s1_s2_isolation.sh`](../../scripts/acceptance/s1_s2_isolation.sh) | **S1/S2** 多组织/多工作区可重复隔离验收（Retrieve+Ask+IDOR+restricted ACL） |
| [`../../scripts/acceptance/b2_restore_drill.sh`](../../scripts/acceptance/b2_restore_drill.sh) | **B2** 独立 Compose volumes backup→restore（不碰主开发数据） |
| [`../../scripts/acceptance/b3_b4_upgrade_rollback.sh`](../../scripts/acceptance/b3_b4_upgrade_rollback.sh) | **B3/B4** 独立环境升级冒烟 + 应用回滚 / 数据恢复回滚 |
| [`../../scripts/acceptance/r_fault_injection.sh`](../../scripts/acceptance/r_fault_injection.sh) | **R1–R4** Worker / Qdrant / 模型 / MinerU 故障注入 |
| [`observability-min-runbook.md`](./observability-min-runbook.md) | 最低观测/告警草稿（`trace_id` → 网关/模型/检索/DB/Worker） |
| [`../../scripts/acceptance/README.md`](../../scripts/acceptance/README.md) | 验收脚本如何跑、依赖、退出码 |
| [`reports/2026-07-26-pilot-rc-b2-r-fault.md`](./reports/2026-07-26-pilot-rc-b2-r-fault.md) | B2 + R1–R4 实测片段（RC2-X `a79d2a5`） |
| [`reports/2026-07-27-pilot-rc-b3-b4.md`](./reports/2026-07-27-pilot-rc-b3-b4.md) | B3/B4 升级 + 回滚实测（绑 `88b72d9`） |
| [`reports/2026-07-27-pilot-rc-b5-min-alerts.md`](./reports/2026-07-27-pilot-rc-b5-min-alerts.md) | B5 最低告警 webhook 实测（绑 `9b80fe3` / `c4c0f6c`） |
| [`reports/2026-07-27-pilot-formal-go-no-go.md`](./reports/2026-07-27-pilot-formal-go-no-go.md) | **正式签字结论稿**（技术可进入签字；**待审批人签字**） |
| [`reports/2026-07-27-private-v1-rc3-browser.md`](./reports/2026-07-27-private-v1-rc3-browser.md) | Private Deployment v1.0 RC3 真实浏览器与质量门禁验收 |
| [`reports/2026-07-27-private-v1-rc3-formal-go-no-go.md`](./reports/2026-07-27-private-v1-rc3-formal-go-no-go.md) | **RC3 专属签字稿**（唯一产品审批对象 `a255752`；建议 Conditional GO） |
| [`reports/2026-07-27-live-retrieval-quality-baseline.md`](./reports/2026-07-27-live-retrieval-quality-baseline.md) | 真实入库 / Qdrant / live 模型质量基线（Recall、MRR、引用噪声、拒答与延迟） |

退出码约定（上述脚本一致）：

- `0` — 通过  
- `1` — 失败（阻断 go）  
- `2` — 跳过 / BLOCKED（服务/密钥/依赖不可用；不算通过，也不算产品缺陷）

## 宣称 production-ready 的条件

仅当 [`production-ready-checklist.md`](./production-ready-checklist.md) A–E 必选项全部勾选、
F 类非阻断项已写入已知限制，且 [`pilot-go-no-go-template.md`](./pilot-go-no-go-template.md)
记录明确 **GO** 时，才可针对该版本与部署环境写 production-ready。代码与验收包到位
**不等于** 已获 go。
