# 架构决策索引

ADR 解释长期取舍，不是操作手册。当前实现先读 [系统架构](../ARCHITECTURE.md)，能力与限制先读 [当前状态](../STATUS.md)。

## 当前决策

| 决策 | 适用范围 |
|---|---|
| [0002 MinerU complex PDF](./0002-mineru-complex-pdf.md) | MinerU 解析策略；实现已迁至 TypeScript ParserProvider |
| [0003 Policy-driven chunking](./0003-policy-driven-chunking.md) | 结构优先、递归上限、受控语义切分与表格 profile |
| [0005 TypeScript core runtime](./0005-typescript-core-runtime.md) | 运行时所有权、DBOS 与数据边界；迁移步骤属于已完成的历史 |
| [0007 Fully open-source product](./0007-fully-open-source-product-and-services.md) | 单一完整开源产品，无商业功能墙 |

当前仓库保持单根 TypeScript package。只有真实独立构建边界或多个消费者出现时才提取 package，
没有已排期的 monorepo 迁移；数据库迁移始终只有一个所有者。

## 历史决策

已替代正文退出当前目录，固定在清理前提交中；不删除 Git 历史，不把历史命令当作现行指引。

| 决策原文 | 被什么替代 |
|---|---|
| [0001 OCR / VLM adapters](https://github.com/codexlin/UnoRAG/blob/6918b7596f77974cc036c15a3f3140aa89a95aef/docs/adr/0001-ocr-vlm-adapters.md) | ADR-0002/0005 的 ParserProvider |
| [0004 Next.js + Python data plane](https://github.com/codexlin/UnoRAG/blob/6918b7596f77974cc036c15a3f3140aa89a95aef/docs/adr/0004-nextjs-control-plane.md) | ADR-0005 的 TS-only 运行时 |
| [0006 Private product monorepo](https://github.com/codexlin/UnoRAG/blob/6918b7596f77974cc036c15a3f3140aa89a95aef/docs/adr/0006-private-product-monorepo.md) | ADR-0007 的完整开源方向；不是待实施路线图 |

## 维护规则

- 只有影响长期架构取舍的新决策才新增 ADR；普通重构更新开发指南，不另建蓝图。
- 不重写已发布正文；允许增加状态和后继链接。决策完全失效后，在本索引保留固定提交链接。
- 当前事实和历史设计有冲突时，以代码及现行指南为准，并明确标注 ADR 的适用范围。
