# Langfuse AI 工程接入

UnoRAG 通过现有 OpenTelemetry Collector 把同一份 metadata-only Trace 可选发送到 Tempo 和
Langfuse。应用只认识 Collector；Langfuse 地址和项目密钥只存在于 Collector 容器中。

```text
UnoRAG Web / Worker
        |
        | OTLP（无 Langfuse 密钥）
        v
OpenTelemetry Collector
        |-----------------> Tempo
        `-----------------> Langfuse OTLP
```

这条链路不会让 Langfuse 成为 Ask、检索或入库依赖。Langfuse 超时或不可用时，独立 exporter
执行有界排队和重试；Tempo 与产品请求继续工作。

## 前置条件

- 已有 Langfuse Cloud 项目，或独立部署的 Langfuse；推荐使用 v4。
- 自托管实例必须支持 `/api/public/otel/v1/traces`。UnoRAG 会发送
  `x-langfuse-ingestion-version: 4`。
- 从 Langfuse 项目设置获取 Public Key 和 Secret Key。

Langfuse 自托管包含 Web、Worker、PostgreSQL、Redis/Valkey、ClickHouse 和对象存储，容量与升级
责任明显重于 UnoRAG Ops Stack，因此 UnoRAG 不复制或修改其官方部署清单。应把 Langfuse 作为独立
AI 工程平台部署，再通过 OTLP 接入。

## 配置

在 `deploy/config/runtime.env` 设置 OTLP 基础地址，必须以 `/api/public/otel` 结尾：

```dotenv
LANGFUSE_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel
```

自托管示例：

```dotenv
LANGFUSE_OTLP_ENDPOINT=https://langfuse.example.com/api/public/otel
```

使用项目密钥生成 Basic Auth 值，并写入 `deploy/config/runtime.secret`：

```bash
AUTH_STRING="$(printf '%s:%s' "$LANGFUSE_PUBLIC_KEY" "$LANGFUSE_SECRET_KEY" | base64 | tr -d '\n')"
printf 'LANGFUSE_OTLP_AUTHORIZATION=Basic %s\n' "$AUTH_STRING"
```

不要把原始 Key、Basic 值或该 secret 文件提交到 Git。

## 启用与升级

新安装：

```bash
cd deploy/compose
./scripts/install.sh --with-langfuse
```

`--with-langfuse` 自动包含 `--with-observability`。已有部署升级：

```bash
./scripts/upgrade.sh --manifest /path/to/release.env --with-langfuse
```

升级脚本会检测正在运行的 Collector 是否已启用 Langfuse，并在未显式传参时保留该模式。只保留
Grafana/Tempo/Loki 而关闭 Langfuse：

```bash
./scripts/upgrade.sh --manifest /path/to/release.env --without-langfuse
```

Helm 不部署 Collector 或 Langfuse。Kubernetes 客户应使用 `observability.otel.endpoint` 把 UnoRAG
发送到客户托管 Collector，并在该 Collector 上配置同等的 Langfuse OTLP exporter、Basic Auth 和
v4 ingestion header。

## 数据边界

标准产品强制 metadata-only：

- AI SDK 的 `recordInputs=false`、`recordOutputs=false` 由公共函数写死并有测试保护；
- Collector 二次删除问题、回答、Prompt、Completion、模型消息、工具参数/结果、Embedding 内容、
  数据库语句、认证头、Cookie、命令行和宿主机名；
- Langfuse 只接收 Trace，不接收 UnoRAG OTel Logs；
- 可保留模型、Token 用量、延迟、节点类型、拒答/路由结果、引用数量及作用域 ID 等诊断元数据；
- Langfuse 项目权限属于客户运维/AI 工程权限域，不能替代 UnoRAG Workspace ACL。

当前没有内容采集开关。后续若提供，必须是 Workspace 管理员显式动作，并具备审计、保留与删除策略；
部署变量不得绕过该产品权限边界。

## 验证与排障

先运行 Ops smoke，再发起一次真实 Ask：

```bash
cd deploy/compose
./scripts/observability-smoke.sh
curl -fsS "$UNORAG_BASE_URL/api/rag/health" | jq .
```

在 Langfuse 中应看到稳定的 `unorag.ask` 根观察，以及 `query_router`、`rewrite`、`retrieve`、`judge`、
`generate` 等子节点。模型调用应显示模型与 Token 用量，但 Input/Output 为空。

若 Langfuse 没有数据：

1. 检查 Collector 是否使用 `config.yaml` 和 `langfuse.yaml` 两份配置；
2. 检查 endpoint 是否以 `/api/public/otel` 结尾，Basic 值是否由同一项目的一对 Key 生成；
3. 在 Grafana 查询 `otelcol_exporter_queue_size{exporter="otlphttp/langfuse"}`；
4. 同一 Trace 若能在 Tempo 查询到，说明应用到 Collector 的链路正常，应继续检查 Langfuse exporter；
5. 不得因为 Langfuse 故障重启或回滚 UnoRAG 业务数据。

官方契约参考：

- https://langfuse.com/integrations/native/opentelemetry
- https://langfuse.com/docs/compatibility
- https://langfuse.com/self-hosting/configuration/scaling
