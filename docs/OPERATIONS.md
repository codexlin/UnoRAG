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
| `attempt_trace_id` | Worker 每次执行尝试的独立 Trace；当前用 job/workflow ID 关联，Span Link 为后续增强 |
| `document_id` / `document_version_id` / `generation_id` | 核对 active pointer、对象与向量点 |
| `organization_id` / `workspace_id` | 限定所有查询和运维动作的安全范围 |

## 日常检查

```bash
curl -fsS "$UNORAG_BASE_URL/api/rag/health/ready" | jq .
curl -fsS "$UNORAG_BASE_URL/api/rag/health" | jq .
pnpm lifecycle:inspect
pnpm ask-runs:maintain
pnpm tombstones:maintain

cd deploy/compose
source scripts/compose-env.sh
mk_compose ps
mk_compose --profile ops run --rm inspect-lifecycle
mk_compose --profile ops run --rm check-dbos-drain \
  --application-version "$(mk_config_get UNORAG_DBOS_APPLICATION_VERSION)" \
  --scope all --timeout-seconds 0
```

`/metrics` 只供内网 Prometheus 抓取，Caddy 对公网路径返回 404。未启用 Ops Stack 时，可进入 Web
容器读取，或让客户已有监控系统通过私有网络抓取：

```bash
mk_compose exec -T web node -e \
  'fetch("http://127.0.0.1:3000/metrics").then(r => r.text()).then(console.log)'
```

至少监控以下信号：

- Web readiness、Ask 5xx、P50/P95 延迟和并发拒绝；
- DBOS workflow queued/running/dead/stuck、Worker 心跳和重试；
- Parser、Embedding、Rerank、LLM 的错误率、延迟和限额；
- Judge 的 mode/model、P50/P95、重试和 Token；独立 Judge 模型变更必须先通过发布黄金集；
- PostgreSQL 连接、锁、容量与备份状态；
- Qdrant readiness、集合容量和检索错误；
- 文档卷、备份卷和宿主机磁盘水位。

`check-dbos-drain` 同时读取 `app.jobs` 与 DBOS `workflow_status`。前者覆盖尚未派发和正在执行业务
状态，后者覆盖 `PENDING`、`ENQUEUED`、`DELAYED` durable workflow；任一侧非零都不能切换 DBOS
application version。`upgrade.sh` 会自动执行该门禁，日常命令只用于发布前诊断。

UnoRAG 默认提供管理员可见的“运行中心”、低基数 `/metrics`、核心路径 Pino JSON、Ask stages 与
`app.ask_runs` 诊断元数据。运行中心按当前 organization/workspace 强制隔离，展示 Ask 终态、P50/P95、
引用覆盖、dead/stuck 任务、组件健康、持久告警和恢复建议；不会返回问题、回答、Prompt、引用正文、
Provider 地址、通知目标或 Job 错误正文。Webhook/邮件是默认关闭的核心可选投递；分布式追踪、集中
日志与 Alertmanager 由可选 Ops Stack 提供，完整边界见
[design/observability.md](./design/observability.md)。

需要模型、Token、LangGraph 节点和后续评测实验视图时，可选启用 metadata-only Langfuse 出口；配置、
权限和排障见 [LANGFUSE.md](./LANGFUSE.md)。Langfuse exporter 告警不得升级为 UnoRAG 业务不可用告警。

LLM 调用由 Web 进程内的共享 FIFO 门控统一约束，Router、Rewrite、Judge、TablePlan 和最终回答不会各自
绕过额度。`LLM_MAX_INFLIGHT` 是每个 Web 副本的在途上限，因此集群总上限约为“副本数 × 该值”；
`LLM_MAX_QUEUE` 限制每个副本的排队数，`LLM_QUEUE_TIMEOUT_MS` 限制等待时间。队列满返回
`llm_overloaded`，等待超时返回 `llm_queue_timeout`，两者均可重试且不包含 Prompt 内容。调整这些参数
需要重启 Web，不支持运行中漂移。

