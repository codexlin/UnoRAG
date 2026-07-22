# MeriKnow 实施计划

> **产品名：** MeriKnow  
> **一句话：** 有据可依的企业知识问答——融合 DustyKB 的可上线体验与 QueryNest 的多步 Agent 编排，技术栈以 LangChain + LangGraph（Python）减少胶水代码。  
> **仓库：** `git@github.com:codexlin/MeriKnow.git`（本地 `/Users/codexlin/codexlin/rag-py/MeriKnow`）

## 目标与非目标

### 目标（MVP → 企业）

- 文档入库 → 混合检索 / Rerank → 流式问答 + 引用  
- LangGraph 编排：改写 → 检索 → 判断 → 重试 → 生成 → 校验  
- Session 短记忆；弱相关 / 无命中拒答  
- 企业向演进：RBAC、审计、可靠任务队列  

### 非目标（第一期不做）

- 不做全能 Dify 替代品  
- 不做一上来的多租户 SaaS 计费  
- 不把前端写成 Agent 运行时（编排在 Python API）

## 技术栈

| 层 | 选型 |
|----|------|
| Web | Next.js · pnpm · Tailwind · shadcn/ui · Biome |
| API | FastAPI · LangChain · LangGraph · Qdrant · Postgres（后续脚手架） |
| 参考 | DustyKB（产品/拒答/部署）· QueryNest（图编排/记忆） |

## 仓库结构（目标）

```text
meridian/   # 本地目录名；远程仓库 MeriKnow
  apps/
    web/          # Next.js（本阶段已落地）
    api/          # FastAPI + LangGraph（下一阶段）
  docs/
    plans/        # 计划与决策
  README.md
  pnpm-workspace.yaml
```

## 阶段

### Phase 0 — 脚手架（当前）

- [x] 定名 MeriKnow  
- [x] pnpm workspace + `apps/web`（Next.js App Router）  
- [x] Tailwind + shadcn/ui + Biome  
- [x] 基础 README / 首页占位  
- [x] GitHub remote：`codexlin/MeriKnow`  

### Phase 1 — 可演示问答壳

- [x] `/app` 工作台壳（侧栏 · 顶栏 · Northline）  
- [x] 问答台 + 证据抽屉（流式 + `[n]` 联动）  
- [x] 文库上传 / 显示名 / 文档列表  
- [x] 档案回看（`/app/archive` · `GET /v1/archive`）  
- [x] 对接 API 健康检查与问答（`/health` · `/v1/ask` · `/v1/ask/stream`）  

### Phase 2 — LangGraph 内核

- [x] `apps/api` 脚手架：FastAPI · CORS · settings · stub/live 图  
- [x] LangChain 兼容 chat/embeddings；切分（500/80）；Qdrant 检索；ingest/upload  
- [x] LangGraph：rewrite → retrieve → judge → retry → generate/refuse  
- [x] Session 短记忆 + 追问 rewrite  
- [x] 弱相关 / 无命中策略（`ANSWER_MIN_SCORE`）  
- [x] 可选 Rerank / BM25+RRF 混合检索  
- [x] 默认 Postgres 元数据 + turns；JSON 降级  

### Phase 3 — 企业壳

- [ ] SSO/RBAC、审计日志、索引队列  
- [ ] 评测抽检、连接器 / OCR（按需；OCR/VLM 适配器已落地，默认关闭）  
- [x] 文档解析与索引管线（IR / 结构优先切片 / 多格式）→ 见 [2026-07-23-document-ingest-pipeline.md](./2026-07-23-document-ingest-pipeline.md)

## 成功标准（当前）

- stub 可问答 / 拒答；live + 密钥 + Qdrant 可上传问答  
- 引用展示为可读显示名 + 片段预览；答案 `[n]` 可点  
- `docker compose up -d` 起 Qdrant + Postgres；health 显示 `metadata_backend`  
- `uv run pytest` 通过  

## 风险

- 过早堆满 Graph 节点导致无 UI —— Phase 0–1 先壳后核  
- 与 DustyKB 双线维护 —— DustyKB 仅作作品集，主线仅 MeriKnow  
