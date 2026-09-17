# Library 删除故障恢复验收

- 日期：2026-09-17
- 分支：`feat/library-delete-fault-drill`
- 环境：本地隔离 Docker Compose、真实 PostgreSQL / Qdrant / Redis、DBOS Worker、浏览器产品链路
- 结论：**Qdrant 与对象存储删除故障均能诊断、告警、重试并完成最终清理**

## 验收范围

两轮均通过产品页面创建知识库并上传仓库真实文件 `testdata/txt/plain.txt`，等待索引就绪后从知识库设置
发起删除。故障通过真实依赖边界注入，不直接修改任务终态：

| 场景 | 注入方式 | 首次终态 | 恢复动作 | 最终结果 |
|---|---|---|---|---|
| Qdrant 删除失败 | 停止 Qdrant 容器，等待 DBOS 有界重试耗尽 | `document_delete_qdrant_failed` | 恢复 Qdrant，在运行中心点击“重试清理” | 新任务完成，generation 与 Library tombstone 完成清理 |
| 原文件删除失败 | 将本地对象目录设为 Worker 不可写，保留真实文件 | `document_delete_storage_failed` | 恢复目录权限，在运行中心点击“重试清理” | 新任务完成，原文件实际消失，Library 与 Document 进入 `deleted` |

## 产品侧证据

- 运行中心把仍拥有 `deleting` 文档的终态删除任务计入“待恢复删除”，不会把已经被新任务接管的历史
  失败继续计为待处理；
- `jobs.delete_failed` 以 critical 级别进入持久告警，恢复说明直接指向“最近错误”和“重试清理”；
- 最近错误抽屉分别展示“向量清理失败”和“原文件清理失败”、稳定错误码、脱敏原因、Request / Workflow /
  Job / 文档版本 ID 以及完整阶段瀑布；
- 管理员或 Workspace owner 可从抽屉创建新的 DBOS 任务；旧任务写入 `retry_job_id`，新任务写入
  `job.retried` 审计，重复点击由文档 `latest_job_id` CAS 拒绝；
- 两轮 `library.delete_failed` 与后续 `library.deleted` 均保留原请求关联，历史错误不会因恢复而删除。

## 数据与隔离约束

- 重试 payload 只从 PostgreSQL 已持久化的 Document / Version / Library 范围重建，不接受浏览器传入的
  tenant、文档 ID、generation ID 或 storage key；
- API 强制 organization/workspace 授权和管理员级权限；CLI 与页面共用同一事务状态机；
- advisory lock、行锁和 `latest_job_id` compare-and-swap 防止并发重试创建两个有效 owner；
- 报告不记录认证凭据、原文正文、Prompt 或模型输入输出。

## 自动化回归

真实 PostgreSQL 测试覆盖：失败任务可恢复计数、新任务接管后计数归零、旧任务 lineage、重试审计和
过期 predecessor 拒绝。

| 检查 | 结果 |
|---|---|
| 基础 Node 测试 | 224 tests，223 pass，1 个无数据库配置用例按预期 skip，0 fail |
| TS Core | 380 tests，353 pass，27 个可选集成用例按预期 skip，0 fail |
| 真实 PostgreSQL / Qdrant / Redis 集成 | 53/53 pass |
| Biome | 452 files，0 error |
| TypeScript | `tsc --noEmit` pass |
| 生产镜像构建 | Web 与 DBOS Worker pass |
| 浏览器 | 桌面与 390px 移动视口通过；恢复后待恢复删除、dead/stuck 和活动告警均为 0 |

本机沿用了较早的 Qdrant 1.13 数据卷，1.19 客户端会打印兼容性告警；实际读写、ACL、删除和恢复测试均
通过。正式安装应使用仓库当前固定的同 minor Qdrant 镜像，避免把本地旧环境告警带入发布环境。

## 清理

两座临时知识库均通过恢复后的产品状态机完成删除；对象存储测试文件已确认不存在，Qdrant 已恢复健康。
临时代理容器在测试结束后删除。本验收未修改香港环境或任何客户数据。