容量调优应同时观察 `unorag_ai_llm_inflight`、`unorag_ai_llm_queue_depth` 和
`unorag_ai_llm_queue_wait_seconds`，并核对 Provider 限额、Ask P95、拒答率和引用覆盖。不要只提高并发；
持续排队会触发 `UnoRAGLlmQueueSustained`，应先确认是突发流量、Provider 限流还是模型延迟上升。

## 可选 Ops Stack

Compose 私有部署可在安装或升级时显式启用：

```bash
cd deploy/compose
./scripts/install.sh --with-observability
./scripts/upgrade.sh --manifest /path/to/release.env --with-observability
./scripts/observability-smoke.sh
```

启用前必须在 `runtime.secret` 设置至少 16 字符的 `GRAFANA_ADMIN_PASSWORD`。Grafana 默认只监听
`127.0.0.1:3300`，远程访问应使用客户 VPN、堡垒机或 SSH tunnel，不应改成公网匿名访问。
Collector 会删除认证头、Cookie、Prompt、Completion、数据库语句、进程命令行和宿主机名；应用 Span
本身也只写入诊断元数据，不写问题、回答、文档正文或凭据。Loki 汇聚 UnoRAG 通过统一 logger 输出的
结构化应用事件；Caddy 或第三方组件的完整 stdout/stderr 仍应由客户现有容器日志采集器负责。

停止整套 Ops 不应停止产品：

```bash
source scripts/compose-env.sh
mk_compose_observability stop grafana prometheus alertmanager tempo loki otel-collector
curl -fsS "$UNORAG_BASE_URL/api/rag/health" | jq .
```

OTLP exporter 采用有界批处理并 fail-soft。短期指标、日志与 Trace 卷不进入 UnoRAG 业务备份；它们
可独立清理和重建。Alertmanager 默认不向外投递，正式接入 PagerDuty、邮件或客户告警平台前，应由
客户运维提供 receiver Secret 并完成一次故障与恢复通知演练。

Compose 为组件设置 CPU、内存限制和有限保留期，但 Docker 命名卷本身不是磁盘硬配额。生产宿主机应
把观测卷放在有水位告警与配额/容量控制的独立文件系统，或改接客户托管的 Prometheus、Loki、Tempo；
磁盘告警必须早于业务数据卷告警阈值。

`dbos-control` 默认每 15 分钟把超过 30 分钟的 `running` Ask 收敛为失败，并按 30 天保留期有界删除
终态记录。它还会每小时分批回收超过 90 天的删除 tombstone：只有 Qdrant、原文件和 generation cleanup
均已完成的文档才能物理删除；库仍被文档、历史会话或 Ask 记录引用时会保留并报告为 `blocked`。每次
物理回收前都会写入 `document.tombstone_purged` / `library.tombstone_purged` 审计事件。

以下部署参数可调整或关闭调度：

```text
ASK_RUN_MAINTENANCE_ENABLED=true
ASK_RUN_MAINTENANCE_INTERVAL_MS=900000
ASK_RUN_STALE_AFTER_MINUTES=30
ASK_RUN_RETENTION_DAYS=30
ASK_RUN_MAINTENANCE_BATCH_SIZE=1000
TOMBSTONE_MAINTENANCE_ENABLED=true
TOMBSTONE_MAINTENANCE_INTERVAL_MS=3600000
TOMBSTONE_RETENTION_DAYS=90
TOMBSTONE_MAINTENANCE_BATCH_SIZE=100
OBSERVABILITY_CYCLE_ENABLED=true
OBSERVABILITY_CYCLE_INTERVAL_MS=60000
OBSERVABILITY_ALERT_WEBHOOK_ENABLED=false
OBSERVABILITY_ALERT_EMAIL_ENABLED=false
```

