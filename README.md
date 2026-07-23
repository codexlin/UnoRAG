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

计划详情：[docs/plans/2026-07-23-document-ingest-pipeline.md](./docs/plans/2026-07-23-document-ingest-pipeline.md)

## 架构设计

- 企业级 RAG SaaS 目标架构：[docs/architecture/enterprise-rag-saas-design.md](./docs/architecture/enterprise-rag-saas-design.md)

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
# 黄金集（约 38 条：含内存 Qdrant、section/table 隔离、ingest_http）
uv run python scripts/run_eval_cases.py
```

## 计划

见 [docs/plans/2026-07-22-meriknow-bootstrap.md](./docs/plans/2026-07-22-meriknow-bootstrap.md) · [文档入库管线](./docs/plans/2026-07-23-document-ingest-pipeline.md)。
