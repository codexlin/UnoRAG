# MeriKnow 架构（与代码一致）

> 状态：现行（2026-07-26）
>
> 决策记录：[ADR-0004](./adr/0004-nextjs-control-plane.md) · 解析/切分：[ADR-0001](./adr/0001-ocr-vlm-adapters.md)–[0003](./adr/0003-policy-driven-chunking.md)

## 产品与技术分层

MeriKnow 在部署上是独立知识服务，在使用上可嵌入客户业务：

```text
Official Workspace     Customer Apps / Agents
        │                 │       │       │
        │              Python SDK MCP  OpenAI adapter
        │                 └───────┼───────┘
        └─────────────────────────▼
                    Knowledge API
          Documents / Jobs / Retrieve / Answer
                              │
                              ▼
                Enterprise Knowledge Kernel
        ACL / Version / Parse / Index / Citation / Eval
```

架构约束：

1. Workspace 是官方客户端和管理控制台，不是唯一消费方。
2. HTTP Knowledge API 是权威运行时契约。
3. SDK、MCP、OpenAI-compatible endpoint 只做协议适配，不拥有第二套检索实现。
4. 所有入口共享 tenant/workspace/ACL、active generation、citation、refusal 与 trace 语义。

## 总览

```text
Browser
  └─ Next.js Control Plane  (apps/web)
       ├─ Session / 成员 / 文库 / 文档 Job / 工作区设置
       ├─ 原生文档 API → 对象存储 + app.jobs
       └─ BFF /api/rag/*  ──HMAC RequestContext──►  FastAPI Data Plane (apps/api)
                                                      ├─ Ask LangGraph
                                                      ├─ Retrieval / Qdrant
                                                      └─ Archive / Threads（Postgres）

Python lifecycle_worker  ──SKIP LOCKED──►  app.jobs (document.ingest / delete)
       └─ parse → chunk → embed → staging generation → 激活事务 → 延迟清理

Outbox worker (web)  ──service HMAC──►  FastAPI /v1/internal/projections/*
```

| 平面 | 职责 | 不负责 |
|------|------|--------|
| **Control Plane** | 身份、工作区、ACL 语义、文库/文档产品元数据、Job 可见性、审计写入、浏览器 BFF | 重解析、embedding、向量检索执行 |
| **Data Plane** | DocumentIR、切分、索引、Ask 图、检索门禁、turns/threads 存储、投影消费 | 浏览器会话、成员邀请、产品路由 UI |

生产拓扑：**web + rag-api + lifecycle-worker + outbox-worker**（api 与 lifecycle-worker 可同镜像异命令；outbox 用 web 镜像跑 `process-outbox.mjs`）。FastAPI **仅内网**；浏览器只访问控制面。

## Schema 所有权

| Schema | 所有者 | 内容 |
|--------|--------|------|
| `app` | Drizzle / Next.js | org、user、workspace、libraries、documents、versions、active pointer、jobs、ACL、outbox、audit |
| `rag` | Python 迁移脚本 | active generation 读模型等检索门禁数据 |
| `public`（兼容） | Python SQLAlchemy | 库/文档投影与历史 turns 等；**非**产品事实源 |

规则：Drizzle 与 Python **不得**迁移同一张表。Worker 用最小权限角色直接 DML `app.jobs` 等生命周期字段，**不能**改身份/成员/ACL，也不能跑 `app` DDL。

## 入库路径（唯一生产路径）

```text
Browser multipart/stream
  → POST /api/libraries/{id}/documents  (Next)
  → 写入对象存储 (DOCUMENT_STORAGE_ROOT 或客户对象存储)
  → 同一事务：document + version + job + audit
  → 202 + job_id

lifecycle_worker
  → FOR UPDATE SKIP LOCKED claim
  → heartbeat / retry / dead
  → parse (PyMuPDF / MinerU…) → DocumentIR → policy chunking → embed
  → Qdrant staging（不可召回）
  → 校验后：PG 事务切换 app.active + rag.active_generation
  → 旧 generation 进延迟清理
```

| 事实 | 说明 |
|------|------|
| 任务 SoT | **仅** `app.jobs`（无 ARQ ingest 队列） |
| FastAPI 写路径 | `/v1/ingest*`、`/v1/documents/*/replace|reindex`、产品侧 DELETE 写路径 → **永久 HTTP 410**，无 env 可开 |
| `DOCUMENT_LIFECYCLE_V2` | 默认 **开启**；仅显式 `false`/`0` 关闭（应急，非推荐） |
| Redis | HMAC replay 等；**不是** Job 事实源 |

不变量（摘要）：

1. 未激活 generation **永不**进入 dense/BM25/表格检索。
2. 新版本处理中，旧 active 继续服务。
3. 后完成的旧任务不能覆盖更新的 desired version。
4. 检索必须带 tenant / workspace / ACL + active generation。

## 会话与归档

```text
Ask 请求
  session_id          # 始终有；临时会话标识
  thread_id?          # 仅归档会话携带

无 thread_id（默认临时）
  → SessionMemory（进程内短窗）供追问 rewrite
  → 不写 durable turns

有 thread_id（已归档）
  → 历史从 DB turns 加载
  → 每轮写入 archive turns
  → /app/archive 列表与续聊
```

相关 API（经 BFF）：

