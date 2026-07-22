# MeriKnow

**有据可依的企业知识问答。**

融合 DustyKB 的产品经验与 QueryNest 的多步编排思路；技术栈为 **Next.js + FastAPI + LangChain/LangGraph**。

## 技术栈

| 层 | 选型 |
|----|------|
| Web | Next.js · pnpm · Tailwind · shadcn/ui · Biome |
| API | FastAPI · LangGraph · Qdrant · OpenAI-compatible LLM |
| 元数据 / 档案 | **Postgres 必选**（SQLAlchemy）；仅测试可显式 `METADATA_BACKEND=json` |

## 仓库结构

```text
MeriKnow/
  docker-compose.yml   # Qdrant + Postgres（默认一并启动）
  apps/web/            # Northline 工作台
  apps/api/            # FastAPI + LangGraph
  docs/                # 计划与设计
```

## 一键启动

```bash
cd MeriKnow
docker compose up -d
# Qdrant :6333 · Postgres :5432

cd apps/api
cp -n .env.example .env
# DATABASE_URL + METADATA_BACKEND=postgres 必填；连不上 Postgres 时进程直接启动失败
uv sync
uv run uvicorn app.main:app --reload --port 8000

# 另开终端
pnpm install && pnpm --filter web dev
```

- 工作台：<http://localhost:3000/app>
- 健康检查：`GET /health`（看 `status` / `ask_ready` / `metadata_backend`；live 未就绪时为 `unavailable`）
- 档案：`GET /v1/archive` · 页面 `/app/archive`

## 能力一览

- **文库上传**：显示名 + txt/md/pdf → 索引状态 → 问答
- **流式问答**：SSE；答案内 `[n]` 可点；证据 chip 带片段预览
- **拒答**：无命中 / 弱相关
- **Session rewrite**、可选 **rerank** / **BM25+RRF 混合检索**
- **档案回看**：ask 完成后写入 turns（Postgres 或 JSON）

## live 提示

```bash
ASK_MODE=live
DASHSCOPE_API_KEY=...   # 或 OPENAI_API_KEY
# 可选
# HYBRID_ENABLED=true
# RERANK_ENABLED=true
```

```bash
cd apps/api && uv run pytest
```

## 计划

见 [docs/plans/2026-07-22-meriknow-bootstrap.md](./docs/plans/2026-07-22-meriknow-bootstrap.md)。
