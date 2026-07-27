# MeriKnow

**可私有化部署、权限感知、版本安全、结果可追溯的企业知识服务。**

MeriKnow 独立部署和治理知识，但不要求客户采用我们的最终业务 UI：

- 核心产品是 **MeriKnow Knowledge Service**：文档生命周期、ACL、检索、有据回答、评测与可观测性。
- **MeriKnow Workspace** 是官方管理控制台和参考客户端，也可直接作为企业知识助手使用。
- 客户已有业务系统或 Agent 时，通过 HTTP API 接入；Python SDK、MCP 与 OpenAI-compatible adapter 是同一 API 的薄适配层。

| 使用方式 | 何时用 | 得到什么 |
|------|--------|----------|
| **官方 Workspace** | 公司需要开箱即用的知识助手与管理台 | 工作区、文库、有据问答、追问、主动归档、调试 |
| **嵌入现有系统** | 已有客服、售后、门户、Chat 或 Agent | 通过稳定 API 接入 retrieve/answer，不更换现有 UI/Agent |
| **协议适配** | 希望用现有开发工具快速集成 | [Python SDK](./sdk/python/) · [MCP](./sdk/mcp/) 已可用；OpenAI-compatible adapter 按路线图提供 |

> 边界与成功标准见 [`docs/PRODUCT.md`](./docs/PRODUCT.md)。  
> 后面做什么、开始前先做好什么见 [`docs/ROADMAP.md`](./docs/ROADMAP.md)。

## 快速链接

| 文档 | 说明 |
|------|------|
| [产品说明](./docs/PRODUCT.md) | 核心定位、使用方式、做/不做 |
| [产品策略](./docs/STRATEGY.md) | 目标客户、首发场景、产品层级、商业化与面试叙事 |
| [路线图](./docs/ROADMAP.md) | 近中远期 + 开工 checklist |
| [架构](./docs/ARCHITECTURE.md) | 控制面 vs 数据面、入库、会话、Ask |
| [Knowledge API](./docs/INTEGRATION.md) | 已实现 vs 规划中契约 |
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

## 能力一览

- **文库**：txt/md/docx/pdf → 结构优先切片 → Job/版本/激活 → 问答
- **流式问答**：SSE；`[n]` 可点；证据预览；弱相关/无命中拒答
- **会话**：默认临时；主动归档；可续聊；query rewrite
- **工作区旋钮**：hybrid / rerank / 裁决等在设置页（**不是** `HYBRID_ENABLED` env）
- **入库**：仅控制面 → lifecycle_worker；FastAPI ingest **永久 410**
- **对外 API（v1.0 已冻结）**：工作区 Service Key → `POST /api/v1/retrieve`、`POST /api/v1/ask`；严格输入、稳定错误与 citation 契约、OpenAPI
- **协议适配**：[Python SDK](./sdk/python/) · [MCP Server](./sdk/mcp/)（0.1.0）；**仍在规划**：外部 Documents/Versions/Jobs、Answer 契约、OpenAI-compatible adapter

## 测试

```bash
cd apps/api
uv run pytest
uv run python scripts/run_eval_cases.py
```

## 与 SAG / RAG-Anything

借鉴解析与编排能力，**不照搬**「通用 Agent / 万能框架」定位。MeriKnow 坚持企业知识服务内核 + 多种客户端/接入面。
