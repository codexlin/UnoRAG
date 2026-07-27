# MeriKnow 文档索引

## 北极星（先读）

| 文档 | 内容 |
|------|------|
| [PRODUCT.md](./PRODUCT.md) | 一句话定位、使用方式、边界、成功标准 |
| [STRATEGY.md](./STRATEGY.md) | 产品层级、目标客户、首发场景、商业化与面试叙事 |
| [ROADMAP.md](./ROADMAP.md) | 近中远期、开始前 checklist、交付优先级 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 控制面 / 数据面、入库、会话、Ask 流水线 |
| [architecture/convergence-plan.md](./architecture/convergence-plan.md) | 事实源收敛、兼容路径、Step 1 backlog（临近私有化） |
| [INTEGRATION.md](./INTEGRATION.md) | Knowledge API：已实现 vs 规划中契约 |
| [contracts/retrieve-ask-v1.md](./contracts/retrieve-ask-v1.md) | Retrieve/Ask 公共 API v1 冻结契约 |
| [DEV.md](./DEV.md) | 本地启动与 env 分层 |

仓库根 [README.md](../README.md) 是入口摘要。

## ADR（已接受决策）

| ADR | 主题 |
|-----|------|
| [0001](./adr/0001-ocr-vlm-adapters.md) | OCR / VLM 适配器 |
| [0002](./adr/0002-mineru-complex-pdf.md) | MinerU 复杂 PDF |
| [0003](./adr/0003-policy-driven-chunking.md) | 策略化切分 |
| [0004](./adr/0004-nextjs-control-plane.md) | Next 控制面 + Python 数据面 |

## Runbooks / 验收 / 设计

| 目录 | 用途 |
|------|------|
| [runbooks/](./runbooks/) | 私有化部署、lifecycle 迁移、质量门禁、试点操作 |
| [acceptance/](./acceptance/) | L9 试点 go/no-go 与 production-ready 清单 |
| [case-studies/](./case-studies/) | 真实问题复盘、根因分析、修复设计与面试叙事 |
| [design/northline-theme.md](./design/northline-theme.md) | UI 主题 Northline |

## 已删除的过时文档

| 原路径 | 原因 |
|--------|------|
| `docs/architecture/enterprise-rag-saas-design.md` | 能力盘点与差距已过时；由 PRODUCT + ARCHITECTURE + ROADMAP 替代 |
| `docs/plans/2026-07-24-private-deployment-production-roadmap.md` | 文首现状描述已不符（ARQ/代理入库）；完成项以代码为准，缺口并入 ROADMAP |
