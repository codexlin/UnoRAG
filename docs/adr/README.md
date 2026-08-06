# Architecture Decision Records

ADR 保存“为什么曾经这样设计”，不等于当前操作手册。当前运行时先读
[`ARCHITECTURE.md`](../ARCHITECTURE.md)，当前能力和缺口先读 [`STATUS.md`](../STATUS.md)。

| ADR | 状态 | 当前意义 |
|---|---|---|
| [0001 OCR / VLM adapters](./0001-ocr-vlm-adapters.md) | 已替代 | Python 原型期 OCR/VLM 选择；当前使用 ParserProvider |
| [0002 MinerU complex PDF](./0002-mineru-complex-pdf.md) | 已迁移 | MinerU 决策仍有效，运行时实现已迁至 TypeScript |
| [0003 Policy-driven chunking](./0003-policy-driven-chunking.md) | 当前有效 | 结构优先、递归上限、受控语义切分与表格 profile |
| [0004 Next.js + Python data plane](./0004-nextjs-control-plane.md) | 已替代 | 只记录过渡架构；不得用于部署或开发 |
| [0005 TypeScript core runtime](./0005-typescript-core-runtime.md) | 已实现 | 当前运行时所有权、进程和数据边界的主要决策 |
| [0006 Private product monorepo](./0006-private-product-monorepo.md) | 大部分已替代 | 私有 edition/entitlement 已失效；仅保留按真实边界提取 package 的原则 |
| [0007 Fully open-source product](./0007-fully-open-source-product-and-services.md) | 当前有效 | 单一完整产品、无功能墙、服务收入与公开发布门禁 |

## 阅读规则

- `Superseded` 的 ADR 只提供历史上下文；其中命令、环境变量和运行拓扑一律不是现行说明。
- 新决策应新增 ADR，不重写已经发布的历史正文；允许在顶部增加状态和后继链接。
- 产品现状变化先更新 `STATUS.md` 和正式文档，ADR 只记录需要长期保留的架构取舍。
- 仓库当前是单根 TypeScript package；没有已排期的 monorepo 迁移。
