# 试点 · B5 最低告警接通

> 绑定脚本/实现提交 **`4a249d2`**（含后续 payload 字段修正的同波次提交，见下方证据 SHA）。  
> 结论：本项 **PASS**（五项 firing→webhook→resolved 均可复现）；整体仍为 **Conditional GO**（正式签字另议）。

## 元数据 / 审计绑定

| 字段 | 值 |
|---|---|
| **证据提交（实现 + 验收脚本）** | `4a249d258ee9ab8576bb22f2755444bd14d7fad6`（初版）+ 本报告同批修正 commit（`namespace`/`fingerprint` + `last_worker_id`） |
| RC2-X（产品验收运行时基线） | `a79d2a53c5ecb32423dae179bdb05784af187a46` |
| `.b5_last_run.json` sha256 | `7adb4d70e85629376acfe6ee7054d3a92890f1b6c2b3b77b442dab84490e7009` |
| 拓扑 | 本机混合栈：Next `:3000` + FastAPI `:8000` + Docker `meriknow-{postgres,qdrant,redis}-1` |
| 日期 | 2026-07-27 |

## 结果总览

| 信号 | 结果 | 注入 | 定位字段 | 解除 |
|---|---|---|---|---|
| **S1** `health.qdrant_ask` | **PASS** | `docker stop meriknow-qdrant-1` | `workspace_id`；health `qdrant_ok=false` | `docker start` → resolved |
| **S2** `worker.heartbeat` | **PASS** | 删除 `LIFECYCLE_WORKER_READY_FILE` | `workspace_id` + `worker_id` | 恢复 ready file → resolved |
| **S3** `jobs.dead_stuck` | **PASS** | 插入标记 stuck job（EXIT 删除） | `job_id` + `workspace_id` | DELETE job → resolved |
| **S4** `ask.http_5xx` | **PASS** | stop Qdrant → Ask 探针 503 | `workspace_id` + `trace_id` | start Qdrant → resolved |
| **S5** `disk.usage` | **PASS** | 真实 df=57.86% + `DISK_FORCE_PERCENT=90` | `workspace_id` + path/percent | 清除 force → resolved |
| 总体 | **PASS** | | | |

### S5 说明

本机未把 documents/PG/Qdrant 卷真实填到 >85%（避免 destructive）。验收同时：

1. **真实测量** documents 路径 usage（本轮 57.86%，未误报）；  
2. **`MERIKNOW_ALERT_DISK_FORCE_PERCENT=90`** 注入 webhook firing/resolved 路径。  

判定为 **PASS**（检测 + webhook 路径已接通）；若需「真实灌盘」演练可另开窗口。

## 实现摘要

- Checker / mock receiver：[`../../../ops/min_alerts/`](../../../ops/min_alerts/)  
- 验收脚本：[`../../../scripts/acceptance/b5_min_alerts.sh`](../../../scripts/acceptance/b5_min_alerts.sh)  
- Worker：`LIFECYCLE_WORKER_READY_FILE` 每轮 poll touch（心跳）  
- Webhook：通用 JSON（`status=firing|resolved`，扁平 `workspace_id` / `trace_id` / `job_id` / `worker_id`）；后续可接 Slack/邮件/Alertmanager  
- 未改 tracing 栈；复用 `/api/rag/health`、Ask 错误路径、jobs SQL（与 `lifecycle:inspect` 同语义）

## 复跑

```bash
# 建议干净工作树
test -z "$(git status --porcelain)"
./scripts/acceptance/b5_min_alerts.sh
```

本地 JSON（勿提交；`0600`）：`scripts/acceptance/.b5_last_run.json`。

## 与正式 GO 的关系

| 项 | 状态 |
|---|---|
| B3 升级演练 | PASS（既有报告） |
| B4 回滚演练 | PASS（既有报告） |
| **B5 最低告警接通** | **PASS**（本文） |
| 正式 go/no-go 签字 | 仍待审批人 |

**建议**：五项告警路径已可写入签字稿技术附件；**是否进入正式签字**仍取决于审批人对 S5「force 注入 vs 真实灌盘」与运维 webhook 落点的书面确认。在签字完成前，整体保持 **Conditional GO**。
