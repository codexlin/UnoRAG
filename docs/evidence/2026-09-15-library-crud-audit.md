# Library CRUD 审计验收

- 日期：2026-09-15（Asia/Shanghai）
- 实现提交：`049d29d`
- 分支：`feat/library-crud-audit`
- 环境：本地 Docker Compose，真实 PostgreSQL 17、Qdrant、Redis、DBOS Worker 与 Chromium
- 结论：**Library CRUD 审计、同步/异步删除关联和浏览器下钻通过**

本报告只证明以上提交与本地参考拓扑。它不是新版本发布、香港环境升级或任意客户环境认证。测试使用临时
知识库和仓库内 `testdata/txt/plain.txt`，验收结束后业务对象已通过产品删除链路清理；凭据和正文未写入报告。

## 实现边界

Library 生命周期使用以下稳定动作：

| 动作 | 事务边界 | 关键字段 |
|---|---|---|
| `library.created` | 与 Library INSERT 同事务 | library ID、名称、策略、策略版本 |
| `library.updated` | 加锁读取、更新与审计同事务 | 变更字段、前后策略、策略版本 |
| `library.delete_requested` | 与 tombstone 和 delete jobs 同事务 | 文档数、入队数、同步/异步标记 |
| `library.deleted` | 空库请求事务或最后一个 DBOS 删除事务 | 原操作者、Request ID、job/document ID、完成来源 |
| `library.delete_failed` | DBOS 失败终态事务 | 稳定错误码、截断原因、job/document ID、完成来源 |

所有查询和锁都绑定 Organization、Workspace 与 Library；Worker 只新增 `app.audit_logs` 的 SELECT/INSERT
权限。描述正文不进入审计，更新只记录 `description.changed=true`；请求头、错误原因和摘要均有长度上限。
终态事件使用 `NOT EXISTS` 防止 DBOS 重放生成重复审计。

## 自动化结果

| 门禁 | 结果 |
|---|---|
| Node 单元测试 | 224 total，223 passed，1 个外部环境用例按设计 skipped，0 failed |
| TypeScript Core | 379 total，353 passed，26 个环境型用例按设计 skipped，0 failed |
| 真实 PostgreSQL 删除专项 | 8/8 passed，覆盖并发终结、重放、失败幂等和跨作用域防护 |
| 静态质量 | TypeScript、Biome、生产构建 passed |
| 数据库角色 | `unorag_worker` 的 audit SELECT/INSERT 配置与运行时验证 passed |

真实 PostgreSQL 专项使用独立临时数据库应用完整 Drizzle migration 和运行时角色脚本；测试结束后数据库和
临时端口转发容器均已删除。

## 浏览器验收

真实浏览器完成两组产品操作：

1. 创建空知识库，修改名称、描述和文档策略，再执行同步删除；
2. 创建知识库，通过页面上传真实 `plain.txt`，等待状态变为 1/1 可检索，再执行 202 异步删除；
3. 等待 DBOS Worker 清理向量、原文和元数据，页面回到 0 个知识库；
4. 在操作记录中分别按动作、名称和 Library ID 检索并打开详情。

验收确认：

- 创建和更新分别返回 201、200；真实文件上传和异步删除均返回 202；
- 空库的 `delete_requested` 与 `deleted` 共享 Request ID；
- 带文件删除的 Worker 终态继承原操作者、Request ID 和来源 IP；
- 最终事件包含可搜索名称、job ID、document ID 与 `completion_source=dbos_worker`；
- 更新详情包含 `changed_fields` 和策略前后值，但不包含用于测试的描述正文；
- 页面成功提示、知识库计数、文档就绪状态与审计终态一致。

浏览器首次登录发现本地数据库落后于当前应用 migration，表现为缺少 `must_change_password` 字段。应用完整
迁移并重新验证运行时角色后恢复，随后完成以上验收。这属于本地环境版本漂移，也再次证明升级流程必须坚持
先迁移、再配置角色、最后启动新运行时。

## 剩余边界

- `library.delete_failed` 已通过真实 PostgreSQL 事务测试验证幂等和关联字段，本次浏览器成功路径没有故意破坏
  Qdrant 或对象存储；故障注入应在独立发布候选环境执行。
- 本提交未改变公开 v1 API，也未发布新镜像或部署香港环境。
- 历史 `v0.1.4` 报告中“CRUD 审计尚未补齐”是该版本当时的准确边界，不应回写历史报告。
