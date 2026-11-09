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

### Judge 故障排查

`refuse_reason=judge_unavailable` 是服务故障，不是资料不足。用户看到“证据校验服务暂不可用”；
JSON 与 SSE 为兼容仍返回拒答结构和空引用，但 Ask run 为 `failed`、Judge 阶段 `ok=false`，
OTel 节点为 ERROR，原生与 Public API 请求指标为 `server_error`，不计入正常拒答质量统计。
按 Request ID 打开运行中心错误详情中的「Judge 诊断」，可查看阶段账本中已记录的类别、应用层尝试次数、
超时、预算、实际耗时、HTTP 状态与可重试性；旧记录缺失的字段不补造默认值。也可读取 PG 阶段 detail
或内部 `retrieval_debug`，对外投影只允许下列数值、布尔值与固定类别，不返回任意 detail 正文：

- `judge_error_category` 区分 `timeout`、`authentication`、`rate_limit`、`provider_unavailable`、
  `output_truncated`、`invalid_output`、`provider_error`；其中 `output_truncated` 表示返回的
  无效结构化输出已被 Provider 标为长度截断，不能误报为网络超时。状态码只保留数值，不记录上游原文、密钥或提示词。
- `judge_attempts` 是应用层结构化调用次数。当前默认适配器关闭 AI SDK 的内层重试，每次 Provider
  HTTP 尝试都重新通过授权检查并计入应用层上限；历史记录可能含 SDK 内层重试，不能反推实际 HTTP 次数。
  401/403 等不可重试错误立即停止。
- `judge_duration_ms` 为本次调用实际总耗时；`judge_timeout_ms` 为每次执行上限，
  `judge_max_attempts` 为应用层尝试上限，`judge_budget_ms` 为两者乘积，不包含并发排队预算，
  不是整个 HTTP 请求的截止时间。外部取消和请求截止仍优先终止执行。
- 先按错误类别检查 Provider 鉴权、配额、可达性、模型输出契约，再结合阶段耗时与重试诊断；
  不要仅凭总耗时推断为网络故障，也不要关闭 Judge 或放宽拒答门槛来恢复“成功率”。

Judge Prompt 从 1.2.0 起明确要求一个完整 JSON 对象、简短理由和无填充空白；当前 1.3.0 增加比较范围核对，保留证据充分性要求、
Zod 契约与候选 ID 校验。模型的原生 JSON Schema 支持应按实际型号配置，不因 OpenAI-compatible
接口接受请求就认定已强制约束；JSON-object 模式也仍须本地校验。阿里云的两种模式及模型支持范围见
[官方结构化输出说明](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output)。

`check-dbos-drain` 同时读取 `app.jobs` 与 DBOS `workflow_status`。前者覆盖尚未派发和正在执行业务
状态，后者覆盖 `PENDING`、`ENQUEUED`、`DELAYED` durable workflow；任一侧非零都不能切换 DBOS
application version。`upgrade.sh` 会自动执行该门禁，日常命令只用于发布前诊断。

## 认证与限流

浏览器会话使用短期 HMAC Cookie，并在 Redis 登记活跃 `sid`。退出登录、切换 Workspace 会原子撤销
旧 `sid`；修改密码会用 PostgreSQL 的 `password_changed_at` 使该用户全部旧 Cookie 立即失效，再在
Redis 登记新会话。Redis 不保存用户、成员关系或权限事实，但 Redis 不可用时登录、会话校验与 Public
Knowledge API 会 fail closed，避免绕过撤销或分布式限流。

```text
AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS=900
AUTH_LOGIN_RATE_LIMIT_PER_ACCOUNT=10
AUTH_LOGIN_RATE_LIMIT_PER_IP=60
UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE=120
```

登录限流同时按规范化账户和边缘代理确认的客户端 IP 计数；响应 `429` 时带 `Retry-After`。数据库仍在
连续 5 次密码失败后锁定本地账户 15 分钟。只允许 Caddy/Ingress 访问 Web 容器，不能把 Web 端口直接
暴露到公网后继续信任客户端自带的 `X-Forwarded-For`。所有限流 key 都只保存 SHA-256 摘要。

会话与限流 Redis key 可丢弃重建；恢复后用户需要重新登录。它们不进入业务备份，也不能替代 PostgreSQL
中的用户状态、密码版本、RBAC 或审计记录。发布本次会话格式变更会使升级前 Cookie 失效一次，这是预期
的安全迁移行为。

