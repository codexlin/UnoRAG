# 试点验收与正式发布

本目录把私有部署从“能安装”推进到可签字的 go/no-go。
不包含虚构客户试点数据；操作员用自有工作区与代表性文件集填写模板。

产品北极星与剩余工程缺口见 [`../PRODUCT.md`](../PRODUCT.md) · [`../ROADMAP.md`](../ROADMAP.md)。

## 最新基线

| 报告 | 结论 |
|---|---|
| [`reports/2026-07-29-webch-preproduction-baseline.md`](./reports/2026-07-29-webch-preproduction-baseline.md) | webch 真实浏览器、真实文件、多 Workspace、隔离、故障与非破坏恢复 **PASS**；环境定位为预发布模拟，不是客户生产 |

日期报告只证明绑定版本和环境。当前产品能力以
[`../STATUS.md`](../STATUS.md) 为准，不能用旧报告反推最新代码状态。

## 可复用文档

| 文档 | 用途 |
|---|---|
| [`../runbooks/pilot-acceptance.md`](../runbooks/pilot-acceptance.md) | 试点执行 runbook（顺序、SLO、故障演练、结论） |
| [`pilot-go-no-go-template.md`](./pilot-go-no-go-template.md) | 版本化验收报告 + go/no-go 填空模板 |
| [`production-ready-checklist.md`](./production-ready-checklist.md) | 宣称 production-ready 前的定义清单 |
| [`backup-restore-verification.md`](./backup-restore-verification.md) | `backup.sh` / `restore.sh` 恢复验收 |
| [`observability-min-runbook.md`](./observability-min-runbook.md) | 最低观测、告警和排障路径 |
| [`../runbooks/quality-release-gates.md`](../runbooks/quality-release-gates.md) | 质量门禁（隔离 fuse 必过） |
| [`../runbooks/private-deployment.md`](../runbooks/private-deployment.md) | 安装、升级、回滚与备份 |

## 自动化

| 脚本 | 用途 |
|---|---|
| [`../../deploy/compose/scripts/pilot-smoke.sh`](../../deploy/compose/scripts/pilot-smoke.sh) | Compose 全栈冒烟：login → upload → ask → Public API v1 真实 Service Key Retrieve/Ask 与权限/契约反测 → replace → delete |
| [`../../deploy/compose/scripts/pilot-preflight.sh`](../../deploy/compose/scripts/pilot-preflight.sh) | 离线隔离单测 + CI 质量门禁（无 Compose 也可跑） |
| [`../../scripts/acceptance/s1_s2_isolation.sh`](../../scripts/acceptance/s1_s2_isolation.sh) | **S1/S2** 多组织/多工作区可重复隔离验收（Retrieve+Ask+IDOR+restricted ACL） |
| [`../../scripts/acceptance/b2_restore_drill.sh`](../../scripts/acceptance/b2_restore_drill.sh) | **B2** 独立 Compose volumes backup→restore（不碰主开发数据） |
| [`../../scripts/acceptance/b3_b4_upgrade_rollback.sh`](../../scripts/acceptance/b3_b4_upgrade_rollback.sh) | **B3/B4** 独立环境升级冒烟 + 应用回滚 / 数据恢复回滚 |
| [`../../scripts/acceptance/r_fault_injection.sh`](../../scripts/acceptance/r_fault_injection.sh) | **R1–R4** Worker / Qdrant / 模型 / MinerU 故障注入 |
| [`../../scripts/acceptance/README.md`](../../scripts/acceptance/README.md) | 验收脚本如何跑、依赖、退出码 |

退出码约定（上述脚本一致）：

- `0` — 通过  
- `1` — 失败（阻断 go）  
- `2` — 跳过 / BLOCKED（服务/密钥/依赖不可用；不算通过，也不算产品缺陷）

## 历史证据

`reports/` 中的日期文件是绑定 commit、环境和当时配置的不可变证据，不是当前能力说明。
它们按主题列在这里，避免接手者只看到最近几份：

| 主题 | 报告 |
|---|---|
| 本地与隔离 | [`2026-07-25 local hybrid`](./reports/2026-07-25-local-hybrid-pilot.md) · [`2026-07-26 S1/S2`](./reports/2026-07-26-pilot-rc-s1-s2.md) |
| 故障、恢复、升级 | [`2026-07-26 B2/R`](./reports/2026-07-26-pilot-rc-b2-r-fault.md) · [`2026-07-27 B3/B4`](./reports/2026-07-27-pilot-rc-b3-b4.md) · [`2026-07-27 B5`](./reports/2026-07-27-pilot-rc-b5-min-alerts.md) |
| 解析与质量 | [`live retrieval baseline`](./reports/2026-07-27-live-retrieval-quality-baseline.md) · [`MinerU provider`](./reports/2026-07-27-mineru-302-provider-smoke.md) · [`MinerU lifecycle`](./reports/2026-07-27-mineru-302-lifecycle-e2e.md) · [`policy upgrade`](./reports/2026-07-27-post-pilot-policy-upgrade-smoke.md) |
| 私有部署 RC | [`0170ba8 black-box`](./reports/2026-07-27-private-0170ba8-blackbox.md) · [`29b06fe fault/backup`](./reports/2026-07-27-private-29b06fe-fault-backup.md) · [`RC3 browser`](./reports/2026-07-27-private-v1-rc3-browser.md) |
| API 与签字稿 | [`Public API v1 E2E`](./reports/2026-07-27-public-api-v1-e2e.md) · [`pilot formal`](./reports/2026-07-27-pilot-formal-go-no-go.md) · [`RC3 formal`](./reports/2026-07-27-private-v1-rc3-formal-go-no-go.md) |
| webch 预发布 | [`2026-07-28 conditional GO`](./reports/2026-07-28-webch-aliyun-pilot-go-no-go.md) · [`2026-07-29 baseline`](./reports/2026-07-29-webch-preproduction-baseline.md) |

历史报告不因后续修复而回写。需要判断当前状态时，回到
[`../STATUS.md`](../STATUS.md) 和最新目标环境报告。

## 宣称 production-ready 的条件

仅当 [`production-ready-checklist.md`](./production-ready-checklist.md) A–E 必选项全部勾选、
F 类非阻断项已写入已知限制，且 [`pilot-go-no-go-template.md`](./pilot-go-no-go-template.md)
记录明确 **GO** 时，才可针对该版本与部署环境写 production-ready。代码与验收包到位
**不等于** 已获 go。
