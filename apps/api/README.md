# MeriKnow API（RAG Data Plane）

FastAPI + LangChain + LangGraph。Ask 图见 [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)。

浏览器应访问 Next.js `/api/rag/*`，**不要**直连本服务做产品操作。产品定位与双模式：[`docs/PRODUCT.md`](../../docs/PRODUCT.md)。本地联调总入口：[`docs/DEV.md`](../../docs/DEV.md)。

## 前置：Qdrant / Postgres / Redis

仓库根目录：

```bash
docker compose up -d
curl -s http://localhost:6333/readyz
```

## 本地启动

```bash
cd apps/api
cp .env.example .env   # 首次；权威分层见文件头注释
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

产品上传另需 lifecycle worker（与 web 共享 `DOCUMENT_STORAGE_ROOT`）：

```bash
uv run python -m app.lifecycle_worker
```

| 端点 | 说明 |
|------|------|
| `GET /health` | 探针（可无内部鉴权） |
| `POST /v1/ask` · `/v1/ask/stream` | 有据问答 |
| `POST /v1/threads` 等 | 主动归档 / 续聊 |
| `/v1/ingest*` 等写路径 | **永久 410** |

私有化生产：

```bash
APP_ENV=production
INTERNAL_AUTH_ENABLED=true
INTERNAL_AUTH_SECRET=<与 Next.js MERIKNOW_INTERNAL_SECRET 相同>
INTERNAL_AUTH_REPLAY_BACKEND=redis
```

> 禁止将开发默认值用于部署。FastAPI 只放在内部网络，仅向 Next.js 与 worker 开放。

开发态直连示例（`INTERNAL_AUTH_ENABLED=false` 时）：

```bash
curl -s -X POST http://localhost:8000/v1/ask \
  -H 'content-type: application/json' \
  -d '{"question":"病假需要在几天内补交证明？","library_id":"lib-hr","session_id":"demo-1"}'
```

多轮同 `session_id`；归档会话传 `thread_id`。响应 `retrieval_debug.rewrite` 在追问时应为 `history`。

## 环境变量

见 [`.env.example`](./.env.example)。要点：

| 变量 | 说明 |
|------|------|
| `INTERNAL_AUTH_ENABLED` | 多用户必须 `true`，否则 `principal=development` 串台 |
| `INTERNAL_AUTH_SECRET` | = web `MERIKNOW_INTERNAL_SECRET` |
| `OPENAI_API_KEY` **或** `DASHSCOPE_API_KEY` | 只配一个 |
| `DOCUMENT_STORAGE_ROOT` | 与 web 共享原文卷 |
| 问答/检索产品旋钮 | 代码默认 ⊕ 工作区覆盖，**不**读 env（`ask_defaults.py`） |
| 产品上传 | Next → `app.jobs` → lifecycle_worker |

## Document Lifecycle Worker

```bash
export WORKER_DATABASE_URL=postgresql://worker_login:secret@localhost:5432/meriknow
export DOCUMENT_STORAGE_ROOT=/var/lib/meriknow/documents
uv run python -m app.lifecycle_worker
```

- Claim：`FOR UPDATE SKIP LOCKED` + heartbeat；过期租约 → retry → dead
- L2 点均为 `staging`，L3 激活前不进检索
- ARQ / FastAPI browser ingest 写路径已移除；Redis 仅用于 HMAC replay 等

首次启用前：

```bash
MIGRATOR_DATABASE_URL=postgresql://... \
  uv run python scripts/apply_rag_migrations.py
# 再执行 ops/postgres/configure-runtime-roles.sql
```

## Lifecycle 解析与错误

支持 `.txt` / `.md` / `.markdown` / `.docx` / `.pdf`。文本 PDF→PyMuPDF；扫描/双栏/复杂表可由 `MINERU_MODE=auto` 升级 MinerU。

| error_code | Job 行为 |
|---|---|
| `mineru_soft_timeout` / `mineru_rate_limited` | 立刻还槽 + retry（较长退避） |
| `mineru_timeout` / `mineru_service_error` / `mineru_invalid_response` | auto 且已有 PyMuPDF 节点 → degrade 继续 ingest；否则 retry → dead |
| `mineru_unreachable` | auto 且已有 PyMuPDF 节点 → degrade；否则 **failed（不重试）** |
| `mineru_request_rejected` / `mineru_not_configured` | failed，不重试 |

## 测试与样例

```bash
uv run pytest
uv run python scripts/ingest_sample.py   # 开发样例，非产品 HTTP ingest
uv run python scripts/run_eval_cases.py
```
