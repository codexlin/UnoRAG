# 当前验收证据

本目录只保留当前 TypeScript 运行时仍有参考价值的版本绑定证据：

| 报告 | 证明范围 |
|---|---|
| [RC.18 LLM 背压与容量验收](./2026-08-22-rc18-llm-backpressure.md) | 共享且可取消的 LLM 并发门、队列与 provider 独立超时、真实容量校准、Qdrant 逐 minor 升级和复杂 PDF 入库 |
| [RC.14 COS 与容量基线](./2026-08-22-rc14-cos-capacity.md) | 空环境 COS 安装、产品全链路、Retrieve/Ask/入库阶梯并发和真实 302.AI MinerU 图表 PDF |
| [RC.12 生产候选验收](./2026-08-12-rc12-production-acceptance.md) | 精确 digest 发布、RC.11 生产问题修复、三轮真实文件稳定性、浏览器 Workspace 隔离、备份 overlay、故障恢复及版本回退前滚 |
| [UnoRAG-HK RC.8 主机验收](./2026-08-10-unorag-hk-production-acceptance.md) | HK 独立主机安装、真实 MinerU 文件矩阵、质量门禁、破坏性恢复与整机重启 |
| [Registry RC.7 Tombstone 生命周期验收](./2026-08-06-registry-rc7-tombstone-validation.md) | Node 24 Actions、tombstone 保留与回收、最小权限以及 RC.6 原地升级 |
| [Registry RC.6 平台合同与发布性能验收](./2026-08-06-registry-rc6-platform-validation.md) | manifest 平台预检、镜像瘦身、构建缓存与 RC.5 原地升级 |
| [Registry RC.5 不可变发布验收](./2026-08-05-registry-rc5-validation.md) | 双 Registry digest、空环境安装、真实浏览器、升级与回滚 |
| [TS RC 4829e41 全量复验](./2026-08-04-ts-rc-4829e41-full-validation.md) | 当前分支的确定性测试、四镜像、原地升级、真实文件、浏览器与故障恢复 |
| [TS RC 空环境验收](./2026-08-02-ts-rc-clean-install-e2e.md) | 安装、真实文件、浏览器、隔离、恢复和质量矩阵 |
| [MinerU 302.AI 实链路](./2026-08-02-ts-mineru-302-live.md) | DBOS Worker 到 302.AI MinerU 的扫描 PDF 入库 |

报告只证明其记录的 commit、配置和环境。报告中的测试数量是当时快照，不是当前仓库的动态状态。
当前版本必须重新执行 [发布与验收流程](../RELEASE.md)。

2026-07-25 至 2026-07-30 的 FastAPI、Python Worker、outbox 和 Webch 过渡期报告已从当前
文档树移除，仍可通过 Git 历史查看。它们不能用于证明现在的 TypeScript 运行时已经通过验收。
