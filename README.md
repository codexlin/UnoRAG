# MeriKnow

**有据可依的企业知识问答。**

融合 DustyKB 的产品经验与 QueryNest 的多步编排思路；技术栈为 **Next.js + FastAPI + LangChain/LangGraph**。

## 技术栈

| 层 | 选型 |
|----|------|
| Web | Next.js · pnpm · Tailwind · shadcn/ui · Biome |
| API | FastAPI · LangGraph（rewrite → retrieve → judge → retry → generate/refuse）· Qdrant · OpenAI-compatible LLM |
| 元数据 | 默认 JSON 文件；可选 Postgres（SQLAlchemy，无 Prisma） |

## 仓库结构

```text
MeriKnow/
  docker-compose.yml   # Qdrant + 可选 Postgres（profile: db）
  apps/web/            # Next.js 前端（Northline + /app 工作台）
  apps/api/            # FastAPI + LangGraph
  docs/                # 计划与设计
```

## 一键启动顺序

```text
1) docker compose up -d          # Qdrant :6333
2) API (apps/api)                # uvicorn :8000
3) 文库页上传 或 ingest_sample   # live 才真正写向量
4) Web (apps/web)                # pnpm --filter web dev :3000
```

### 1. Docker

```bash
cd MeriKnow
docker compose up -d
curl -s http://localhost:6333/readyz   # 期望：all shards are ready
```

可选 Postgres 元数据：

```bash
docker compose --profile db up -d
# apps/api/.env:
# DATABASE_URL=postgresql+psycopg://meriknow:meriknow@localhost:5432/meriknow
```

未设置 `DATABASE_URL` 时使用 `METADATA_PATH`（默认 `data/metadata.json`）。

### 2. API（默认 stub，无需密钥）

```bash
cd apps/api
cp .env.example .env   # 首次
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

- 健康检查：<http://localhost:8000/health>
- OpenAPI：<http://localhost:8000/docs>
- 问答：`POST /v1/ask` · 流式：`POST /v1/ask/stream`（SSE）
- 文库：`GET /v1/libraries` · `GET /v1/libraries/{id}/documents`
- 入库：`POST /v1/ingest` · 上传：`POST /v1/ingest/upload`（multipart）

```bash
cd apps/api && uv run pytest
```

### 3. 开启 live + 上传 / 入库

1. 确认 Qdrant 已启动
2. 编辑 `apps/api/.env`：

```bash
ASK_MODE=live
OPENAI_API_KEY=sk-...          # 或 DASHSCOPE_API_KEY
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
CHAT_MODEL=qwen-plus
EMBEDDING_MODEL=text-embedding-v3
EMBEDDING_DIM=1024
QDRANT_URL=http://localhost:6333
ANSWER_MIN_SCORE=0.35
# 可选混合检索
# HYBRID_ENABLED=true
# 可选 rerank
# RERANK_ENABLED=true
```

3. 上传或样例入库后提问：

```bash
# 上传（txt/md/pdf）
curl -s -X POST http://localhost:8000/v1/ingest/upload \
  -F library_id=lib-hr \
  -F file=@./README.md

# 或脚本样例
uv run python scripts/ingest_sample.py

# 非流式
curl -s -X POST http://localhost:8000/v1/ask \
  -H 'content-type: application/json' \
  -d '{"question":"病假需要在几天内补交证明？","library_id":"lib-hr","session_id":"demo-1"}'

# 流式 SSE
curl -N -X POST http://localhost:8000/v1/ask/stream \
  -H 'content-type: application/json' \
  -d '{"question":"病假需要在几天内补交证明？","library_id":"lib-hr"}'
```

stub 下默认 `STUB_INGEST_SIMULATE=true`：上传会写入元数据并标记 ready（不 embed）；设为 `false` 则返回 503。

### 4. 前端

```bash
pnpm install
pnpm --filter web dev
```

打开 [http://localhost:3000/app/libraries](http://localhost:3000/app/libraries) 上传，再到问答台看流式回答。

## 本阶段能力

- **文库上传**：multipart → 解析 txt/md/pdf（PyMuPDF）→ 元数据 status → live 写 Qdrant
- **流式问答**：SSE `meta` / `citations` / `token` / `done`
- **元数据**：JSON 降级或可选 Postgres
- **混合检索**：`HYBRID_ENABLED` + BM25/RRF；失败回退 dense；`retrieval_debug.used_hybrid`
- **Session rewrite / 可选 rerank**：同前

## 计划

见 [docs/plans/2026-07-22-meriknow-bootstrap.md](./docs/plans/2026-07-22-meriknow-bootstrap.md)。

## 与旧项目关系

- **DustyKB**：上传、流式、BM25/RRF、拒答文案择优迁入。
- **QueryNest**：Agent 式 RAG / session rewrite 参考。
- **ragsass**：不采用 Prisma/GraphQL 全栈。
