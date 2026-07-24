# MeriKnow 试点验收报告（go / no-go）

> 复制本模板为版本化文件，例如  
> `docs/acceptance/reports/YYYY-MM-DD-<customer-or-env>-pilot.md`  
> **禁止**在仓库中提交真实客户敏感内容；客户侧报告可外置保管。

## 元数据

| 字段 | 值 |
|---|---|
| 产品版本 / git commit | |
| 部署拓扑（Compose / Helm / 混合） | |
| 环境标识（非生产试点 / 预发） | |
| 试点日期（起–止） | |
| 操作员 | |
| 审批人 | |
| 报告作者 | |

## 1. 试点范围（工作区与文件集）

> 不要编造客户数据。使用真实试点工作区，或客户书面同意的脱敏集。

| 工作区 | 用途 | 备注 |
|---|---|---|
| WS-1 | | |
| WS-2（可选） | 跨工作区隔离 | |

### 代表性文件登记

| # | 文件名（可脱敏） | 格式 | 大约大小 | 页数 | 表格比例 | 目标问题（1–3 条） |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |

## 2. 功能与权限验收

| ID | 检查项 | 结果 (PASS/FAIL/SKIP) | 证据（截图/日志/job_id） | 备注 |
|---|---|---|---|---|
| F1 | 登录与会话（admin） | | | |
| F2 | viewer 无法上传 / retry / delete | | | |
| F3 | editor 可上传，得到 `202 + job_id` | | | |
| F4 | 上传后轮询至 `ready` / job `completed`，stage/error 可定位 | | | |
| F5 | Ask 返回答案与 citation（含真实 document_version_id） | | | |
| F6 | 替换新版本：处理期间旧答案仍可用 | | | |
| F7 | 故意失败的替换：document `degraded`，旧 active 可继续 Ask | | | |
| F8 | 删除：tombstone → cleanup → Ask 不再召回 | | | |
| F9 | 审计：关键动作在 `app.audit_logs` 或运维导出中可查 | | | |

## 3. 隔离与安全（硬熔断）

| ID | 检查项 | 结果 | 证据 | 备注 |
|---|---|---|---|---|
| S1 | 跨 organization 零泄漏 | | | 见 runbook §隔离 |
| S2 | 跨 workspace 零泄漏 | | | |
| S3 | 受限 ACL / group 不泄漏 | | | |
| S4 | 未激活 generation 不可召回 | | | |
| S5 | 已删除文档不可召回 | | | |
| S6 | 浏览器不可直连 FastAPI 写接口（边缘只暴露 web） | | | |
| S7 | `pilot-preflight.sh`（隔离单测 + CI gate）通过 | | | 或记录 SKIP 原因 |

任一 S* 为 FAIL → **强制 NO-GO**。

## 4. 可靠性与故障演练

| ID | 演练 | 结果 | 观察 | 备注 |
|---|---|---|---|---|
| R1 | lifecycle-worker SIGTERM drain 后可恢复 claim | | | |
| R2 | 短暂停止 Qdrant：health degraded；恢复后 Ask/ingest 正常 | | | |
| R3 | 模型 endpoint 不可用：Ask 失败可定位，不破坏 active version | | | |
| R4 | MinerU/解析超时或 429：job retry/dead 可定位 | | | 无 MinerU 可 SKIP |
| R5 | `pnpm lifecycle:inspect` 无不可解释的 dead/stuck/orphan 堆积 | | | |

## 5. 备份 / 升级 / 容量

| ID | 检查项 | 结果 | 证据 | 备注 |
|---|---|---|---|---|
| B1 | `backup.sh` 产出完整 MANIFEST | | | 见 backup-restore-verification |
| B2 | `restore.sh` 后 active / ACL / citation / 对象一致 | | | |
| B3 | 升级演练（`upgrade.sh` 或镜像滚动）后冒烟通过 | | | |
| B4 | 回滚演练（或书面回滚计划已确认） | | | |
| B5 | 容量/磁盘/队列告警已接通或书面接受风险 | | | |

## 6. SLO（首版可测量行为）

| SLO | 目标 | 实测 | PASS? |
|---|---|---|---|
| 跨租户数据泄漏 | 0 | | |
| 已确认成功的写入不静默丢失 | 100% 可追踪到 document/version/job | | |
| 失败任务可定位到 stage/error_code | 100% | | |
| 替换失败时旧 active 保持可用 | 是 | | |
| dead/stuck/orphan 进入监控或运维队列 | 是 | | |

## 7. 缺陷清单

| 级别 | ID | 摘要 | 负责人 | 计划 | 是否阻断 go |
|---|---|---|---|---|---|
| P0 | | | | | 是 → NO-GO |
| P1 | | | | | 是 → NO-GO |
| P2 | | | | | 否（需负责人+计划） |

## 8. 支持边界与已知限制（随版本固化）

填写或粘贴发布说明中的边界，至少覆盖：

- 支持的文件格式与大小/页数上限  
- 模型 / embedding / MinerU 客户自备 endpoint  
- 审计 UI/CSV 导出是否仍后置  
- SBOM / 镜像 CVE 扫描是否仍后置  
- Helm HPA / NetworkPolicy 硬化是否仍后置  

## 9. 质量门禁附件

| 附件 | 路径或链接 | commit |
|---|---|---|
| CI gate 报告 | | |
| Release gate 报告（若跑） | | |
| `pilot-smoke.sh` 日志 | | |

## 10. 结论

- [ ] **GO** — 可标记该版本为试点通过，进入正式发布流程  
- [ ] **NO-GO** — 不可宣称 production-ready；列出阻断项  

**决策人签字 / 日期：**

**一句话理由：**

---

### 快速判定规则

1. 任一安全硬熔断（§3）失败 → NO-GO  
2. 任一 P0/P1 未清零 → NO-GO  
3. 备份恢复或关键一致性演练失败 → NO-GO  
4. 仅有 SKIP（无密钥/无 GPU/无第二租户）且书面接受风险 → 可条件 GO，但不得隐瞒  
5. 代码仓 L9 验收包齐全 **不能** 代替本报告的 GO 勾选  
