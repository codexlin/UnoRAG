# MeriKnow 最低告警（B5）

通用 webhook 优先，不依赖 Grafana。五个信号：

| 信号 | 条件 | 定位字段 |
|---|---|---|
| `health.qdrant_ask` | health `qdrant_ok=false` / `ask_ready=false` | `reasons` |
| `worker.heartbeat` | `LIFECYCLE_WORKER_READY_FILE` 缺失或过期 | `worker_id` |
| `jobs.dead_stuck` | dead/stuck 相对 baseline 增长 | `job_id` / `workspace_id` |
| `ask.http_5xx` | Ask 探针 5xx/503 | `trace_id` / `workspace_id` |
| `disk.usage` | documents/postgres/qdrant 路径 > 85% | path + percent |

## 快速用

配置模板：`ops/min_alerts/env.example`（复制为 `.env`，勿放进 `apps/api`）。

```bash
# 本地 mock receiver（写入 JSONL）
python3 ops/min_alerts/check.py mock-receiver --port 18999 --out /tmp/mk-alerts.jsonl

# 评估一次（需 ALERT_WEBHOOK_URL）
set -a && source ops/min_alerts/.env && set +a
python3 ops/min_alerts/check.py once --state-file "${MERIKNOW_ALERT_STATE_FILE:-/tmp/mk-alert-state.json}"
```

Webhook payload 字段：`status`（firing/resolved）、`alert_name`、`workspace_id`、`trace_id`、`job_id`、`worker_id` 等。

验收：`scripts/acceptance/b5_min_alerts.sh`。
