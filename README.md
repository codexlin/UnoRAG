# MeriKnow

**有据可依的企业知识问答。**

融合 [DustyKB](https://github.com/codexlin/DustyKB) 的产品经验与 QueryNest 的多步编排思路；技术栈为 **Next.js + FastAPI + LangChain/LangGraph**。

## 技术栈

| 层 | 选型 |
|----|------|
| Web | Next.js · pnpm · Tailwind · shadcn/ui · Biome |
| API | FastAPI · LangGraph（stub → 完整图）· 后续 Qdrant / Postgres |

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
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000)。工作台：[http://localhost:3000/app](http://localhost:3000/app)。

复制 `apps/web/.env.example` → `apps/web/.env.local`（默认 API `http://localhost:8000`）。

### API

```bash
cd apps/api
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

- 健康检查：<http://localhost:8000/health>
- OpenAPI：<http://localhost:8000/docs>
- 问答 stub：`POST /v1/ask`

```bash
cd apps/api && uv run pytest
```

## 计划

见 [docs/plans/2026-07-22-meriknow-bootstrap.md](./docs/plans/2026-07-22-meriknow-bootstrap.md)。

## 与旧项目关系

- **DustyKB**：作品集演示；能力择优迁入。
- **QueryNest**：Agent 式 RAG 参考；MeriKnow 用 LangGraph 对齐编排。
- **ragsass**：B2B 领域词典（租户/流水线/审计）；不采用其 Prisma/GraphQL 全栈。
