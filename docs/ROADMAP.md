# UnoRAG 路线图

> 状态：现行（2026-07-30）
>
> 产品定位、目标客户与商业方向见 [PRODUCT.md](./PRODUCT.md)。
> 已完成的 Document Lifecycle L0–L8 工程细节以代码与 runbook 为准；旧「私有化落地计划」长文已退役，剩余缺口收敛到本文。

## 当前基线（已落地）

| 领域 | 状态 |
|------|------|
| Control Plane（Next.js） | 身份、工作区创建/切换、文库、原生文档 API、Job、Outbox、邀请 |
| Data Plane（FastAPI） | Ask 图、检索、拒答/裁决、archive/threads、内部 HMAC |
| 入库 | Next → `app.jobs` → lifecycle_worker；FastAPI `/v1/ingest*` **永久 410** |
| 解析 | DocumentIR / TableIR / PyMuPDF + 可选 MinerU；策略化切分（ADR-0001–0003） |
| 检索门禁 | active generation + tenant/workspace/ACL |
| 会话 | 默认临时；主动归档；thread 续聊 + rewrite |
| Ask 旋钮 | 工作区设置 ⊕ `ask_defaults.py`（不读 `HYBRID_ENABLED` 等产品 env） |
| 私有化 | Compose 参考拓扑 + Helm 骨架；webch 已以纯 UnoRAG 全新重置并通过预发布纵向冒烟，客户生产仍按部署验收 |
| 质量门禁 | CI fuse / release gates（见 `docs/runbooks/quality-release-gates.md`） |

## 开始前先决条件（团队 checklist）

在开新功能或接客户试点前，先完成下列事项。细节见 [DEV.md](./DEV.md) 与 [INTEGRATION.md](./INTEGRATION.md)。

### 工程环境

- [ ] 本机或 Compose：Postgres + Qdrant + Redis
- [ ] `apps/web`：`pnpm db:migrate` + `pnpm db:bootstrap`
- [ ] `apps/api`：`DATABASE_URL`、`METADATA_BACKEND=postgres`、模型 key（live）或 stub
- [ ] 跑 lifecycle worker（产品上传依赖）与 outbox worker（文库投影）
- [ ] `DOCUMENT_STORAGE_ROOT` 在 web 与 worker 间共享（生产必填）
- [ ] 应用 `rag` schema：`uv run python scripts/apply_rag_migrations.py`

### 鉴权边界（多用户必做）

- [ ] `UNORAG_INTERNAL_SECRET` === `INTERNAL_AUTH_SECRET`（≥32 字符）
- [ ] `UNORAG_SESSION_SECRET` 独立且 ≠ internal secret
- [ ] `INTERNAL_AUTH_ENABLED=true`（否则全员 `principal=development`，档案串台）
- [ ] 生产：`APP_ENV=production` + Redis replay；**禁止**公网暴露 `:8000`

### 契约意识

- [ ] 浏览器只打 Next：`/api/*` 与 `/api/rag/*`
- [ ] 产品入库只走控制面文档 API；不要复活 FastAPI ingest
- [ ] 产品旋钮改工作区 / `ask_defaults.py`，不要加回已废弃 env 开关
- [ ] Knowledge API 未稳定前，不要让 SDK/MCP/OpenAI adapter 各自形成第二套契约

### 质量与交付

- [ ] 改检索/切分/ask 路径前跑相关 pytest + 关注 release gate fuse
- [ ] 客户试点走 `docs/acceptance/` 模板，不以「功能列表」代替 go/no-go

---

## 执行原则

路线图服务于一个核心产品：**UnoRAG Knowledge Service**。

**当前阶段（私有化稳固）明确优先级：**

```text
私有化部署做稳、做熟
  → Ask/Retrieve 质量可证明（消融 + 领域断言 + release gate）
  → 再谈协议扩展（SDK/MCP/OpenAI 已有薄适配，暂缓加深）
```

在私有化版本未达到「稳定可交付」前，不主动开新的产品面扩展。已落地的 SDK/MCP 维持维护模式。

通用优先级仍是：

```text
生产可信度
  → 稳定 Knowledge API
  → 薄适配层维护
  → Connector 与能力加深
```

