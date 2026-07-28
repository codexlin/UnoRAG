# UnoRAG 试点验收报告（go / no-go）

> 本机混合拓扑功能试点记录（非客户生产环境）。
> 依据模板：[`../pilot-go-no-go-template.md`](../pilot-go-no-go-template.md)。
> **不宣称 production-ready**（见 §10 与 [`../production-ready-checklist.md`](../production-ready-checklist.md)）。

## 元数据

| 字段 | 值 |
|---|---|
| 产品版本 / git commit | `9baeeac`（`main`） |
| 部署拓扑（Compose / Helm / 混合） | 混合：Next `:3000` + FastAPI `:8000` + Docker Postgres / Qdrant / Redis；lifecycle_worker + outbox worker |
| 环境标识（非生产试点 / 预发） | 本机开发 / 非生产试点 |
| 试点日期（起–止） | 2026-07-25（含 SKIP 补测轮） |
| 操作员 | Cursor agent + 仓库维护者 |
| 审批人 | （待签字） |
| 报告作者 | 工程侧自动验收整理 |

## 1. 试点范围（工作区与文件集）

| 工作区 | 用途 | 备注 |
|---|---|---|
| 默认 bootstrap 工作区 | 功能与集成验收 | `admin@example.com` / role=owner |
| 临时 viewer | F2 / S3 对照 | `pilot-viewer-*@example.com`（补测创建；**残留成员**，可手工移除） |
| WS-2 / Org-2 | 跨工作区 / 跨组织隔离 | **未建** → S1/S2 仍 SKIP（依赖 preflight 隔离单测） |

### 代表性文件登记

| # | 文件名（可脱敏） | 格式 | 大约大小 | 页数 | 表格比例 | 目标问题（1–3 条） |
|---|---|---|---|---|---|---|
| 1 | quote-big-80rows.docx | DOCX | 中 | — | 高 | 序号为1的设备名；那它的价格是多少 |
| 2 | 库内其余 ready 文档（含 crosstable 等） | 混合 | — | — | — | 主路径以 quote-big 为准 |
| 3 | `pilot-skip-fill-*.md`（补测临时文件） | MD | 小～中 | — | 无 | 上传/替换/ACL/删除；**测完已删除** |

库名：`人工测试ab`（`bb8ebb8c-…`），验收时已为 `ready`。

## 2. 功能与权限验收

| ID | 检查项 | 结果 | 证据 | 备注 |
|---|---|---|---|---|
| F1 | 登录与会话（admin） | **PASS** | `POST /api/auth/session` → 200，role=owner | 补测轮复验 |
| F2 | viewer 无法上传 / retry / delete | **PASS** | 邀请临时 viewer 后：upload/retry → **403** `library write permission required`；delete → **403** `library owner permission required`；Ask BFF → **200**（可读） | 账号 `pilot-viewer-*@example.com` |
| F3 | editor/owner 可上传，得到 `202 + job_id` | **PASS** | owner 上传 `pilot-skip-fill-upload.md` → **202**；`job_id=183adf5f-…`；`doc_id=e04e70ab-…` | |
| F4 | 上传后轮询至 ready | **PASS** | 同 job → `status=ready` / `job_status=completed`；lifecycle `activated=True`；Ask 召回 unique marker | ~数秒完成 |
| F5 | Ask 返回答案与 citation | **PASS** | 设备名 → 边缘计算网关；citation 含 quote-big + version | live（首轮+补测） |
| F5b | 多轮追问 | **PASS** | 「那它的价格是多少」→ 单价/合计正确 | 同 session（首轮） |
| F6 | 替换新版本期间旧答案可用 | **PASS** | 大文件 replace `job_id=7fcf0e6f-…` 处于 `processing/embedding` 时 Ask → **200**，仍答 **PilotEdgeGateway-Beta / 99,999 CNY**（旧 active） | 小文件 replace 过快；以慢替换窗口为准 |
| F7 | 失败替换 degraded | **PASS** | 慢替换取消后文档 `status=degraded`，`job_status=cancelled`；versions：v3 cancelled / **v2 active**；Ask 仍召回 Beta 旧价 | 非「坏文件解析失败」，但是失败/取消替换 + 旧 active 可用 |
| F8 | 删除后不可召回 | **PASS** | 删除 ACL 测文档 `doc_id=fcd2bf3e-…` → **202**；Ask 不再出现 `PILOT_ACL_ONLY_OWNER_…` 特有串 | 与 S5 同源证据 |
| F9 | 审计可查 | **PASS** | 设置页 Audit + `GET /api/workspace/audit` / CSV | owner/admin（首轮） |
| F10 | 文档 ACL「谁可见」入口 | **PASS** | `GET …/acl`；补测轮做了 restricted 对照（见 S3） | |
| F11 | Mode B service key ask/retrieve | **PASS** | 新建 key → `/api/v1/ask` **200**；吊销后 **401** `invalid or revoked service key`；key `b93bf5d7-…` 已吊销 | 补测轮复验 |

