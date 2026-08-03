# 当前验收证据

本目录只保留当前 TypeScript 运行时仍有参考价值的版本绑定证据：

| 报告 | 证明范围 |
|---|---|
| [TS RC 空环境验收](./2026-08-02-ts-rc-clean-install-e2e.md) | 安装、真实文件、浏览器、隔离、恢复和质量矩阵 |
| [MinerU 302.AI 实链路](./2026-08-02-ts-mineru-302-live.md) | DBOS Worker 到 302.AI MinerU 的扫描 PDF 入库 |

报告只证明其记录的 commit、配置和环境。报告中的测试数量是当时快照，不是当前仓库的动态状态。
当前版本必须重新执行 [发布与验收流程](../RELEASE.md)。

2026-07-25 至 2026-07-30 的 FastAPI、Python Worker、outbox 和 Webch 过渡期报告已从当前
文档树移除，仍可通过 Git 历史查看。它们不能用于证明现在的 TypeScript 运行时已经通过验收。