Workspace 继续作为官方客户端和管理控制台，但不得让纯 UI 功能挤占隔离、一致性、API 契约、可观测和交付工作。所有 SDK/协议适配必须调用同一 HTTP API，不产生第二套权限、版本、索引或检索真相。

## 近 / 中 / 远期

时间盒按「受控私有化试点 Conditional GO → Knowledge API 可稳定嵌入 → 协议与场景扩展」排列，不按虚构日期硬锁。

### P0 / 近期：受控生产试点与 Conditional GO

目标：在明确客户、部署边界和运维责任的前提下，让核心路径全绿、真实试点可签字。Conditional GO 只代表受控私有化试点可进入生产使用，不等同于通用生产 GA。

| 项 | 面向 | 说明 |
|----|------|------|
| 全量 CI 基线 | 工程 | API pytest、Web test、TypeScript、production build、lint 与 deterministic eval gate 全部进入流水线；修复默认临时会话后的过时持久化测试 |
| 可执行 lint 基线 | 工程 | 排除生成型 Drizzle snapshots 等不应格式化内容，清理真实 a11y/import 诊断 |
| 隔离与版本门禁 | 内核 | 跨 organization/workspace/ACL 零泄漏；未激活 generation 不可召回；替换失败旧版继续服务 |
| 备份与恢复演练 | 运维 | 对目标部署执行独立 backup/restore，记录 RPO/RTO、负责人和失败处理路径 |
| 安全边界 | 运维 | 生产密钥、内部 HMAC、Redis replay、公网入口与最小权限配置通过检查 |
| 最低可运维观测 | 运行 | 关联 ID、结构化日志、健康指标和核心告警可用；保留业务 Trace Drawer。完整 OTel 覆盖和集中平台不阻塞 P0 |
| Usage 原始采集 | 运行 | 采集 Chat/Embedding token 与模型维度到 trace/usage ledger；成本核算和 Workspace 面板后置 |
| 控制面 E2E | 工程 | 覆盖上传→ready→ask→替换→ACL→删除 |
| 目标容量基线 | 交付 | 在目标规格记录并发、队列、模型/MinerU 限额和 P50/P95；形成扩容与限流建议 |
| 试点 go/no-go 签字 | 交付 | 根据目标环境完成隔离、故障注入、恢复与运维责任验收，形成书面 Conditional GO |

### P1 / 中期：稳定 Knowledge API

目标：客户业务系统能管理知识生命周期并稳定调用 Retrieve/Answer，不依赖 Workspace UI。

| 项 | 面向 | 说明 |
|----|------|------|
| Service Key + Retrieve/Ask v1.0 | API | **已冻结（含契约 hardening）**：`mk_svc_` + `/api/v1/retrieve|ask`；`docs/contracts/retrieve-ask-v1.md`；`api_version`；审计/usage/可选限流；OpenAPI + 契约测试 |
| Answer 契约与 Ask 兼容期 | API | 新产品术语采用 Answer；定义 `/answer`、`/answer/stream` 与 `/ask` 废弃周期 |
| 稳定 OpenAPI | API | **Retrieve/Ask v1.0 已落地**；后续资源逐项补入，不从路线图隐式承诺契约 |
| Documents / Versions / Jobs | API | 外部上传、替换、删除、状态查询复用 Control Plane 与 `app.jobs`；支持 idempotency key |
| Service Key scopes v2 | 安全 | `documents:read/write`、`retrieve`、`answer` 等最小权限 scope；集群级限流与更深审计 |
| OIDC Provider | 身份 | 接通至少一个真实企业 IdP，验证 callback、账号绑定、组织归属与退出 |
| S3/MinIO adapter | 存储 | 用受支持对象存储替代共享 PVC，保持 storage key、版本和 Worker 读取不变量 |
| Feedback / Trace API | 质量 | 集成方可回传反馈并按 trace_id 获取脱敏调试信息 |
| 对外流式 Answer | API | 事件名已在 v1 契约冻结；公开路径待 Answer 资源落地 |
| 表格 / 受限多步加强 | 内核 | 在现有 table path 上加深，不做开放工具生态 |
| 线上反馈 → eval case | 质量 | 形成反馈审核、回归用例与发布门禁闭环 |

### P2 / 中后期：开发者接入面