| 方法 | 路径 | 作用 |
|------|------|------|
| POST | `/v1/ask` · `/v1/ask/stream` | 问答（可带 `thread_id`） |
| POST | `/v1/threads` | 主动归档：把当前临时轮次固化为 thread |
| GET | `/v1/threads` · `/v1/threads/{id}` | 列表 / 详情 |
| POST | `/v1/threads/{id}/continue` | 续聊准备 |
| GET | `/v1/archive` · `/{turn_id}` · `/debug` | 轮次与调试视图 |

UI：`/app/ask` 显示「未归档 / 已归档」；归档后 URL 带 `?thread=`。

## Ask 流水线

实现：`apps/api/app/graph/ask_graph.py`（LangGraph）。

```text
query_router
  ├─ clarify（信息不足）
  ├─ table 路径：build_table_plan → table_retrieve → table_execute → generate/refuse
  └─ 文本路径：
        rewrite（history / 指代）
        → build_retrieval_plan
        → retrieve（dense ⊕ 可选 hybrid/rerank）
        → judge（命中 / 弱相关 / 可答）
        → retry? → generate | refuse
```

生成侧：

- 仅用检索到的 evidence；citation 可点。
- 可选 **citation adjudicate**（默认开；绝对分阈值可工作区覆盖）。
- 多轮：拼 messages + 检索用 rewritten query。

### Ask 设置解析顺序

```text
workspace 业务意图策略（profiles）
  → policy_profiles / ask-policy 映射为内部 knobs
  → ASK_DEFAULTS（代码）填补未覆盖项
```

**产品面只暴露业务意图**：`answer_profile`、`retrieval_enhancement`、`session_memory_enabled`、`evidence_requirement`。
**不读**产品 env：`HYBRID_ENABLED`、`RERANK_ENABLED`、`SESSION_MEMORY_*` 等已退出产品配置面。
**不在 UI/正常 API 暴露**：`RRF_K`、`BM25_TOP_K`、原始 `CHUNK_SIZE`、语义 percentile 等算法旋钮。

UI：`/app/settings` → 工作区问答策略。
映射：`apps/api/app/services/policy_profiles.py` 与 `apps/web/src/lib/server/ask-policy.mjs`（需保持同步）。
冲突规则：拒答/引用严格度取 `answer_profile` 与 `evidence_requirement` 的更严一侧。
Ask 轨迹：`retrieval_debug.ask_policy` 记录 public + resolved（含具体 hybrid/rerank）。

知识库 `document_profile` + `parse_preference` + `scan_handling` 决定切片与解析意图；
`parse_preference` 只表达自动 / 高质量 / 严格不出域，**不**选择 Provider；
`scan_handling=disabled` 是严格 text-only（不调用 OCR/MinerU）。策略变更后
`requires_reindex=true`，V1 不静默全量重建。

## 鉴权与请求上下文

```text
Browser cookie (MERIKNOW_SESSION_SECRET)
  → Next 每次重载 user / membership / groups
  → 签发短时 HMAC RequestContext
       (tenant, workspace, principal, groups, method, path, body digest, jti)
  → FastAPI INTERNAL_AUTH_* 校验 + 可选 Redis 防重放
  → AccessScope 贯穿检索与元数据
```

| 环境 | 行为 |
|------|------|
| 开发 | 可 `INTERNAL_AUTH_ENABLED=false` 直连 `/v1`（仅本机） |
| 生产 | 必须 auth + Redis replay；反向代理只暴露 web |

Service 上下文：Outbox worker 调 `/v1/internal/*`；浏览器 BFF **拒绝**代理这些路径。

## 外部集成在架构中的位置

当前 Ask/Retrieve 能力住在 Data Plane，对外由 Next Knowledge API 网关验证工作区 Service Key，再签发内部 HMAC。目标是在**不暴露浏览器 Session 和 FastAPI 网络边界**的前提下，让客户业务系统调用同一知识内核（见 [INTEGRATION.md](./INTEGRATION.md)）。

外部 Documents/Versions/Jobs API 仍由 Control Plane 承载，因为文档产品事实和 Job 所有权属于 `app` schema；Retrieve/Answer 转发到 Data Plane。Python SDK、MCP 和 OpenAI-compatible endpoint 均建立在这些 HTTP 契约之上。

```text
Customer Backend
  → Service Key
  → Next Knowledge API
       ├─ Documents / Versions / Jobs → app schema + object storage
       └─ Retrieve / Answer → HMAC → FastAPI Data Plane
```

## 关键进程与依赖

| 进程 | 命令/入口 |
|------|-----------|
| web | `pnpm dev` / Next start |
| rag-api | `uvicorn app.main:app` |
| lifecycle_worker | `python -m app.lifecycle_worker` |
| outbox | `pnpm outbox:run` |
| 可选 sweeper | generation cleanup 等 |

依赖：PostgreSQL、Qdrant、Redis（生产 replay）、对象卷/存储、OpenAI-compatible LLM/embedding、可选 MinerU。

## 文档地图

| 文档 | 内容 |
|------|------|
| [PRODUCT.md](./PRODUCT.md) | 为什么做、核心产品与使用方式 |
| [STRATEGY.md](./STRATEGY.md) | 产品层级、目标客户与交付策略 |
| [ROADMAP.md](./ROADMAP.md) | 下一步与先决条件 |
| [DEV.md](./DEV.md) | 如何本地跑 |
| [INTEGRATION.md](./INTEGRATION.md) | Knowledge API 与适配层契约 |
| `docs/runbooks/*` | 部署、迁移、门禁、试点操作 |
| `docs/adr/*` | 已接受技术决策 |