UnoRAG 默认提供管理员可见的“运行中心”、低基数 `/metrics`、核心路径 Pino JSON、Ask stages 与
`app.ask_runs` 诊断元数据。运行中心按当前 organization/workspace 强制隔离，展示 Ask 终态、P50/P95、
引用覆盖、dead/stuck 任务、组件健康、持久告警和恢复建议；不会返回问题、回答、Prompt、引用正文、
Provider 地址、通知目标或 Job 错误正文。Webhook/邮件是默认关闭的核心可选投递；分布式追踪、集中
日志与 Alertmanager 由可选 Ops Stack 提供，职责与隐私边界见 [ARCHITECTURE.md](./ARCHITECTURE.md#可观测性边界)。

需要模型、Token、LangGraph 节点和后续评测实验视图时，可选启用 metadata-only Langfuse 出口；配置、
权限和排障见下文“可选 Langfuse”。Langfuse exporter 告警不得升级为 UnoRAG 业务不可用告警。

### 查询单次 Ask 请求

管理员在 **运行中心 → 请求记录** 查看当前 Workspace 的 Ask 请求，包括成功、拒答、失败、取消和处理中。
支持最近 1 小时、24 小时或 7 天，按知识库、问题类型、状态、最低耗时和完整 Request ID 服务端筛选。
列表每页 25 条，按开始时间和 run ID 倒序；翻页固定查询窗口，游标一小时后过期，届时刷新回到第一页。
请求视图使用自己的手动刷新，不继承概览的 30 秒自动刷新。它不是永久审计归档：保留和删除继续受
Ask runs 维护、关联文库/会话的生命周期约束。

点击 Request ID 打开阶段瀑布、实际检索模式、混合检索/重排开关、引用数和白名单拒答原因码。
正常拒答不显示成服务故障；错误请求保留原因分类、恢复建议及已记录的 Judge 尝试/预算诊断。
处理中详情每 5 秒刷新一次；阶段账本主要在请求终态写入，处理中或历史记录可能没有阶段，不能把空记录
解释成“没有耗时”。抽屉不虚构 Embedding、Qdrant、Rerank 或网络请求子 Span，也不展示完整 Prompt。

新记录还可按真实检索阶段展示 **重排诊断**：类别、已记录的 HTTP 状态/尝试次数、预算、耗时、
候选/结果数及 figure 在排序、去重和 Top-K 各步的数量。重排降级后 Ask 仍可能已完成，不能只筛失败请求；
先用 Request ID 查对应成功请求，再检查 timeout/http/transport/invalid_response。空值表示未记录，
不根据总耗时猜网络故障。复用既有结果不显示成新的 Provider 调用。诊断不含原始异常或响应正文，
历史 `rerank_failed=true` 也无法倒推原因。验证见 [历史修复案例](https://github.com/codexlin/UnoRAG/blob/6918b7596f77974cc036c15a3f3140aa89a95aef/docs/evidence/2026-11-05-comparison-lineage-fix.md)。

Qdrant 故障的新记录可展示 **Qdrant 诊断**：ready/query/scroll、错误类别、HTTP 状态、固定连接错误码、
调用耗时、客户端超时及可重试性。Ask 返回 503 不等于 Qdrant 返回 503；HTTP 状态为空时不能这样归因。
`retryable` 只是原因分类，并不表示已自动重试；unknown 或旧记录缺失时不补猜网络原因。
这里只记录 SDK 操作尝试，初始化 ready 的等待次数不代表内部 HTTP 请求数。原始异常和响应正文不对外投影。

原生 Ask 的响应头 `X-Request-ID` 与账本 Request ID 一致，错误正文仍保持通用消息；live runner 会在
正文没有 trace_id 时读取该响应头。图中断的新记录保留实际已完成节点和失败节点的耗时，不只显示 request
总阶段；图外错误、旧记录或缺少快照时仍可能只有总阶段，不能把没有节点记录解释成节点耗时为零。

该列表及详情只允许当前 Workspace 的管理员读取，查询参数不能指定或扩大 organization/workspace。
返回的是诊断元数据，不包含问题、回答、检索正文和凭据；自由文本拒答原因不进入新的诊断记录，也不从
历史行直接投影。问答页回答旁的 **链路** 仍用于查看本轮返回的阶段和原始调试 JSON。

### 查询单次入库

文档详情的入库链路按 Job ID 展示排队、读取文件、解析、切分、向量化、索引和激活。
`accepted` 到实际执行的时间属于本地队列等待，不应计为 MinerU 解析耗时。

新 PDF 完成后，`parser_report.metrics.parser_timing`（schema_version=1）还记录并展示：

- `analysis_ms`：本地 ParserProvider 的分析调用，包括其读取源文件的时间；
- `submission_ms`：准备、上传和创建任务，包括应用层重试与退避；
- `provider_wait_ms`：任务提交后到观察到完成的墙钟等待，包括轮询、轮询网络和间隔；
- `result_fetch_ms`：获取最终结果、下载、解包及结构转换；
- `poll_count` / `retry_count`：应用层轮询尝试和退避重试次数，不是全部底层 HTTP 请求数。

这些是互不重叠的调用阶段，不提供上游内部排队或模型计算的精确耗时。旧报告、非 PDF、未完成或失败
任务可能没有该汇总，不补零、不据此判断“未执行”。本次任务的详细日志可按
`event=parser.provider.attempt` 与 `parser_request_id` 查询；Worker 传入的该 ID 即 Job ID。
日志同时保留 `document_id`、`parser_provider`、`parser_operation`、白名单 `provider_status`、
调用耗时、应用层尝试、错误码及退避值；提交成功后用不可逆的 `provider_task_ref` 关联后续操作，
不写入完整 Provider task ID、URL、原文或响应正文。归一化的 pending/running 状态只是观测值，
不能单独用于归因上游排队或计算瓶颈。

`PARSER_MAX_WAIT_MS` 从 Provider 提交开始计算，覆盖源文件读取、上传、创建任务、轮询、结果下载及
转换，重试和退避共享剩余预算，不在每次操作时重置。截止时会中断在途 HTTP 请求及响应体读取，
过期结果不能继续激活；本地预分析仍使用 LiteParse 自身的执行预算。用户取消时，等待中的 HTTP
操作也会收到中断信号；对上游的取消通知最多等一秒，不把取消通知本身变成无限等待。
可重试超时保留同一幂等键重试的机制，不保证上游任务已停止，尤其 302.AI 没有远程取消端点。
这是单次 ParserProvider 执行的预算；DBOS 持久化步骤重试有独立退避，不能将该值当作整个 Job 总时限。
这不是强制终止同进程内原生 CPU 计算；LiteParse 仍持有其并发槽直到原生执行真正结束。

### 模型并发与背压

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
OBSERVABILITY_ASK_MIN_SAMPLES=10
OBSERVABILITY_ASK_FAILURE_RATE_WARNING=0.05
OBSERVABILITY_ASK_CITATION_COVERAGE_MIN=0.90
OBSERVABILITY_ASK_P95_WARNING_MS=15000
OBSERVABILITY_ASK_P95_CRITICAL_MS=25000
OBSERVABILITY_ALERT_RECOVERY_CYCLES=2
OBSERVABILITY_ALERT_WEBHOOK_ENABLED=false
OBSERVABILITY_ALERT_EMAIL_ENABLED=false
```

Ask 统计告警读取运行中心的滚动窗口，只在对应样本数达到
`OBSERVABILITY_ASK_MIN_SAMPLES` 后评估。P95 达到 warning 阈值产生 warning，达到 critical 阈值升级为
critical；任务 dead/stuck、删除失败和 Provider 不可用不受最小样本限制。控制周期会重复观察同一个滚动
窗口，因此不把“连续轮询次数”误当成新的独立样本；降噪依靠样本下限，恢复则要求连续健康周期。

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

## 可选 Langfuse

UnoRAG 通过 OpenTelemetry Collector 把同一份 metadata-only Trace 可选发送到 Tempo 和 Langfuse。
应用只连接 Collector；Langfuse 地址和项目密钥只能存在于 Collector 容器或客户托管 Collector 中。
Langfuse 不可用时，独立 exporter 只做有界排队和重试，Tempo 与产品请求继续工作。

前置条件是已有 Langfuse Cloud 项目或独立部署的 Langfuse v4。UnoRAG 不复制 Langfuse 自托管所需的
ClickHouse、Redis/Valkey、对象存储等基础设施；这些组件由独立平台负责容量、升级和备份。

在 `runtime.advanced.env` 设置以 `/api/public/otel` 结尾的基础地址：

```dotenv
LANGFUSE_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel
```

使用同一项目的 Public Key 和 Secret Key 生成 Basic Auth，并只写入 `runtime.secret`：

```bash
AUTH_STRING="$(printf '%s:%s' "$LANGFUSE_PUBLIC_KEY" "$LANGFUSE_SECRET_KEY" | base64 | tr -d '\n')"
printf 'LANGFUSE_OTLP_AUTHORIZATION=Basic %s\n' "$AUTH_STRING"
```

安装或升级：

```bash
cd deploy/compose
./scripts/install.sh --with-langfuse
./scripts/upgrade.sh --manifest /path/to/release.env --with-langfuse
# 保留 Ops Stack 但关闭 Langfuse
./scripts/upgrade.sh --manifest /path/to/release.env --without-langfuse
```

`--with-langfuse` 自动包含 Ops Stack。升级脚本会保留已启用模式，除非显式关闭。Helm 不部署 Collector
或 Langfuse；Kubernetes 客户应把 `observability.otel.endpoint` 指向客户 Collector，并在 Collector 上
配置 Langfuse OTLP exporter、Basic Auth 和 v4 ingestion header。

数据边界是强制规则：

- AI SDK 固定 `recordInputs=false`、`recordOutputs=false`；
- Collector 再次删除问题、回答、Prompt、Completion、模型消息、工具输入输出、Embedding 内容、
  数据库语句、认证头、Cookie、命令行和宿主机名；
- Langfuse 只接收 Trace，不接收 UnoRAG OTel Logs；
- 只保留模型、Token、延迟、节点类型、路由/拒答结果、引用数量和作用域诊断元数据；
- Langfuse 项目权限不能替代 UnoRAG Workspace ACL；当前不存在可由环境变量绕过的内容采集开关。

评测 CLI 可以用独立项目 API Key 发布 Session 级确定性分数，但只发送 case/run/release 标识和数值，
不发送黄金集、问题或回答；产品运行容器不持有该 Key。详见 [EVALUATION.md](./EVALUATION.md)。

验证时先运行 `./scripts/observability-smoke.sh`，再发起一次真实 Ask。在 Langfuse 中应看到
`unorag.ask` 及 route/rewrite/retrieve/judge/generate 子节点，模型与 Token 元数据可见而 Input/Output
为空。没有数据时依次检查 Collector 是否加载 Langfuse 配置、endpoint 后缀、Basic Auth、exporter
队列，以及同一 Trace 能否在 Tempo 查询。不得因 Langfuse 故障重启或回滚 UnoRAG 业务数据。

## 生命周期故障

任务失败时先按 `job_id` 查询产品状态，再按 `workflow_id` 检查 DBOS。不得直接修改业务表
“修复”状态。确认根因消失后，通过产品重试或幂等运维命令恢复。

删除失败会在运行中心显示为“待恢复删除”，并触发 `jobs.delete_failed` critical 告警。管理员或
Workspace owner 应先打开“最近错误”确认失败边界，恢复 Qdrant 或对象存储后点击“重试清理”。产品会
创建新的 DBOS 持久化任务，旧失败任务、阶段瀑布和 `library.delete_failed` 审计继续保留；新的任务接管
文档后，“待恢复删除”立即归零，告警默认在连续两个健康控制周期后自动恢复；现场可通过
`OBSERVABILITY_ALERT_RECOVERY_CYCLES` 在 1–10 之间调整。

产品页面不可用时，可使用同一套幂等状态机从 CLI 重新创建任务：

```bash
cd deploy/compose
source scripts/compose-env.sh
mk_compose run --rm --no-deps dbos-control \
  ./node_modules/.bin/tsx src/worker/dispatch-entry.ts \
  --retry-document-delete <failed-job-uuid>
```

故障恢复后应验证：待恢复删除为零、无 dead/stuck workflow、无 pending ACL、对象存储原文件和 Qdrant
generation 已删除、旧 generation 不可召回，未参与删除的 active 文档仍能返回正确引用。不要通过修改
`app.jobs`、`app.documents` 或 `app.libraries` 绕过状态机。

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

备份必须覆盖 PostgreSQL、DBOS、文档对象、Qdrant 和 manifest 校验值。`local` 文档对象由脚本归档。
使用 COS 时，Compose 备份清单只记录桶、地域等远端信息，不包含对象内容，不能直接恢复桶里的原文。
COS 原文必须由桶版本控制及独立复制/备份覆盖。恢复只允许在维护窗口
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
VERSION=v0.2.5
just images "$VERSION"
just release "$VERSION" REGISTRY/NAMESPACE
```

manifest 记录四个镜像 digest、DBOS application version 和 Cosign 验证策略。升级只能引用该
不可变 manifest；扫描、签名或发布后的自验任一失败都不得发布。正式 workflow 使用 GitHub OIDC
短期身份做 Sigstore keyless 签名，不保存长期私钥。安装机需预装 `cosign`；正式 manifest 默认启用
fail-closed 验签，并在拉取镜像前校验证书身份和 OIDC issuer。

GHCR 使用 Cosign v3 的 OCI 1.1 referrer 与新 bundle；部分 ACR 版本不接受 OCI 1.1 签名 manifest，
因此 ACR manifest 显式使用 Cosign `legacy` referrer 和旧 bundle 布局。两者签署的仍是各 Registry 中
精确的镜像 digest，使用同一 GitHub OIDC 身份，并在发布端和部署端按 manifest 自验；不得手工删除这些
字段或把验签降级为可选警告。
ACR 只分发选定平台的运行时 manifest，完整 SBOM/provenance 保留在 GHCR；不要把两端不同的 index/
runtime digest 当作代码不一致。推送失败时先查看脱敏后的 Registry 错误和退出码，边界见
[发布流程](./RELEASE.md)。

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
