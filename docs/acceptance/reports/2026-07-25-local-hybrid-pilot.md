# MeriKnow 试点验收报告（go / no-go）

> 本机混合拓扑功能试点记录（非客户生产环境）。  
> 依据模板：[`../pilot-go-no-go-template.md`](../pilot-go-no-go-template.md)。  
> **不宣称 production-ready**（见 §10 与 [`../production-ready-checklist.md`](../production-ready-checklist.md)）。

## 元数据

| 字段 | 值 |
|---|---|
| 产品版本 / git commit | `f796258`（`main`，含 dual-mode / audit / ACL / service keys / CI gate stub fix） |
| 部署拓扑（Compose / Helm / 混合） | 混合：Next `:3000` + FastAPI `:8000` + Docker Postgres / Qdrant / Redis |
| 环境标识（非生产试点 / 预发） | 本机开发 / 非生产试点 |
| 试点日期（起–止） | 2026-07-25 |
| 操作员 | Cursor agent + 仓库维护者 |
| 审批人 | （待签字） |
| 报告作者 | 工程侧自动验收整理 |

## 1. 试点范围（工作区与文件集）

| 工作区 | 用途 | 备注 |
|---|---|---|
| 默认 bootstrap 工作区 | 功能与集成验收 | `admin@example.com` / role=owner |
| WS-2 | 跨工作区隔离 | **未建** → S2 SKIP |

### 代表性文件登记

| # | 文件名（可脱敏） | 格式 | 大约大小 | 页数 | 表格比例 | 目标问题（1–3 条） |
|---|---|---|---|---|---|---|
| 1 | quote-big-80rows.docx | DOCX | 中 | — | 高 | 序号为1的设备名；那它的价格是多少 |
| 2 | 库内其余 ready 文档（含 crosstable 等） | 混合 | — | — | — | 主路径以 quote-big 为准 |

库名：`人工测试ab`（`bb8ebb8c-…`），验收时已为 `ready`。

## 2. 功能与权限验收

| ID | 检查项 | 结果 | 证据 | 备注 |
|---|---|---|---|---|
| F1 | 登录与会话（admin） | **PASS** | `POST /api/auth/session` → 200，role=owner | |
| F2 | viewer 无法上传 / retry / delete | **SKIP** | 未建 viewer 账号演练 | 代码与权限门已有；需补一轮真人角色测 |
| F3 | editor 可上传，得到 `202 + job_id` | **SKIP** | 本轮未新上传 | worker 已拉起，待补演练 |
| F4 | 上传后轮询至 ready | **SKIP** | 同上 | 既有 ready 库可问 |
| F5 | Ask 返回答案与 citation | **PASS** | 设备名 → 边缘计算网关；citation 含 quote-big + version | live |
| F5b | 多轮追问 | **PASS** | 「那它的价格是多少」→ 单价/合计正确 | 同 session |
| F6 | 替换新版本期间旧答案可用 | **SKIP** | 未演练 | |
| F7 | 失败替换 degraded | **SKIP** | 未演练 | |
| F8 | 删除后不可召回 | **SKIP** | 未演练 | |
| F9 | 审计可查 | **PASS** | 设置页 Audit + `GET /api/workspace/audit` / CSV | owner/admin |
| F10 | 文档 ACL「谁可见」入口 | **PASS** | `GET …/acl` scope=workspace；UI 入口存在 | 未改生产 ACL 数据 |
| F11 | Mode B service key ask/retrieve | **PASS** | Bearer `mk_svc_…` → ask 200 / retrieve 200；吊销后 401 | 测试 key 已吊销 |

## 3. 隔离与安全（硬熔断）

| ID | 检查项 | 结果 | 证据 | 备注 |
|---|---|---|---|---|
| S1 | 跨 organization 零泄漏 | **SKIP** | 无第二组织 | 隔离单测在 preflight 覆盖一部分 |
| S2 | 跨 workspace 零泄漏 | **SKIP** | 无第二工作区 | |
| S3 | 受限 ACL / group 不泄漏 | **SKIP** | 仅验证入口，未做拒召回对照 | |
| S4 | 未激活 generation 不可召回 | **SKIP** | 本轮未专门演练 | |
| S5 | 已删除文档不可召回 | **SKIP** | 未演练删除 | |
| S6 | 边缘不可裸打 FastAPI | **PASS（本机）** | 开启 `INTERNAL_AUTH` 后裸 `POST :8000/v1/ask` → **401**；BFF ask → 200 | 生产仍须禁止暴露 `:8000` |
| S7 | `pilot-preflight.sh` 通过 | **PASS** | `gate_ok=True`，36/36；报告 `/tmp/meriknow-pilot-preflight-gate.json` | commit `7c3f501` 起 |

