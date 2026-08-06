# UnoRAG 文档

这里记录当前产品，而不是开发过程。第一次接触 UnoRAG，先读现状，再按职责进入具体文档。

## 产品文档

| 文档 | 回答的问题 |
|---|---|
| [STATUS.md](./STATUS.md) | 当前已经具备什么、尚缺什么、下一步按什么顺序推进？ |
| [PRODUCT.md](./PRODUCT.md) | UnoRAG 为谁服务、解决什么问题、当前能交付到什么程度？ |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 系统如何划分职责，权限、版本、解析、检索和问答如何工作？ |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | 如何在客户环境安装、升级、回滚和恢复？ |
| [INTEGRATION.md](./INTEGRATION.md) | 外部系统如何使用 Service Key 调用 Retrieve / Ask？ |
| [OPERATIONS.md](./OPERATIONS.md) | 如何监控生命周期、备份数据、处理故障和发布镜像？ |
| [RELEASE.md](./RELEASE.md) | 一个版本怎样通过质量、安全和客户环境验收？ |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | 如何开发、测试和维护仓库？ |
| [OPEN_SOURCE_READINESS.md](./OPEN_SOURCE_READINESS.md) | 公开仓库前还有哪些安全、许可和权属门禁？ |

机器可读的公开接口以 [Retrieve / Ask v1 契约](./contracts/retrieve-ask-v1.md) 为准。
根目录 [README](../README.md) 和 [中文 README](../README.zh-CN.md) 是对外产品入口。

## 决策与证据

- [ADR 索引](./adr/README.md) 区分当前、已实现、已迁移和被替代的架构决策；历史 ADR 不是操作手册。
- [`evidence/`](./evidence/) 保存与特定提交、镜像、配置和环境绑定的当前验收证据。
- 已退役 Python/FastAPI 和过渡架构报告只保留在 Git 历史中，不作为当前操作说明。

文档中的“已实现”描述代码能力；“已验收”只适用于证据中明确绑定的版本和环境。
客户生产上线仍须按照 [RELEASE.md](./RELEASE.md) 完成目标环境签字。

设计提案不进入上面的正式产品文档表，也不自动成为交付承诺。已确认方向但尚未完整实现的方案由相关
正式文档（如 [OPERATIONS.md](./OPERATIONS.md)）交叉引用，并在下方集中列出。

设计与演进说明：

- [Uno 品牌系统](./brand/uno-brand-system.md)：母品牌图形、产品命名、颜色、尺寸与资产规则；
- [可观测性架构](./design/observability.md)：已落地的核心原生、可选 Ops 与 Langfuse 三层方案；
- [Langfuse AI 工程接入](./LANGFUSE.md)：metadata-only 双出口、密钥边界、启用和故障排查；
- [质量评测与 Prompt 生命周期](./EVALUATION.md)：仓库黄金集、Prompt Registry、发布门禁和可选分数发布；
- [混合检索演进设计](./design/hybrid-retrieval.md)：应用层 BM25、ACL 缓存风险与 Qdrant sparse 评测门禁。
