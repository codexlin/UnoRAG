# 当前验收证据

本目录只保留当前稳定版与仍有独立故障诊断价值的证据：

| 报告 | 证明范围 |
|---|---|
| [v0.2.2 Production Hardening 发布验收](./2026-09-20-v0.2.2-production-hardening-release.md) | 告警和公网安全加固、配置分层与运行时清理、四镜像供应链、空环境安装、`0.2.1 -> 0.2.2` 原位升级、三轮真实文件质量、故障恢复、告警开闭环及桌面/移动浏览器复核 |
| [删除故障恢复验收](./2026-09-17-library-delete-fault-recovery.md) | 真实 Qdrant 停机、对象存储删除拒绝、运行中心诊断与告警、页面幂等重试和最终资源清理 |
| [Library CRUD 审计验收](./2026-09-15-library-crud-audit.md) | Library 创建、更新、同步/异步删除审计，Request ID 关联、隐私约束、真实 PostgreSQL 幂等测试与本地 Docker 浏览器链路 |

报告只证明其记录的 commit、配置和环境。报告中的测试数量是当时快照，不是当前仓库的动态状态。
当前版本必须重新执行 [发布与验收流程](../RELEASE.md)。

旧版本、RC 和已经被当前稳定版覆盖的报告只通过 Git 历史与 GitHub Releases 保留，不继续堆积在当前
文档树中。它们不能用于证明当前提交、模型、ParserProvider 或客户环境已经通过验收。
