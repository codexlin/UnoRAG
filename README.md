# MeriKnow

**有据可依的企业知识问答。**

融合 DustyKB 的产品经验与 QueryNest 的多步编排思路；采用 **Next.js Control Plane + FastAPI/Python RAG Data Plane**。

## 技术栈

| 层 | 选型 |
|----|------|
| Control Plane | Next.js · Drizzle · PostgreSQL `app` schema |
| RAG Data Plane | FastAPI · LangGraph · Qdrant · OpenAI-compatible LLM |
| 迁移期元数据 / 档案 | PostgreSQL `public` schema（SQLAlchemy）；仅测试可显式 `METADATA_BACKEND=json` |

## 仓库结构

```text
MeriKnow/
  docker-compose.yml   # Qdrant + Postgres（默认一并启动）
  apps/web/            # Northline 工作台
  apps/api/            # FastAPI + LangGraph
  docs/                # 计划与设计
```

## 一键启动

本机开发（仅基础设施）：

```bash
cd MeriKnow
docker compose up -d
# Qdrant :6333 · Postgres :5432 · Redis :6379

# Control Plane schema（只创建 PostgreSQL app schema）
cd apps/web
cp -n .env.example .env.local
pnpm install
pnpm db:migrate
pnpm db:bootstrap

cd apps/api
cp -n .env.example .env
# DATABASE_URL + METADATA_BACKEND=postgres 必填
uv sync
uv run uvicorn app.main:app --reload --port 8000

# 另开终端
cd apps/web
pnpm dev
```

私有化客户式安装（Compose 全栈参考拓扑、迁移、备份恢复）：见
[`deploy/README.md`](./deploy/README.md) 与
[`docs/runbooks/private-deployment.md`](./docs/runbooks/private-deployment.md)。

- 工作台：<http://localhost:3000/app>
- 同源健康检查：`GET http://localhost:3000/api/rag/health`
- 档案：`GET /v1/archive` · 页面 `/app/archive`

浏览器只访问 Next.js 的 `/api/rag/*`。私有化生产设置同一随机密钥：

```bash
# apps/web/.env.local
MERIKNOW_INTERNAL_SECRET=...
MERIKNOW_SESSION_SECRET=...
MERIKNOW_ADMIN_PASSWORD=...

# apps/api/.env
APP_ENV=production
INTERNAL_AUTH_ENABLED=true
INTERNAL_AUTH_SECRET=...
INTERNAL_AUTH_REPLAY_BACKEND=redis
```

浏览器使用 HttpOnly 签名 Session。Next.js 每次请求都会重新校验用户、
Workspace membership 与用户组，再向 FastAPI 签发一次性内部上下文；
无有效 Session 时所有业务接口统一返回 401。

> **生产安全边界：** `APP_ENV=production`、`INTERNAL_AUTH_ENABLED=true` 和
> Redis replay protection 缺一不可。FastAPI 只允许部署在内部网络并仅向
> Next.js 与 worker 开放；不得把 `:8000` 直接暴露给用户或公网。默认的
> development 配置允许本地直连，只能用于开发。

## 能力一览

- **文库上传**：显示名 + txt/md/docx/pdf → 结构优先切片 → 索引状态 → 问答
- **流式问答**：SSE；答案内 `[n]` 可点；证据 chip 带片段预览；抽屉可显示章节路径
- **拒答**：无命中 / 弱相关
- **Session rewrite**、可选 **rerank** / **BM25+RRF 混合检索**
- **档案回看**：ask 完成后写入 turns（Postgres 或 JSON）

## 文档入库管线（v2）

默认 `INGEST_PIPELINE=v2`：格式分流 → Document IR → **结构感知切片**（非全库 SemanticChunker）→ preamble+body 向量化，UI 展示 body。

| 变量 | 说明 |
|------|------|
| `INGEST_PIPELINE` | `v2`（默认）或 `legacy` 字窗 |
| `PDF_SCAN_STRATEGY` | `partial`（默认）成功页入库；`fail` 更严 |
| `OCR_ENABLED` / `VLM_ENABLED` | 默认关；扫描/复杂页按需 |
| `TOOL_ASK` | 默认 `false`；短路径 ask，工具见 `app/services/ingest/tools.py` |
| `DOCUMENT_LIFECYCLE_V2` | Next 原生 Markdown 上传与 PostgreSQL Job；production 需显式设为 `true` |
| `DOCUMENT_STORAGE_ROOT` | 私有部署共享原文目录；production 必填，`web` 与 lifecycle worker 共同挂载 |
| `DOCUMENT_MAX_UPLOAD_BYTES` | 单文件上限，默认 50 MiB |
| `WORKER_DATABASE_URL` | Python lifecycle worker 专用 PostgreSQL 登录，授予 `meriknow_worker` |
| `LIFECYCLE_WORKER_LEASE_SECONDS` / `LIFECYCLE_WORKER_HEARTBEAT_SECONDS` | 默认 120 / 30 秒 |
| `ACTIVE_GENERATION_GATE_ENABLED` | production 必须开启，检索以 PostgreSQL active generation 为准 |
| `ACTIVE_GENERATION_CACHE_TTL_SECONDS` | production 必须为 `0`，避免激活切换读取旧快照 |
| `RAG_READ_DATABASE_URL` | FastAPI 检索门禁专用只读 PostgreSQL 登录 |
| `MINERU_ENABLED` / `MINERU_URL` | 扫描、双栏和复杂表 PDF 解析；production 开启时 URL 必填 |

## 架构设计

- 企业级 RAG SaaS 目标架构：[docs/architecture/enterprise-rag-saas-design.md](./docs/architecture/enterprise-rag-saas-design.md)
- Control Plane 决策：[docs/adr/0004-nextjs-control-plane.md](./docs/adr/0004-nextjs-control-plane.md)
- 私有化生产落地计划：[docs/plans/2026-07-24-private-deployment-production-roadmap.md](./docs/plans/2026-07-24-private-deployment-production-roadmap.md)

## live 提示

```bash
ASK_MODE=live
DASHSCOPE_API_KEY=...   # 或 OPENAI_API_KEY
# 可选
# HYBRID_ENABLED=true
# RERANK_ENABLED=true
```

```bash
cd apps/api
uv run pytest
# 黄金集（约 39 条：含内存 Qdrant、section/table 隔离、ingest_http）
uv run python scripts/run_eval_cases.py
```

## 当前实施路线

以 [私有化生产落地计划](./docs/plans/2026-07-24-private-deployment-production-roadmap.md)
为唯一执行入口；解析、分块和检索的长期设计保留在企业 RAG 主蓝图与 ADR 中。
