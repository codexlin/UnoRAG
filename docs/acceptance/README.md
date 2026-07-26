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
| [`../../deploy/compose/scripts/pilot-smoke.sh`](../../deploy/compose/scripts/pilot-smoke.sh) | Compose 栈上的控制面冒烟：login → upload → ask → replace → delete |
| [`../../deploy/compose/scripts/pilot-preflight.sh`](../../deploy/compose/scripts/pilot-preflight.sh) | 离线隔离单测 + CI 质量门禁（无 Compose 也可跑） |
| [`../../scripts/acceptance/s1_s2_isolation.sh`](../../scripts/acceptance/s1_s2_isolation.sh) | **S1/S2** 多组织/多工作区可重复隔离验收（Retrieve+Ask+IDOR+restricted ACL） |
| [`../../scripts/acceptance/README.md`](../../scripts/acceptance/README.md) | S1/S2 如何跑、依赖、退出码 |

退出码约定（上述脚本一致）：

- `0` — 通过  
- `1` — 失败（阻断 go）  
- `2` — 跳过 / BLOCKED（服务/密钥/依赖不可用；不算通过，也不算产品缺陷）

## 宣称 production-ready 的条件

仅当 [`production-ready-checklist.md`](./production-ready-checklist.md) A–E 必选项全部勾选、
F 类非阻断项已写入已知限制，且 [`pilot-go-no-go-template.md`](./pilot-go-no-go-template.md)
记录明确 **GO** 时，才可针对该版本与部署环境写 production-ready。代码与验收包到位
**不等于** 已获 go。