## 3. 隔离与安全（硬熔断）

| ID | 检查项 | 结果 | 证据 | 备注 |
|---|---|---|---|---|
| S1 | 跨 organization 零泄漏 | **SKIP** | 无第二组织 bootstrap | preflight 隔离单测 **2 passed**；CI gate 36/36 |
| S2 | 跨 workspace 零泄漏 | **SKIP** | 控制面无便捷「建第二工作区」API；本轮未建 WS-2 | 同上依赖单测 |
| S3 | 受限 ACL / group 不泄漏 | **PASS** | ACL → `restricted` 仅 owner + reindex；viewer Ask → **资料未覆盖**，`viewer_has_marker=False`；改回 `workspace` + reindex 后 viewer 可再召回 | 后已删除该测文档 |
| S4 | 未激活 generation 不可召回 | **PASS** | F7 versions：desired v3=`cancelled`/`is_active=false`；active 仍为 v2；Ask 内容对应 v2（Beta），非未完成的慢替换正文 | 与 F6/F7 同源 |
| S5 | 已删除文档不可召回 | **PASS** | 同 F8 | |
| S6 | 边缘不可裸打 FastAPI | **PASS（本机）** | 裸 `POST :8000/v1/ask` → **401** `internal request context required`；BFF `/api/rag/v1/ask` → **200** | 生产仍须禁止暴露 `:8000` |
| S7 | `pilot-preflight.sh` 通过 | **PASS** | `gate_ok=True`，36/36；报告 `/tmp/unorag-pilot-preflight-gate.json` | 补测轮重跑 |

**说明：** 按模板「任一 S* FAIL → NO-GO」。本报告 S* **无 FAIL**；S1/S2 仍为 **SKIP**（无双租户/双工作区真人演练）→ 仍为 **条件 GO**，不能勾满 production-ready。

## 4. 可靠性与故障演练

| ID | 演练 | 结果 | 观察 | 备注 |
|---|---|---|---|---|
| R1 | worker drain / 停 worker | **SKIP** | 未演练停 worker | 正式试点前建议补 |
| R2 | 短暂停止 Qdrant | **SKIP** | 未对主库做宕机注入 | 避免影响本机主库 |
| R3 | 模型不可用 | **SKIP** | 未演练 | |
| R4 | MinerU 不可用 | **SKIP** | 未演练；inspect 中可见历史 `mineru_unreachable` dead jobs | 非本轮注入 |
| R5 | `pnpm lifecycle:inspect` | **PASS** | 跑通；`stuck_jobs=[]`；历史 `dead_jobs=4`（含 `mineru_unreachable`） | 需 `DATABASE_URL`（来自 `apps/web/.env.local`） |

## 5. 备份 / 升级 / 容量

