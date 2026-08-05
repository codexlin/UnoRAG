# Registry RC.7 Tombstone 生命周期验收

## 结论

`v0.1.0-rc.7` 通过 Node 24 Actions、tombstone 保留/清理、最小权限、不可变镜像发布和
`rc.6 -> rc.7` 原地升级验收。默认策略每小时以 100 行为一批，仅物理回收超过 90 天且外部清理已
终结的删除文档；仍被文档、会话或 Ask 记录引用的库保持 `blocked`，不会破坏历史链路。

本次 Apple Silicon 验收继续通过显式 `linux/amd64` 产品服务 overlay 运行，只证明功能和升级合同，
不构成 ARM 支持或生产容量结论。

## 版本绑定

| 项目 | 值 |
|---|---|
| Release | `v0.1.0-rc.7` |
| Git commit | `501da316bfde10a3` |
| Pull request | [#8](https://github.com/codexlin/UnoRAG/pull/8) |
| Main CI | [31029635291](https://github.com/codexlin/UnoRAG/actions/runs/31029635291) |
| Release run | [31030162675](https://github.com/codexlin/UnoRAG/actions/runs/31030162675) |
| DBOS application version | `unorag-501da316bfde10a3` |
| Image platform | `linux/amd64` |
| ACR manifest | [release-acr.env](./releases/v0.1.0-rc.7/release-acr.env) |
| GHCR manifest | [release-ghcr.env](./releases/v0.1.0-rc.7/release-ghcr.env) |

ACR 与 GHCR 的四个目标引用相同 digest，四张 Trivy HIGH/CRITICAL 扫描全部通过。Release workflow
使用 checkout v7、Docker login/buildx v4、build-push v7 和 upload-artifact v7；主 CI 四项通过，
未再出现 Node 20 action 运行时警告。

## 清理合同

- CLI 默认 dry-run；自动 control 周期默认启用，保留 90 天、每小时执行、单批最多 100 行。
- 文档只有处于 `deleted`、超过保留期且所有 generation cleanup 均为 `deleted` 时才能进入候选。
- 事务使用 `FOR UPDATE SKIP LOCKED`，并锁定 cleanup 行；多 control 副本不会互相等待或重复回收。
- 删除前清空 document version/job 指针，随后由已验证的外键级联回收 versions、jobs、ACL 和 cleanup。
- 每个物理删除动作先写 `document.tombstone_purged` 或 `library.tombstone_purged` 审计事件。
- 删除库前再次确认不存在 documents、threads 和 ask_runs；历史会话仍在时只报告 blocked。
- Worker 仅新增执行所需的 `SELECT app.threads` 与 `DELETE app.documents/app.libraries` 权限。

全新迁移数据库中，repository 以真实 `unorag_worker` 登录完成锁竞争、级联、审计与空库回收测试，
2/2 通过；服务/CLI 单元回归 3/3 通过。全量 lint、typecheck、Node tests、TS core tests、Next build、
Drizzle check、Compose config 和 Helm lint/template 均通过。

## 原地升级

隔离项目 `unorag_rc_clean` 在 `http://localhost:8091` 从 RC.6 升级到 RC.7：

1. 旧 application 与 DBOS workflow 四次 drain 均为 0 后进入维护窗口。
2. 向前迁移和 runtime role verification 通过，Worker/Control/Web/Edge 健康恢复。
3. Control 首轮自动执行 tombstone maintenance：documents、libraries、blocked 均为 0，无失败。
4. Pilot smoke 通过上传、Ask、Public Retrieve/Ask、Service Key scope/撤销、跨库隔离、replace、delete。
5. RC.6 的“Registry RC 验收库”及其 ready 文档继续存在，readiness 为 `degraded=false`。

smoke 后巡检结果：`dead_jobs=0`、`stuck_jobs=0`、`deleting_documents=0`、`cleanup_errors=0`、
`libraries_deleting=0`、`expired_document_tombstones=0`、`expired_library_tombstones=0`、
`blocked_library_tombstones=0`、`pending_acl_projections=0`。

## 后续

下一阶段不再扩展生命周期机制。应在客户等价 `linux/amd64` 主机执行容量基线、P50/P95、并发、
磁盘水位和备份恢复演练，并据此定义可承诺的单节点 SLO 与扩容阈值。
