# MeriKnow API

FastAPI + LangChain + LangGraph。图路径：`rewrite → retrieve → judge → (retry) → generate | refuse`。

FastAPI 是内部 RAG Data Plane。浏览器应访问 Next.js
`/api/rag/*`，不直接访问本服务的 `/v1`。

## 前置：Qdrant

仓库根目录：

```bash
docker compose up -d
curl -s http://localhost:6333/readyz
```

`.env` 中 `QDRANT_URL=http://localhost:6333`（与 compose 一致）。

## 本地启动

```bash
cd apps/api
cp .env.example .env   # 首次
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

- 健康检查：<http://localhost:8000/health>
- 问答：`POST http://localhost:8000/v1/ask`
- 入库（live）：`POST http://localhost:8000/v1/ingest`

私有化生产需设置：

```bash
APP_ENV=production
INTERNAL_AUTH_ENABLED=true
INTERNAL_AUTH_SECRET=<与 Next.js MERIKNOW_INTERNAL_SECRET 相同>
INTERNAL_AUTH_REPLAY_BACKEND=redis
```

开启后，所有 `/v1` 请求必须携带 Next.js 签发的短期 HMAC
RequestContext；签名绑定 method、canonical path/query 与精确 body
摘要，并通过一次性 `jti` 防重放。JSON 与 multipart 都在路由解析前
验证精确 body 摘要。`/health` 保持可用于容器探针。

> **禁止将开发默认值用于部署：** development 模式允许直接调用 `/v1`，
> 仅用于本机开发。生产必须设置 `APP_ENV=production`，并将 FastAPI
> 放在内部网络，只允许 Next.js 与 worker 访问；不要公开映射 `:8000`。

RequestContext 会生成统一 `AccessScope`。Dense、BM25、表格全量加载、
删除、`public.libraries/documents` 元数据和异步 ingest 都强制携带
tenant/workspace/ACL 过滤。启动升级只会根据 `app.libraries/documents`
的明确 ID 映射回填旧元数据；无法映射的 legacy 行保持不可见，需要通过
Control Plane 重新投影或重新入库。旧的无 scope Qdrant 点同样不会被召回，
需要重新索引。

```bash
curl -s http://localhost:8000/health
curl -s -X POST http://localhost:8000/v1/ask \
  -H 'content-type: application/json' \
  -d '{"question":"病假需要在几天内补交证明？","library_id":"lib-hr","session_id":"demo-1"}'
```

Stub 拒答自测：问题含「无命中」或「弱相关」。

多轮（同 `session_id`）：

```bash
curl -s -X POST http://localhost:8000/v1/ask \
  -H 'content-type: application/json' \
  -d '{"question":"那逾期呢？","library_id":"lib-hr","session_id":"demo-1"}'
```

响应 `retrieval_debug.rewrite` 在追问时应为 `history`。

## 环境变量

见 `.env.example`。要点：

| 变量 | 说明 |
|------|------|
| `ASK_MODE` | 默认 `live`；缺密钥或 Qdrant 不可达时硬失败（503），不降级 stub。`stub` 仅测试 |
| `OPENAI_API_KEY` / `DASHSCOPE_API_KEY` | OpenAI-compatible 密钥 |
| `OPENAI_BASE_URL` | 默认 DashScope compatible-mode |
| `CHAT_MODEL` / `EMBEDDING_MODEL` / `EMBEDDING_DIM` | 默认 qwen-plus / text-embedding-v3 / 1024 |
| `QDRANT_URL` / `QDRANT_COLLECTION` | 向量库（默认 `http://localhost:6333`） |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | 默认 500 / 80（v2 节点内二次切 / legacy 字窗） |
| `CHUNKING_PROFILE` / `CHUNK_POLICY_VERSION` | 默认 `balanced` / `v1`；profile 见 ADR 0003 |
| `SEMANTIC_CHUNKING_ENABLED` | 默认 `false`；仅增强长、无结构叙事文本，失败显式降级 |
| `SEMANTIC_CHUNK_MIN_CHARS` / `SEMANTIC_CHUNK_BREAK_PERCENTILE` | 默认 1200 / 85 |
| `INGEST_PIPELINE` | `v2`（默认，IR 结构切）或 `legacy` |
| `PDF_SCAN_STRATEGY` | `partial`（默认）\| `fail` |
| `OCR_ENABLED` / `VLM_ENABLED` | 默认 `false`；见 `docs/adr/0001-ocr-vlm-adapters.md` |
| `MINERU_ENABLED` / `MINERU_URL` | 默认关；扫描/复杂 PDF 走独立 MinerU 服务（见 `docs/adr/0002-mineru-complex-pdf.md`） |
| `MINERU_MODE` | `auto`（默认）\| `pymupdf` \| `mineru` |
| `MINERU_TIMEOUT_S` / `MINERU_SOFT_TIMEOUT_S` / `MINERU_MAX_RETRIES` / `MINERU_PARSE_PATH` | 默认 `120` / `60` / `2` / `/file_parse`；软超时 ≤ 硬超时，`<=0` 关闭软超时 |
| `MINERU_RETRY_BASE_S` / `MINERU_RETRY_MAX_S` | 默认 `30` / `300`；`mineru_rate_limited` / `mineru_soft_timeout` 的 job 退避 |
| `LLM_MAX_INFLIGHT` | 默认 `4`；Ask/ingest LLM 进程内并发，`<=0` 关闭 |
| `MINERU_USE_FAKE` | 仅测试；production 明确禁止 |
| `TOOL_ASK` | 默认 `false`；工具函数在 `app/services/ingest/tools.py` |
| `ANSWER_MIN_SCORE` | 弱相关拒答阈值；`0` 关闭 |
| `MAX_RETRIEVE_RETRIES` | judge 后最多重试次数（默认 1） |
| `RERANK_ENABLED` | 默认 `false`；开启后 dense → `/reranks` |
| `RERANK_BASE_URL` / `RERANK_MODEL` / `RERANK_TOP_K` | DashScope-compatible rerank |
| `SESSION_MEMORY_ENABLED` | 默认 `true`；同 session 短记忆 rewrite |
| `SESSION_MEMORY_MAX_TURNS` | 保留轮数（默认 6） |
| `STUB_INGEST_SIMULATE` | 默认 `false`；仅 `ASK_MODE=stub` 且为 true 时模拟入库 |
| `INTERNAL_AUTH_ENABLED` | 私有化生产设为 `true`，阻止绕过 Next.js 直连 `/v1` |
| `INTERNAL_AUTH_SECRET` | 与 Next.js 共享的 32+ 字节随机密钥，不写入镜像或 Git |
| `INTERNAL_AUTH_REPLAY_BACKEND` | 开发可用 `memory`；production 强制 `redis`，跨 worker 防重放 |
| `WORKER_DATABASE_URL` | PostgreSQL lifecycle worker 专用连接；生产登录角色只授予 `meriknow_worker` |
| `DOCUMENT_STORAGE_ROOT` | 与 Next.js 完全相同的共享原文目录 |
| `LIFECYCLE_WORKER_LEASE_SECONDS` / `LIFECYCLE_WORKER_HEARTBEAT_SECONDS` | 默认 `120` / `30`；lease 至少为 heartbeat 的两倍 |
| `ACTIVE_GENERATION_GATE_ENABLED` | production 必须为 `true`；所有检索强制匹配 PostgreSQL active generation |
| `RAG_READ_DATABASE_URL` | FastAPI 只读 gate 连接；生产登录角色只授予 `meriknow_rag_read` |
| `ACTIVE_GENERATION_CACHE_TTL_SECONDS` | 默认 `0`；production 强制为 `0`，每个检索操作读取严格 active 快照 |

