# UnoRAG 文档

这里是文档的唯一导航入口。不要从目录逐份阅读；先选择角色，再沿一条路径进入。

## 按角色阅读

| 角色 | 从这里开始 | 接下来读 | 目标 |
|---|---|---|---|
| 产品评估者 / 使用者 | [项目介绍](../README.zh-CN.md) | [当前状态](./STATUS.md)、[版本记录](../CHANGELOG.md) | 判断能力、边界与当前成熟度 |
| 部署者 / 运维人员 | [部署指南](./DEPLOYMENT.md) | [运维指南](./OPERATIONS.md)、[发布门禁](./RELEASE.md)、[当前证据](./evidence/) | 完成安装、升级、监控、备份和恢复 |
| 开发者 / 集成方 | [系统架构](./ARCHITECTURE.md) | [开发指南](./DEVELOPMENT.md)、[Knowledge API](./INTEGRATION.md) | 理解边界并安全修改或接入 |
| 项目维护者 | [当前状态](./STATUS.md) | [发布门禁](./RELEASE.md)、[质量评测](./EVALUATION.md)、[ADR 索引](./adr/) | 维护路线、质量和长期决策一致性 |

第一次接触项目只需读同一行，不需要阅读全部文档。

## 文档层级

| 层级 | 内容 | 维护规则 |
|---|---|---|
| 当前事实 | `STATUS`、`ARCHITECTURE`、部署、运维、开发和集成文档 | 行为变化时与代码同一 PR 更新 |
| 稳定契约 | [Knowledge API](./INTEGRATION.md) 与 [`public-api-v1.openapi.json`](../contracts/public-api-v1.openapi.json) | 兼容性变化必须经过版本设计 |
| 长期决策 | [ADR](./adr/) | 已发布正文不重写；通过新 ADR 替代 |
| 验收证据 | [`evidence/`](./evidence/) | 只保留当前稳定版汇总报告 |
| 专项参考 | 品牌规则和目录就近 README | 不自动成为产品承诺，以当前事实文档为准 |

旧版本报告由 Git 历史和 [GitHub Releases](https://github.com/codexlin/UnoRAG/releases) 保存，不在当前树
重复堆积。文档中的“已实现”描述代码能力；“已验收”只适用于证据明确绑定的版本和环境。客户上线仍须
按照 [发布门禁](./RELEASE.md) 完成目标环境签字。

## 专项参考

- [Uno 品牌系统](./brand/uno-brand-system.md)
- [LICENSE](../LICENSE) 与 [TRADEMARKS.md](../TRADEMARKS.md)

根目录 [README](../README.md) 和 [中文 README](../README.zh-CN.md) 是对外产品入口。提交前运行
`pnpm docs:check`，确认本地链接、验收索引和隐私边界没有退化。
