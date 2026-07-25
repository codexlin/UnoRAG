# MeriKnow

**企业有据知识引擎**——可当公司 AI 助手用，也可无缝接到已有助手里补强 RAG。

| 模式 | 何时用 | 得到什么 |
|------|--------|----------|
| **A · 完整助手** | 公司没有好用的 AI 助手 | 工作区、文库、有据问答、追问、主动归档 |
| **B · RAG 嵌入** | 已有助手但 RAG 不行 | 通过稳定 API/MCP（后置）接入 retrieve/ask，不强迫用我们的 UI/Agent |

> 边界与成功标准见 [`docs/PRODUCT.md`](./docs/PRODUCT.md)。  
> 后面做什么、开始前先做好什么见 [`docs/ROADMAP.md`](./docs/ROADMAP.md)。

## 快速链接

| 文档 | 说明 |
|------|------|
| [产品说明](./docs/PRODUCT.md) | 定位、双模式、做/不做 |
| [路线图](./docs/ROADMAP.md) | 近中远期 + 开工 checklist |
| [架构](./docs/ARCHITECTURE.md) | 控制面 vs 数据面、入库、会话、Ask |
| [集成（模式 B）](./docs/INTEGRATION.md) | 已实现 vs 规划中契约 |
| [开发者指南](./docs/DEV.md) | 本机启动与 env 分层 |
| [文档索引](./docs/README.md) | ADR / runbook / 验收 |
| [私有化部署](./deploy/README.md) | Compose / Helm 交付包 |

## 技术栈

| 层 | 选型 |
|----|------|
| Control Plane | Next.js · Drizzle · PostgreSQL `app` schema |
| RAG Data Plane | FastAPI · LangGraph · Qdrant · OpenAI-compatible LLM |
| 入库 Worker | Python lifecycle_worker ← `app.jobs`（非 ARQ） |
| 兼容元数据 | PostgreSQL `public` / `rag`（Python）；测试可 `METADATA_BACKEND=json` |

## 仓库结构

```text
MeriKnow/
  docker-compose.yml   # 本机 Postgres + Qdrant + Redis
  apps/web/            # Northline 工作台（控制面）
  apps/api/            # FastAPI + LangGraph + lifecycle_worker
  deploy/              # 客户式私有化参考拓扑
  docs/                # 产品 / 架构 / 路线图 / runbook
```

## 一键启动（开发）

完整说明与 env 分层见 [`docs/DEV.md`](./docs/DEV.md)。摘要：

```bash
cd MeriKnow
docker compose up -d

cd apps/web
cp -n .env.example .env.local
pnpm install && pnpm db:migrate && pnpm db:bootstrap
pnpm outbox:run &    # 另开终端亦可
pnpm dev

cd apps/api
cp -n .env.example .env
uv sync
uv run uvicorn app.main:app --reload --port 8000
# 另开终端：DOCUMENT_STORAGE_ROOT=... uv run python -m app.lifecycle_worker
```

- 工作台：<http://localhost:3000/app>
- 同源健康：`GET http://localhost:3000/api/rag/health`
- 浏览器**只**访问 Next；FastAPI `:8000` 仅内网

生产密钥对齐：

```bash
# apps/web/.env.local
MERIKNOW_INTERNAL_SECRET=...   # = api INTERNAL_AUTH_SECRET
MERIKNOW_SESSION_SECRET=...    # 独立；≠ internal
MERIKNOW_ADMIN_PASSWORD=...

# apps/api/.env
APP_ENV=production
INTERNAL_AUTH_ENABLED=true
INTERNAL_AUTH_SECRET=...
INTERNAL_AUTH_REPLAY_BACKEND=redis
```

## 能力一览（模式 A）

- **文库**：txt/md/docx/pdf → 结构优先切片 → Job/版本/激活 → 问答
- **流式问答**：SSE；`[n]` 可点；证据预览；弱相关/无命中拒答
- **会话**：默认临时；主动归档；可续聊；query rewrite
- **工作区旋钮**：hybrid / rerank / 裁决等在设置页（**不是** `HYBRID_ENABLED` env）
- **入库**：仅控制面 → lifecycle_worker；FastAPI ingest **永久 410**

## 测试

```bash
cd apps/api
uv run pytest
uv run python scripts/run_eval_cases.py
```

## 与 SAG / RAG-Anything

借鉴解析与编排能力，**不照搬**「通用 Agent / 万能框架」定位。MeriKnow 坚持有据知识引擎 + 双模式交付。