健康评估使用 advisory lock 支持多个 control 副本，并把结果按 organization/workspace 投影。Webhook
需同时配置 `OBSERVABILITY_ALERT_WEBHOOK_URL` 和 `OBSERVABILITY_ALERT_WEBHOOK_SECRET`；邮件需设置
`EMAIL_PROVIDER=resend`、`OBSERVABILITY_ALERT_EMAIL_TO`、`EMAIL_FROM` 和 `RESEND_API_KEY`。这些值
属于部署密钥，不在运行中心返回。启用对应通知时，还需把非敏感的
`OBSERVABILITY_ALERT_WEBHOOK_ENABLED` / `OBSERVABILITY_ALERT_EMAIL_ENABLED` 设为 `true`，供 Web
端展示配置状态；Web 容器不会获得通知密钥。通知失败采用有界退避，且不影响核心业务。

手工命令默认只预览；确认后才执行：

```bash
pnpm ask-runs:maintain
pnpm ask-runs:maintain:apply -- --limit 1000
pnpm tombstones:maintain
pnpm tombstones:maintain:apply -- --retention-days 90 --limit 100
```

`lifecycle:inspect` 将 `deleting`、可回收的过期 tombstone 和被历史记录阻塞的库分别报告。自动化发布
门禁可额外传 `--fail-on-expired-tombstones`；`blocked_library_tombstones` 是保留策略结果，不触发该
门禁。Grafana 的 `UnoRAG Lifecycle and DBOS` 看板展示每轮回收量、blocked 数和维护失败事件。

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

备份必须覆盖 PostgreSQL、DBOS、文档对象、Qdrant 和 manifest 校验值。`local` 文档对象由脚本归档；
`cos` 文档对象必须由桶版本控制及独立复制/备份覆盖，Compose 清单只记录远程边界。恢复只允许在维护窗口
或可丢弃环境执行，顺序见 [DEPLOYMENT.md](./DEPLOYMENT.md)。每个目标环境都要实际恢复一次，
并记录 RPO、RTO、数据对照值和恢复后的隔离检查。

以下任一情况表示恢复失败：active pointer 与可见 generation 不一致、引用指向不存在版本、
对象缺失、跨租户数据出现，或必须手工改库才能恢复。

COS 模式还必须监控 4xx/5xx、请求延迟、存储容量、版本保留和复制状态。轮换 CAM 密钥时先让 Web 与
Worker 同时获得新凭证，验证上传、入库、下载和删除后再撤销旧凭证，避免半套运行时使用不同身份。

## CI 与镜像发布

| Workflow | 责任 |
|---|---|
| `.github/workflows/ci.yml` | Web/TS 测试、评分器、类型、Lint、迁移与四镜像构建 |
| `.github/workflows/release-images.yml` | ACR/GHCR 推送、Trivy HIGH/CRITICAL 门禁、SBOM/provenance、Cosign 签名和 digest manifest |

本地候选镜像：

```bash
just check
just images v0.1.0
just release v0.1.0 REGISTRY/NAMESPACE
```

manifest 记录四个镜像 digest、DBOS application version 和 Cosign 验证策略。升级只能引用该
不可变 manifest；扫描、签名或发布后的自验任一失败都不得发布。正式 workflow 使用 GitHub OIDC
短期身份做 Sigstore keyless 签名，不保存长期私钥。安装机需预装 `cosign`；正式 manifest 默认启用
fail-closed 验签，并在拉取镜像前校验证书身份和 OIDC issuer。

运营人员也可以独立验证任一 manifest 镜像：

```bash
cosign verify \
  --certificate-identity-regexp '^https://github.com/codexlin/UnoRAG/.github/workflows/release-images.yml@refs/(heads/main|tags/v.*)$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  'ghcr.io/codexlin/unorag@sha256:<64-hex-digest>'
```

`0021_ask_runs.sql` 会在既有 `libraries` 和 `workspace_service_keys` 上建立复合唯一索引。大型客户库
升级时应安排维护窗口并先在副本测量锁等待；后续若这些表增长到需要在线迁移，应将索引改为独立的
`CREATE UNIQUE INDEX CONCURRENTLY` 运维步骤。

## 事故记录

事故记录至少包括版本/digest、环境、时间线、影响范围、关联 ID、是否存在权限或引用错误、
处置动作、恢复验证和后续测试。任何跨租户泄漏、错误 generation 召回或无证据回答都应按
发布熔断级事件处理。
