# MeriKnow 路线图

> 状态：现行（2026-07-25）  
> 产品定位见 [PRODUCT.md](./PRODUCT.md)。  
> 已完成的 Document Lifecycle L0–L8 工程细节以代码与 runbook 为准；旧「私有化落地计划」长文已退役，剩余缺口收敛到本文。

## 当前基线（已落地）

| 领域 | 状态 |
|------|------|
| Control Plane（Next.js） | 身份、工作区、文库、原生文档 API、Job、Outbox、邀请 |
| Data Plane（FastAPI） | Ask 图、检索、拒答/裁决、archive/threads、内部 HMAC |
| 入库 | Next → `app.jobs` → lifecycle_worker；FastAPI `/v1/ingest*` **永久 410** |
| 解析 | DocumentIR / TableIR / PyMuPDF + 可选 MinerU；策略化切分（ADR-0001–0003） |
| 检索门禁 | active generation + tenant/workspace/ACL |
| 会话 | 默认临时；主动归档；thread 续聊 + rewrite |
| Ask 旋钮 | 工作区设置 ⊕ `ask_defaults.py`（不读 `HYBRID_ENABLED` 等产品 env） |
| 私有化 | Compose 参考拓扑 + Helm 骨架；验收包在 `docs/acceptance/` |
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

- [ ] `MERIKNOW_INTERNAL_SECRET` === `INTERNAL_AUTH_SECRET`（≥32 字符）
- [ ] `MERIKNOW_SESSION_SECRET` 独立且 ≠ internal secret
- [ ] `INTERNAL_AUTH_ENABLED=true`（否则全员 `principal=development`，档案串台）
- [ ] 生产：`APP_ENV=production` + Redis replay；**禁止**公网暴露 `:8000`

### 契约意识

- [ ] 浏览器只打 Next：`/api/*` 与 `/api/rag/*`
- [ ] 产品入库只走控制面文档 API；不要复活 FastAPI ingest
- [ ] 产品旋钮改工作区 / `ask_defaults.py`，不要加回已废弃 env 开关
- [ ] 模式 B 对外契约未稳定前，不要向客户承诺「独立 PyPI / 公网 MCP」

### 质量与交付

- [ ] 改检索/切分/ask 路径前跑相关 pytest + 关注 release gate fuse
- [ ] 客户试点走 `docs/acceptance/` 模板，不以「功能列表」代替 go/no-go

---

## 近 / 中 / 远期

时间盒按「私有化可试点 → 模式 B 可嵌入 → 能力加深」排列，不按虚构日期硬锁。

### 近期（北极星巩固）

目标：模式 A 体验与工程合同一致；试点可签字。

| 项 | 模式 | 说明 |
|----|------|------|
| 试点 go/no-go 签字 | A | 验收包已就绪；缺真实环境演练与书面 GO（见 `docs/acceptance/`） |
| Audit 页面或导出 | A | 设置页审计列表 + CSV 已落地（owner/admin）；后续硬化：actor/IP/UA 更完整、动作 i18n、异步大批量导出 |
| Archive 字段硬化 | A | query type / plan / judge / 版本信息在档案侧更完整可观测 |
| 文档 ACL 产品编辑 | A | 已落地：文库文档「谁可见」（workspace / 指定成员）；`app.document_acl` + 就绪文档保存后重索引投影；Ask 仍走 active generation + ACL。后续：轻量 set_payload 投影、group UI |
| OIDC SSO | A | 本地密码 + 邀请已可用；企业 IdP 后置但需求强 |
| SBOM / 镜像扫描流水线 | 运维 | Compose 已 pin tag；完整扫描后置 |
| 控制面 E2E 补齐 | 工程 | 逐步替换遗留 FastAPI ingest 形状的测试依赖 |

### 中期（模式 B + 受限加强）

目标：已有助手可「只接 RAG」；表格等多步路径更稳。

| 项 | 模式 | 说明 |
|----|------|------|
| Service key + 外部 retrieve/ask 契约 | B | 见 [INTEGRATION.md](./INTEGRATION.md)；与内部 HMAC 分离 |
| 稳定 OpenAPI / 错误码 / 引用 schema 版本化 | B | 客户集成合同 |
| MCP 适配（后置） | B | 在 HTTP 契约稳定后薄封装，不先做工具市场 |
| 表格 / 受限多步加强 | A+B | 在现有 table path 上加深，不做开放工具生态 |
| 多粒度索引（section/doc summary） | A+B | 评测证明收益后再开 |
| 线上反馈 → eval case 闭环产品化 | A | L7 流程已有骨架 |

### 远期（可选加深，不挡首版）

| 项 | 说明 |
|----|------|
| 独立引擎包（PyPI） | 仅当模式 B 契约被多客户验证后 |
| Connector 增量同步 | 企业网盘/wiki；非上传替代而是补充 |
| DuckDB / 超大表执行 | 表格路径上限抬高 |
| 云 SaaS 计费与多 region | 私有化优先后再谈 |
| LlamaIndex 等检索实现 A/B | 必须服从 active generation + ACL，不得拥有 Job/权限事实 |

---

## 模式 A / B 对照

| 维度 | 模式 A（完整助手） | 模式 B（RAG 嵌入） |
|------|-------------------|-------------------|
| UI | MeriKnow Northline 工作台 | 客户自有 Chat/Agent UI |
| 身份 | Session + 工作区成员 | Service key / 未来 OAuth-for-apps（规划） |
| 入库 | 控制面文库 UI + lifecycle | 可复用同一入库，或客户只读已有库（规划） |
| 问答 | `/app/ask` → BFF → `/v1/ask` | 直连（内网）或网关后的 retrieve/ask |
| Agent 运行时 | 我们的 Ask 图即可 | **不要求**使用我们的 Agent/工具生态 |
| 当前可用性 | **主路径可用** | **内部能力可用，对外契约规划中** |

## 明确不做（路线图纪律）

与 [PRODUCT.md](./PRODUCT.md) 一致，下列项不得挤占近期容量：

- 开放式通用 Agent 工具市场
- 公网裸 FastAPI
- 每轮强制归档 / 用户画像长期记忆
- 为「看起来像 SaaS 平台」而堆计费与多 region

## 已退役文档

| 原文档 | 处理 |
|--------|------|
| `docs/plans/2026-07-24-private-deployment-production-roadmap.md` | 已删；完成项以代码/runbook 为准，缺口并入本文 |
| `docs/architecture/enterprise-rag-saas-design.md` | 已删；现行架构见 [ARCHITECTURE.md](./ARCHITECTURE.md) |