目标：在 P1 公共生命周期契约稳定后降低集成成本。开发者接入层的下一项是
OpenAI-compatible API，但它不应越过 Public Documents / Versions / Jobs。

| 项 | 说明 |
|----|------|
| Python SDK | **已交付 0.1.0**（[`sdk/python/`](../sdk/python/)）：同步 `retrieve`/`ask`、类型模型、稳定错误码；后续可加 async/SSE/重试 |
| MCP Server | **已交付 0.1.0**（[`sdk/mcp/`](../sdk/mcp/)）：stdio 工具 `retrieve`/`ask`（1:1 HTTP）；经 Python SDK，不嵌入引擎 |
| OpenAI-compatible adapter | **规划中**：兼容现有 client；citation/refusal/trace 放扩展字段，原生 API 仍权威 |
| TypeScript SDK | 在 Python SDK 和 OpenAPI 经真实集成验证后生成或实现 |
| Reference integrations | 客服/售后、企业 Agent、内部门户示例，而不只提供 curl |

### P3 / 远期：企业增强与场景能力加深

| 项 | 说明 |
|----|------|
| 多 IdP / SCIM 与组织同步 | 在首个 OIDC Provider 之上扩展目录同步和企业生命周期管理 |
| SBOM / 镜像签名 | Trivy 镜像扫描与 digest manifest 已交付；SBOM、Cosign 与 provenance 按客户合规要求进入具体交付 |
| Audit / Archive 深化 | actor/IP/UA、异步导出、更多 query/plan/judge/版本字段 |
| 成本分析面板 | 基于已采集 usage ledger 提供工作区、模型和时间维度分析 |
| Group ACL 管理 | 在现有 workspace / 指定成员 ACL 上补 group UI 和组织映射 |
| 独立引擎包（PyPI） | 默认不做；只有多客户明确需要嵌入式运行且能保持治理不变量时再评估 |
| Connector 增量同步 | 企业网盘/wiki；非上传替代而是补充 |
| DuckDB / 超大表执行 | 表格路径上限抬高 |
| 多粒度索引 | section/doc summary 等必须由评测证明收益 |
| 云 SaaS 计费与多 region | 私有化优先后再谈 |
| LlamaIndex 等检索实现 A/B | 必须服从 active generation + ACL，不得拥有 Job/权限事实 |

---

## 使用方式对照

| 维度 | 官方 Workspace | 客户系统嵌入 |
|------|-------------------|-------------------|
| UI | UnoRAG Northline 工作台 | 客户自有业务系统 / Chat / Agent |
| 身份 | Session + 工作区成员 | Service key（`mk_svc_`）；OAuth-for-apps 当前非目标 |
| 入库 | 控制面文库 UI + lifecycle | 目标为 Knowledge API Documents/Jobs；当前可复用 Workspace 入库 |
| 问答 | `/app/ask` → BFF → `/v1/ask` | `/api/v1/retrieve` · `/api/v1/ask`（Bearer）→ 内网 FastAPI |
| Agent 运行时 | 官方 Ask 图 | **不要求**使用我们的 Agent/工具生态 |
| 当前可用性 | **主路径可用** | **Retrieve/Ask v1.0 已冻结** + **Python SDK / MCP 0.1.0**；OpenAI-compatible 仍规划 |

两种方式共享一个 Knowledge Service，不是两套产品、两套索引或两套权限系统。

## 明确不做（路线图纪律）

与 [PRODUCT.md](./PRODUCT.md) 及 [STATUS.md](./STATUS.md) 一致，下列项不得挤占近期容量：

### 冻结（私有化上线 / 试点正式 GO 前）

私有化上线前**只做稳定性与 Step 1 收敛**；明确冻结：

- **不扩张**消融评测平台（`ask-ablation-eval` 保持实验，**不进** release gate）
- **不实现** OpenAI-compatible 层加深
- **不新增** Ask 图分支 / 平行 policy 引擎 / 新 Ask 产品能力面

### 长期不做 / 纪律

- 开放式通用 Agent 工具市场
- 公网裸 FastAPI
- 每轮强制归档 / 用户画像长期记忆
- 为「看起来像 SaaS 平台」而堆计费与多 region
- OAuth-for-apps；只有明确建设公网多租户开发者平台时才重新评估