**说明：** 按模板「任一 S* FAIL → NO-GO」。本报告 S* **无 FAIL**，但多项 **SKIP** → 只能 **条件 GO**，不能勾满 production-ready。

## 4. 可靠性与故障演练

| ID | 演练 | 结果 | 观察 | 备注 |
|---|---|---|---|---|
| R1–R5 | worker drain / Qdrant 宕机 / 模型不可用 / MinerU / inspect | **SKIP** | 本轮未做故障演练 | 正式试点前必补 |

## 5. 备份 / 升级 / 容量

| ID | 检查项 | 结果 | 备注 |
|---|---|---|---|
| B1–B5 | backup/restore/upgrade/rollback/告警 | **SKIP** | 见 `backup-restore-verification.md`；正式发布前必做 |

## 6. SLO（首版可测量行为）

| SLO | 目标 | 实测 | PASS? |
|---|---|---|---|
| 跨租户数据泄漏 | 0 | 未做双租户实测 | SKIP |
| 已确认成功的写入可追踪 | 100% | 既有 ready 文档可问；新上传未本轮验证 | 部分 |
| 失败任务可定位 | 100% | 未演练失败任务 | SKIP |
| 替换失败时旧 active 可用 | 是 | 未演练 | SKIP |
| dead/stuck/orphan 可巡检 | 是 | 未跑 `lifecycle:inspect` | SKIP |

## 7. 缺陷清单

| 级别 | ID | 摘要 | 是否阻断 go |
|---|---|---|---|
| P2 | PILOT-1 | viewer/上传/替换/删除/故障/备份等多项 SKIP，非功能红灯 | 否（条件 GO 须补） |
| P2 | PILOT-2 | Audit actor 对 worker 写入可能为空（已知展示限制） | 否 |
| — | — | 无已知 P0/P1 阻断本轮功能主路径 | — |

## 8. 支持边界与已知限制

- 模式 A：完整助手（会话临时/归档、工作区设置、成员邀请、Audit、文档 ACL）  
- 模式 B：`/api/v1/retrieve` + `/api/v1/ask` + service key（无 MCP / 无对外流式 ask）  
- Ask 产品旋钮：工作区设置 ⊕ 代码默认；不再读 `HYBRID_ENABLED` 等  
- 入库：仅控制面 + lifecycle_worker；FastAPI ingest **410**  
- 本机须：`INTERNAL_AUTH_ENABLED=true` 且与 web secret 对齐；lifecycle + outbox 常开  
- SBOM / CVE 扫描、Helm NetworkPolicy、OIDC：仍后置  

## 9. 质量门禁附件

| 附件 | 路径或链接 | commit |
|---|---|---|
| CI gate 报告 | `/tmp/meriknow-pilot-preflight-gate.json`（本机） | `f796258` / gate 修复 `7c3f501` |
| `pilot-preflight.sh` | 2026-07-25 重跑 **PASS** | 同上 |
| `pilot-smoke.sh` | **未跑**（Compose 全栈冒烟） | — |

## 10. 结论

- [ ] **GO** — 可标记该版本为试点通过，进入正式发布流程  
- [x] **条件 GO** — 功能主路径与质量门禁可通过；**不得**宣称 production-ready  
- [ ] **NO-GO**

**决策人签字 / 日期：** __________________ / __________

**一句话理由：**  
本机混合环境下，登录→有据问答→追问→归档→Audit/ACL 入口→Mode B service key 与 `pilot-preflight` 均已验证通过；跨租户隔离、上传全链路、故障与备份演练仍为 SKIP，故仅条件 GO。

### 条件 GO 生效前提（须保持）

1. `INTERNAL_AUTH_ENABLED=true`，api/web internal secret 对齐（≥32）  
2. lifecycle_worker + outbox worker 运行中  
3. 不对公网暴露 FastAPI `:8000`  
4. 补齐 F2–F4 / F6–F8 / S1–S5 / R* / B* 后再谈正式 GO 与 production-ready  

### 建议的下一动作（非本报告阻断）

1. 人工补：viewer 权限、一次真实上传→ready、ACL 拒召回对照  
2. 跑 `pilot-smoke.sh`（Compose）与 backup/restore 各一轮  
3. 审批人在上方签字确认「条件 GO」或改为 NO-GO  
