# UnoRAG 运维指南

本指南覆盖生产信号、生命周期巡检、故障处理、备份恢复和镜像发布。部署参数与安装步骤见
[DEPLOYMENT.md](./DEPLOYMENT.md)，版本放行条件见 [RELEASE.md](./RELEASE.md)。

## 关联标识

排障时应保留以下字段，并确保日志对敏感内容脱敏：

| 标识 | 用途 |
|---|---|
| `request_id` | 对外稳定的请求关联号，用于报障和业务日志查询 |
| `trace_id` | Retrieve/Ask v1 对 `request_id` 的兼容字段，不是 OTel Trace ID |
| `otel_trace_id` | 一次同步执行的 W3C Trace ID；仅在 OTel 已启用时存在 |
| `job_id` / `workflow_id` | 串联产品任务、DBOS 持久工作流、重试和恢复 |
| `attempt_trace_id` | Worker 每次执行尝试的独立 Trace；通过 Span Link 关联创建请求 |
| `document_id` / `document_version_id` / `generation_id` | 核对 active pointer、对象与向量点 |
| `organization_id` / `workspace_id` | 限定所有查询和运维动作的安全范围 |

## 日常检查

```bash
curl -fsS "$UNORAG_BASE_URL/api/rag/health" | jq .
curl -fsS "$UNORAG_BASE_URL/metrics"
pnpm lifecycle:inspect
pnpm ask-runs:maintain

cd deploy/compose
source scripts/compose-env.sh
mk_compose ps
mk_compose --profile ops run --rm inspect-lifecycle
```

至少监控以下信号：

- Web readiness、Ask 5xx、P50/P95 延迟和并发拒绝；
- DBOS workflow queued/running/dead/stuck、Worker 心跳和重试；
- Parser、Embedding、Rerank、LLM 的错误率、延迟和限额；
- PostgreSQL 连接、锁、容量与备份状态；
- Qdrant readiness、集合容量和检索错误；
- 文档卷、备份卷和宿主机磁盘水位。

UnoRAG 默认提供管理员可见的“运行中心”、低基数 `/metrics`、核心路径 Pino JSON、Ask stages 与
`app.ask_runs` 诊断元数据。运行中心按当前 organization/workspace 强制隔离，展示 Ask 终态、P50/P95、
引用覆盖、dead/stuck 任务和最近错误；不会返回问题、回答、Prompt、引用正文或 Job 错误正文。
分布式追踪、集中日志与外部告警仍属于后续可选 Ops 能力，完整边界见
[design/observability.md](./design/observability.md)。

`dbos-control` 默认每 15 分钟把超过 30 分钟的 `running` Ask 收敛为失败，并按 30 天保留期有界删除
终态记录。以下部署参数可调整或关闭该调度：

```text
ASK_RUN_MAINTENANCE_ENABLED=true
ASK_RUN_MAINTENANCE_INTERVAL_MS=900000
ASK_RUN_STALE_AFTER_MINUTES=30
ASK_RUN_RETENTION_DAYS=30
ASK_RUN_MAINTENANCE_BATCH_SIZE=1000
```

手工命令默认只预览；确认后才执行：

```bash
pnpm ask-runs:maintain
pnpm ask-runs:maintain:apply -- --limit 1000
```

## 生命周期故障

任务失败时先按 `job_id` 查询产品状态，再按 `workflow_id` 检查 DBOS。不得直接修改业务表
“修复”状态。确认根因消失后，通过产品重试或幂等运维命令恢复。

删除失败可重新创建持久化任务：

```bash
cd deploy/compose
source scripts/compose-env.sh
mk_compose run --rm --no-deps dbos-control \
  ./node_modules/.bin/tsx src/worker/dispatch-entry.ts \
  --retry-document-delete <failed-job-uuid>
```

故障恢复后应验证：无 dead/stuck workflow、无 pending ACL、旧 generation 不可召回、
active 文档仍能返回正确引用。

## 依赖故障原则

| 故障 | 预期行为 |
|---|---|
| PostgreSQL 不可达 | 请求失败且不泄漏，连接恢复后进程可继续服务 |
| Qdrant 不可达 | Retrieve/Ask fail closed；不得返回无依据答案 |
| Worker 停止 | 新任务保持 queued；恢复后通过确定性 workflow id 继续 |
| Parser 失败 | 任务可诊断、可重试；替换任务不得覆盖旧 active |
| 模型失败 | 返回明确服务错误或拒答；不得伪造引用 |

## 备份与灾难恢复

```bash
cd deploy/compose
./scripts/backup.sh ./backups/<backup-id>
CONFIRM=YES ./scripts/restore.sh ./backups/<backup-id>
```

备份必须包含 PostgreSQL、DBOS、文档对象、Qdrant 和 manifest 校验值。恢复只允许在维护窗口
或可丢弃环境执行，顺序见 [DEPLOYMENT.md](./DEPLOYMENT.md)。每个目标环境都要实际恢复一次，
并记录 RPO、RTO、数据对照值和恢复后的隔离检查。

以下任一情况表示恢复失败：active pointer 与可见 generation 不一致、引用指向不存在版本、
对象缺失、跨租户数据出现，或必须手工改库才能恢复。

## CI 与镜像发布

| Workflow | 责任 |
|---|---|
| `.github/workflows/ci.yml` | Web/TS 测试、评分器、类型、Lint、迁移与四镜像构建 |
| `.github/workflows/release-images.yml` | ACR/GHCR 推送、Trivy HIGH/CRITICAL 门禁和 digest manifest |

本地候选镜像：

```bash
just check
just images v0.1.0
just release v0.1.0 REGISTRY/NAMESPACE
```

manifest 记录四个镜像 digest 和 DBOS application version。升级只能引用该不可变 manifest；
扫描失败不得发布。SBOM、签名和 provenance 目前不是通用交付能力，客户合同要求时必须在
该项目的发布门禁中补齐。

`0021_ask_runs.sql` 会在既有 `libraries` 和 `workspace_service_keys` 上建立复合唯一索引。大型客户库
升级时应安排维护窗口并先在副本测量锁等待；后续若这些表增长到需要在线迁移，应将索引改为独立的
`CREATE UNIQUE INDEX CONCURRENTLY` 运维步骤。

## 事故记录

事故记录至少包括版本/digest、环境、时间线、影响范围、关联 ID、是否存在权限或引用错误、
处置动作、恢复验证和后续测试。任何跨租户泄漏、错误 generation 召回或无证据回答都应按
发布熔断级事件处理。