## Document Lifecycle Worker

L2 原生 Job 由 PostgreSQL worker 消费，不经过 FastAPI HTTP，也不进入
Redis/ARQ：

```bash
export WORKER_DATABASE_URL=postgresql://worker_login:secret@localhost:5432/meriknow
export DOCUMENT_STORAGE_ROOT=/var/lib/meriknow/documents
uv run python -m app.lifecycle_worker
```

worker 只 claim `document.ingest`，每次处理一个 Job；吞吐通过增加进程或
Pod 横向扩展。`FOR UPDATE SKIP LOCKED` 防止重复 claim，后台 heartbeat
续租；进程被 kill 后，过期租约会自动进入 `retry`，耗尽次数后进入
`dead`。L2 产出的 Qdrant 点均为 `staging`，在 L3 原子激活前不会进入
Dense、BM25 或表格检索。

L6 起产品 ingest 默认不再入队 ARQ。`LEGACY_INGEST_WRITES_ENABLED=true` 仅供
迁移/单测临时打开 FastAPI upload/replace/reindex；生产环境禁止开启。若仍需
调试旧 worker：

```bash
LEGACY_INGEST_WRITES_ENABLED=true uv run arq app.worker.WorkerSettings
```

首次启用 L3 前，使用 migrator 凭据应用 Python 管理的 `rag` schema：

```bash
MIGRATOR_DATABASE_URL=postgresql://... \
  uv run python scripts/apply_rag_migrations.py
```

再执行 `ops/postgres/configure-runtime-roles.sql`。激活时 worker 先设置新
generation 的 Qdrant active hint，再在单一 PostgreSQL 事务中切换
`app.document_active_versions` 与 `rag.active_document_generations`。检索以
后者为权威快照，因此不会混合新旧 generation；旧 generation 进入延迟清理
队列，不在请求路径同步删除。

## Lifecycle V2 解析与错误

Next.js 原生上传支持 `.txt`、`.md`、`.markdown`、`.docx`、`.pdf`。文本 PDF
使用 PyMuPDF；扫描、双栏、复杂表等由 `MINERU_MODE=auto` 按页信号升级到
MinerU。PyMuPDF/MinerU 转换按页回写 Job progress，独立 heartbeat 在线程中
续租；取消会终止主 Job 等待，未完成 generation 保持 staging 并被清理。

| error_code | Job 行为 |
|---|---|
| `mineru_soft_timeout` | 立刻还槽 + retry（较长退避），耗尽后 dead |
| `mineru_timeout` | retry，耗尽后 dead |
| `mineru_rate_limited` | 立刻还槽 + retry（较长退避），耗尽后 dead |
| `mineru_service_error` / `mineru_unreachable` | retry，耗尽后 dead |
| `mineru_invalid_response` | retry，耗尽后 dead |
| `mineru_request_rejected` / `mineru_not_configured` | failed，不重试 |

重试期间旧 active generation 继续服务。失败 PDF 的 PyMuPDF 页级诊断会写入
`document_versions.parser_report`，可从文档详情和 Job API 查看。

## Live 样例入库

```bash
uv run python scripts/ingest_sample.py
```

## 测试

```bash
uv run pytest
```