| ID | 检查项 | 结果 | 备注 |
|---|---|---|---|
| B1 | 备份产物可生成 | **PASS（部分）** | 混合拓扑下：`docker exec unorag-postgres-1 pg_dump` → `/tmp/unorag-pilot-backup-*/postgres.sql`（~9.2MB）；本地 `documents-local.tgz`；Qdrant volume `qdrant.tgz`。完整 `backup.sh` 依赖 compose `web` 服务插值，本机未跑通 |
| B2 | restore | **SKIP** | 无独立体积；避免冲主库 | 见 `backup-restore-verification.md` |
| B3–B5 | upgrade / rollback / 告警 | **SKIP** | 未演练 | 正式发布前必做 |

## 6. SLO（首版可测量行为）

| SLO | 目标 | 实测 | PASS? |
|---|---|---|---|
| 跨租户数据泄漏 | 0 | 无双 org 真人测；preflight 隔离单测通过 | SKIP（单测 PASS） |
| 已确认成功的写入可追踪 | 100% | 上传→ready→Ask 召回 marker；job_id 可查 | **PASS** |
| 失败任务可定位 | 100% | degraded + cancelled job/version；lifecycle inspect 可见 dead/stuck | **PASS** |
| 替换失败时旧 active 可用 | 是 | F6/F7 已证 | **PASS** |
| dead/stuck/orphan 可巡检 | 是 | `lifecycle:inspect` 已跑 | **PASS** |

## 7. 缺陷清单

| 级别 | ID | 摘要 | 是否阻断 go |
|---|---|---|---|
| P2 | PILOT-1 | S1/S2 真人双租户/双工作区、R1–R4 故障注入、B2 restore 仍 SKIP | 否（条件 GO 须补方可正式 GO） |
| P2 | PILOT-2 | Audit actor 对 worker 写入可能为空（已知展示限制） | 否 |
| P3 | PILOT-3 | `pilot-smoke.sh` 在密码等于占位串 `change-this-before-deployment` 时硬 SKIP（即使用该串可登录） | 否 |
| P3 | PILOT-4 | 补测残留临时 viewer 成员 `pilot-viewer-*@example.com` | 否（可删） |
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
| CI gate 报告 | `/tmp/unorag-pilot-preflight-gate.json`（本机） | `9baeeac` |
| `pilot-preflight.sh` | 2026-07-25 补测重跑 **PASS**（36/36） | 同上 |
| `pilot-smoke.sh` | **SKIP**：脚本因 admin 密码=占位串硬退出；Compose 全栈未作为 edge；等价主路径已由 F3–F8/S3/S6 覆盖 | — |
| `lifecycle:inspect` | 本机已跑；`stuck_jobs=0`，历史 dead=4 | 同上 |
| 备份探针 | `/tmp/unorag-pilot-backup-*`（pg_dump + docs + qdrant；非 restore） | 同上 |

## 10. 结论

- [ ] **GO** — 可标记该版本为试点通过，进入正式发布流程
- [x] **条件 GO** — 功能主路径、权限、ACL、替换/删除、质量门禁可通过；**不得**宣称 production-ready
- [ ] **NO-GO**

**决策人签字 / 日期：** __________________ / __________

**一句话理由：**
补测轮已把 F2–F4/F6–F8、S3–S7、F11、R5 与部分 B1 从 SKIP 推进为 PASS；跨组织/第二工作区真人隔离、故障注入与 restore 仍 SKIP，故维持 **条件 GO**（较首轮证据更完整，仍非正式 GO）。

### 条件 GO 生效前提（须保持）

1. `INTERNAL_AUTH_ENABLED=true`，api/web internal secret 对齐（≥32）
2. lifecycle_worker + outbox worker 运行中
3. 不对公网暴露 FastAPI `:8000`
4. 补齐 S1/S2 真人隔离、R1–R4 故障演练、B2 restore 后再谈正式 GO 与 production-ready

### 建议的下一动作（非本报告阻断）

1. 手工清理临时 viewer `pilot-viewer-*@example.com`（或改密/禁用）
2. 独立体积跑 `backup.sh` + `restore.sh` 一轮
3. 建第二 org/workspace 做 S1/S2 零泄漏真人测
4. 审批人在上方签字确认「条件 GO」或改为 NO-GO
