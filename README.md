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
  apps/web/     # Next.js 前端（Northline + /app 工作台）
  apps/api/     # FastAPI + LangGraph
  docs/         # 计划与设计
```

## 本地开发

### 前端

```bash
pnpm install
pnpm --filter web dev
```

打开 [http://localhost:3000](http://localhost:3000)。工作台：[http://localhost:3000/app](http://localhost:3000/app)。

复制 `apps/web/.env.example` → `apps/web/.env.local`（默认 API `http://localhost:8000`）。

### API（默认 stub，无需密钥）

```bash
cd apps/api
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

- 健康检查：<http://localhost:8000/health>（含 `effective_mode` / `degraded` / Qdrant）
- OpenAPI：<http://localhost:8000/docs>
- 问答：`POST /v1/ask`
- 入库（仅 live）：`POST /v1/ingest`

```bash
cd apps/api && uv run pytest
```

### 开启 live（Embedding + Qdrant + LLM）

1. 启动 Qdrant（例：`docker run -p 6333:6333 qdrant/qdrant`）
2. 复制 `apps/api/.env.example` → `apps/api/.env`，设置：

```bash
ASK_MODE=live
OPENAI_API_KEY=sk-...          # 或 DASHSCOPE_API_KEY
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
CHAT_MODEL=qwen-plus
EMBEDDING_MODEL=text-embedding-v3
EMBEDDING_DIM=1024
QDRANT_URL=http://localhost:6333
ANSWER_MIN_SCORE=0.35          # 最高分低于此值拒答；0 关闭弱相关拒答
```

3. 写入样例文档后提问：

```bash
cd apps/api
uv run python scripts/ingest_sample.py
curl -s -X POST http://localhost:8000/v1/ask \
  -H 'content-type: application/json' \
  -d '{"question":"病假需要在几天内补交证明？","library_id":"lib-hr"}'
```

无密钥或 Qdrant 不可达时，`ASK_MODE=live` 会自动降级为 stub，`/health` 中 `degraded=true`。

## 计划

见 [docs/plans/2026-07-22-meriknow-bootstrap.md](./docs/plans/2026-07-22-meriknow-bootstrap.md)。

## 与旧项目关系

- **DustyKB**：作品集演示；拒答文案与阈值策略择优迁入。
- **QueryNest**：Agent 式 RAG 参考；MeriKnow 用 LangGraph 对齐编排。
- **ragsass**：B2B 领域词典；不采用其 Prisma/GraphQL 全栈。
