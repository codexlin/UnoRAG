# 最低观测 / 告警 Runbook

目标：凭一条 `trace_id` 或 `job_id`，在 15 分钟内定位到 Web、DBOS workflow、
Provider、PostgreSQL 或 Qdrant。

## 关联键

| 键 | 用途 |
|---|---|
| `trace_id` / `request_id` | 串起 API、检索、模型与结构化日志 |
| `job_id` / `workflow_id` | 串起产品 job 与 DBOS 执行 |
| `document_id` / `document_version_id` / `generation_id` | 核对 active pointer、对象和向量点 |
| `organization_id` / `workspace_id` | 所有查询与运维动作的隔离范围 |

```text
Browser or API client
  -> Next.js route handlers       auth, RBAC, product transaction
  -> retrieval/Ask runtime        Qdrant filters, rerank, model
  -> PostgreSQL + DBOS            metadata, workflow state, audit
  -> parser/model providers       MinerU, embedding, chat
```

## 快速排查

```bash
curl -fsS "$UNORAG_BASE_URL/api/rag/health" | jq .
curl -fsS -b cookies.jar "$UNORAG_BASE_URL/api/jobs/<job_id>" | jq .
pnpm --dir apps/web lifecycle:inspect
curl -fsS http://127.0.0.1:6333/readyz
```

最低告警实现见 [`../../ops/min_alerts/README.md`](../../ops/min_alerts/README.md)。
至少配置一种通知通道，并覆盖：readiness 降级、DBOS workflow dead/stuck、Ask
5xx、磁盘水位、Postgres/Qdrant 不可达和外部 Provider 错误。告警 payload 应携带
可用的 workspace、trace、job 或 workflow 标识，通知失败不能中断产品 workflow。

本 runbook 不要求完整 Grafana/Tempo/Loki，但正式交付必须记录日志保留周期、敏感
字段脱敏、通知负责人和升级路径。
