# MeriKnow 最低告警（B5）

通用 webhook **或** Resend 邮件（私有部署优先邮件；飞书 webhook 可后接）。五个信号：

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
# 本地 mock receiver（写入 JSONL）— webhook 通道
python3 ops/min_alerts/check.py mock-receiver --port 18999 --out /tmp/mk-alerts.jsonl

# 评估一次（webhook 和/或 Resend；可用 --dry-run）
set -a && source ops/min_alerts/.env && set +a
python3 ops/min_alerts/check.py once --state-file "${MERIKNOW_ALERT_STATE_FILE:-/tmp/mk-alert-state.json}"
```

Payload 字段：`status`（firing/resolved）、`alert_name`、`workspace_id`、`trace_id`、`job_id`、`worker_id` 等。  
投递 fail-soft：单通道失败只记在 `delivery`，不抛崩 checker。

## Resend 邮件（私有 webch 推荐）

| 变量 | 说明 |
|------|------|
| `RESEND_API_KEY` | Resend API key（**勿提交 git**） |
| `ALERT_EMAIL_FROM` | 已验证发件人（亦可回退读 `EMAIL_FROM`） |
| `ALERT_EMAIL_TO` | 收件人，逗号分隔 |
| `ALERT_RESEND_API_URL` | 可选；默认 `https://api.resend.com/emails`（单测可指向 mock） |

Webhook 仍用 `ALERT_WEBHOOK_URL`（可与邮件并存；任一成功即 `delivery.ok=true`）。

### 阿里云 webch 启用

在主机 `/opt/meriknow`（或 compose 工作目录）准备 `ops/min_alerts/.env`，填入上表三键 + 既有 `MERIKNOW_HEALTH_URL` / `DATABASE_URL` / heartbeat / disk 路径。cron 示例：

```cron
*/5 * * * * cd /opt/meriknow && set -a && . ops/min_alerts/.env && set +a && /usr/bin/python3 ops/min_alerts/check.py once >> /var/log/meriknow-alerts.log 2>&1
```

首次建议 `--dry-run` 看 signals，再去掉 dry-run 发真实邮件。飞书 webhook 可后续加 `ALERT_WEBHOOK_URL`，无需改代码。

验收：`scripts/acceptance/b5_min_alerts.sh`（webhook mock）；Resend 单测：`python3 -m pytest ops/min_alerts/test_resend_delivery.py -q`。
