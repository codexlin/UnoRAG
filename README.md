# MeriKnow

**有据可依的企业知识问答。**

新起点：融合 [DustyKB](https://github.com/codexlin/DustyKB) 的产品与工程经验，以及 QueryNest 的多步 Agent 编排思路；后端将采用 **LangChain + LangGraph（Python）**，前端为本仓库 `apps/web`。

## 技术栈（Phase 0）

| 层 | 选型 |
|----|------|
| Web | Next.js · pnpm · Tailwind CSS · shadcn/ui · Biome |
| API（后续） | FastAPI · LangChain · LangGraph · Qdrant · Postgres |

## 仓库结构

```text
MeriKnow/
  apps/web/     # Next.js 前端
  apps/api/     # 后续 Python API
  docs/plans/   # 计划文档
```

## 本地开发

```bash
pnpm install
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000)。

```bash
pnpm --filter web lint    # biome check
pnpm --filter web format  # biome write
```

## 计划

见 [docs/plans/2026-07-22-meriknow-bootstrap.md](./docs/plans/2026-07-22-meriknow-bootstrap.md)。

## 与旧项目关系

- **DustyKB**：个人/小团队作品集，可继续演示；能力将择优迁入 MeriKnow。
- **QueryNest**：Agent 式 RAG 参考实现；MeriKnow 用 LangGraph 对齐其编排行为并补企业壳。
