# UnoRAG 文档索引

## 北极星（先读）

| 文档 | 内容 |
|------|------|
| [PRODUCT.md](./PRODUCT.md) | 产品定位、目标客户、使用方式、商业路径、边界与成功标准 |
| [STATUS.md](./STATUS.md) | 与代码对应的已完成 / 部分完成 / 规划中能力矩阵 |
| [ROADMAP.md](./ROADMAP.md) | 近中远期、开始前 checklist、交付优先级 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 控制面 / 数据面、入库、会话、Ask 流水线 |
| [INTEGRATION.md](./INTEGRATION.md) | Knowledge API：已实现 vs 规划中契约 |
| [contracts/retrieve-ask-v1.md](./contracts/retrieve-ask-v1.md) | Retrieve/Ask 公共 API v1 冻结契约 |
| [DEV.md](./DEV.md) | 本地启动与 env 分层 |
| [HANDOFF.md](./HANDOFF.md) | 接手阅读顺序、代码连接、测试体系与仓库清理规则 |

仓库根 [README.md](../README.md) / [README.zh-CN.md](../README.zh-CN.md)
是英文 / 中文产品入口。

## ADR（已接受决策）

| ADR | 主题 |
|-----|------|
| [0001](./adr/0001-ocr-vlm-adapters.md) | OCR / VLM 适配器 |
| [0002](./adr/0002-mineru-complex-pdf.md) | MinerU 复杂 PDF |
| [0003](./adr/0003-policy-driven-chunking.md) | 策略化切分 |
| [0004](./adr/0004-nextjs-control-plane.md) | Next 控制面 + Python 数据面 |
| [0005](./adr/0005-typescript-core-runtime.md) | TypeScript 核心运行时迁移（已接受，尚未切换） |

## Runbooks / 验收 / 设计

| 目录 | 用途 |
|------|------|
| [runbooks/](./runbooks/) | 私有化部署、lifecycle 迁移、质量门禁、试点操作 |
| [ops/cicd.md](./ops/cicd.md) | CI、四镜像发布、digest manifest 与升级闭环 |
| [acceptance/](./acceptance/) | 试点 go/no-go、production-ready 清单与历史验收证据 |
| [case-studies/](./case-studies/) | 真实问题复盘、根因分析、修复设计与面试叙事 |
| [design/northline-theme.md](./design/northline-theme.md) | UI 主题 Northline |
