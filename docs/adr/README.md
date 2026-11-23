# 架构决策索引

ADR 解释长期取舍，不是操作手册。当前实现先读 [系统架构](../ARCHITECTURE.md)，能力与限制先读 [当前状态](../STATUS.md)。

## 当前决策

| 决策 | 适用范围 | 当前状态与补充 |
|---|---|---|
| [0002 MinerU complex PDF](./0002-mineru-complex-pdf.md) | MinerU 解析策略；实现已迁至 TypeScript ParserProvider | 已实现；含 `2026-11-12` 预算修正与 `2026-11-23` 配置边界补充 |
| [0003 Policy-driven chunking](./0003-policy-driven-chunking.md) | 结构优先、递归上限、受控语义切分与表格 profile | 已采纳；含 `2026-11-23` 中英文 Token 预算演进注记 |
| [0005 TypeScript core runtime](./0005-typescript-core-runtime.md) | 运行时所有权、DBOS 与数据边界；迁移步骤属于已完成的历史 | 已实施；含 `2026-11-23` RLS/历史章节校准注记 |
| [0007 Fully open-source product](./0007-fully-open-source-product-and-services.md) | 单一完整开源产品，无商业功能墙 | 已公开发布；含 `2026-11-23` 分层发版门禁注记 |
| [0008 Qdrant server-side Sparse + RRF](./0008-qdrant-server-side-sparse-rrf.md) | 命名 Dense + 确定性词法 Sparse（`lexical_v1`，`modifier: "idf"`）与 Qdrant 服务端 RRF；已移除应用层 BM25 回退 | 已采纳；含 `2026-11-23` 默认开启评估注记 |

## 架构红线 vs 可演进边界

| 类别 | 具体约束 | 演进态度 |
|---|---|---|
| **不可松动的红线** | 双层权限隔离（Qdrant 前置 Mandatory Filter + `assertAuthorizedHits` 二次熔断）、Staging/Active 原子切换、出域解析显式授权、持久化观测 `metadata-only`、Apache-2.0 无商业功能墙 | 任何新功能不得削弱 |
| **可按评测与体验演进** | 分块从纯字符转向 Token 估算与文档级启发式选档、`hybrid_enabled` 默认值、管理员级预算/调优项上移 UI、客户端能力探针校验、Trace 内存态本人检索透视、分层发版门禁 | 经黄金集/契约测试验证后按小版本演进 |

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
