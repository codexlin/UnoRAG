# MeriKnow

**有据可依的企业知识问答。**

融合 DustyKB 的产品经验与 QueryNest 的多步编排思路；技术栈为 **Next.js + FastAPI + LangChain/LangGraph**。

## 技术栈

| 层 | 选型 |
|----|------|
| Web | Next.js · pnpm · Tailwind · shadcn/ui · Biome |
| API | FastAPI · LangGraph（rewrite → retrieve → judge → retry → generate/refuse）· Qdrant · OpenAI-compatible LLM |

## 仓库结构

```text
MeriKnow/
  docker-compose.yml   # 本地 Qdrant（可选 Postgres 已注释）
  apps/web/            # Next.js 前端（Northline + /app 工作台）
  apps/api/            # FastAPI + LangGraph
  docs/                # 计划与设计
```

## 一键启动顺序

```text
1) docker compose up -d          # Qdrant :6333
2) API (apps/api)                # uvicorn :8000
3) ingest（仅 live）             # scripts/ingest_sample.py
4) Web (apps/web)                # pnpm --filter web dev :3000
```

### 1. Docker（Qdrant）

```bash
cd MeriKnow
docker compose up -d
curl -s http://localhost:6333/readyz   # 期望：all shards are ready
```

停止：`docker compose down`（加 `-v` 会清掉向量数据卷）。

> 本阶段只拉起 **Qdrant**。`docker-compose.yml` 里留有注释掉的 Postgres，以后需要元数据库再打开。

### 2. API（默认 stub，无需密钥）

```bash
cd apps/api
cp .env.example .env   # 首次
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

- 健康检查：<http://localhost:8000/health>
- OpenAPI：<http://localhost:8000/docs>
- 问答：`POST /v1/ask`
- 入库（仅 live）：`POST /v1/ingest`

```bash
cd apps/api && uv run pytest
```

### 3. 开启 live + 入库样例

1. 确认 Qdrant 已启动（见上）
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
# 可选 rerank（失败自动回退 dense）
# RERANK_ENABLED=true
```

3. 入库并提问：

```bash
cd apps/api
uv run python scripts/ingest_sample.py
curl -s -X POST http://localhost:8000/v1/ask \
  -H 'content-type: application/json' \
  -d '{"question":"病假需要在几天内补交证明？","library_id":"lib-hr","session_id":"demo-1"}'
```

多轮追问（同一 `session_id`，短追问会带上历史 rewrite）：

```bash
curl -s -X POST http://localhost:8000/v1/ask \
  -H 'content-type: application/json' \
  -d '{"question":"那逾期呢？","library_id":"lib-hr","session_id":"demo-1"}'
```

无密钥或 Qdrant 不可达时，`ASK_MODE=live` 会自动降级为 stub，`/health` 中 `degraded=true`。

### 4. 前端

```bash
pnpm install
pnpm --filter web dev
```

打开 [http://localhost:3000](http://localhost:3000)。工作台：[http://localhost:3000/app](http://localhost:3000/app)。

复制 `apps/web/.env.example` → `apps/web/.env.local`（默认 API `http://localhost:8000`）。

## 本阶段 RAG 增强

- **Dense + 可选 rerank**：`RERANK_ENABLED=true` 时在向量检索后调用 DashScope-compatible `/reranks`；失败回退 dense；`ANSWER_MIN_SCORE` 仍用于弱相关拒答。
- **Session 短记忆 rewrite**：同 `session_id` 的短追问会拼上一轮用户问题再检索（进程内内存，重启清空）。

## 计划

见 [docs/plans/2026-07-22-meriknow-bootstrap.md](./docs/plans/2026-07-22-meriknow-bootstrap.md)。

## 与旧项目关系

- **DustyKB**：作品集演示；拒答文案、阈值与 rerank 钩子择优迁入。
- **QueryNest**：Agent 式 RAG 参考；MeriKnow 用 LangGraph 对齐编排，并借鉴 session rewrite。
- **ragsass**：B2B 领域词典；不采用其 Prisma/GraphQL 全栈。
