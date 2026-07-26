# 最低观测 / 告警 Runbook（草稿）

> 受控试点轻量版：不要求完整 Grafana。目标是 **一条 `trace_id` / `job_id` 能在 15 分钟内定位**到网关、模型、检索、DB 或 Worker。

## 1. 关联键

| 键 | 来源 | 用途 |
|---|---|---|
| `trace_id` / `request_id` | Ask/Retrieve 响应 `debug.trace_id` 或结构化日志 `ask.trace` | 串起 BFF → FastAPI → 模型/检索 |
| `job_id` | 上传/替换/删除 `202` 响应；`GET /api/jobs/:id` | 串起控制面 → `app.jobs` → lifecycle_worker |
| `document_id` / `document_version_id` / `generation_id` | 文档 versions API、citation | 核对 active pointer 与召回 |
| `workspace_id` / `organization_id` | session / service key | 隔离与审计范围 |

## 2. 排查路径（trace_id → …）

```text
浏览器/集成方
  → Next BFF (/api/rag/* 或 /api/v1/*)     [网关：鉴权、HMAC、库权限]
  → FastAPI (/v1/ask|/v1/retrieve)         [检索计划、Qdrant、重排]
  → 模型 endpoint (CHAT/EMBEDDING)         [超时/4xx/5xx → 拒答，不写坏索引]
  → Postgres (metadata / jobs / ACL)       [active generation、lease]
  → lifecycle_worker                       [stage/error_code/heartbeat]
```

### 快速命令（混合本机）

```bash
# 数据面 readiness
curl -sS "$MERIKNOW_BASE_URL/api/rag/health" | jq .

# 任务
curl -sS -b cookies.jar "$MERIKNOW_BASE_URL/api/jobs/<job_id>" | jq .

# Worker / dead / stuck
pnpm --dir apps/web lifecycle:inspect

# Qdrant
curl -sf http://127.0.0.1:6333/readyz && curl -s http://127.0.0.1:6333/collections | jq .
```

Compose 私有部署则经边缘 `http://localhost/api/rag/health`；FastAPI **不**对浏览器暴露。

## 3. 建议最低告警（可后接）

| 信号 | 条件（建议） | 动作 |
|---|---|---|
| API health | `qdrant_ok=false` 或 `ask_ready=false` ≥ 2m | 查 Qdrant/模型密钥；对照 R2/R3 |
| Worker heartbeat | `LIFECYCLE_WORKER_READY_FILE` 缺失或 inspect 无活跃 worker ≥ 2m | 重启 worker；对照 R1 |
| Dead jobs | `dead` 新增或 `mineru_unreachable` 突发 | 查 MinerU/解析；对照 R4 |
| Ask 5xx/503 | 边缘 5xx 率突增 | 用 `trace_id` 分网关 vs 模型 vs Qdrant |
| 磁盘 | document volume / PG / Qdrant > 85% | 扩容或清理；B5 |

## 4. 与验收脚本的关系

| 演练 | 脚本 | 观测点 |
|---|---|---|
| B2 restore | `scripts/acceptance/b2_restore_drill.sh` | restore 后 health + citation version |
| R1 worker | `r_fault_injection.sh` | job 不丢、恢复后 completed |
| R2 Qdrant | 同上 | health degraded；Ask 503；无假答案 |
| R3 模型 | 同上 | 明确失败；active 不变 |
| R4 MinerU | 同上 | `error_code`/stage 可诊断；队列可继续 |

## 5. 非目标（本草稿不覆盖）

- 完整 Grafana/Tempo/Loki 大盘  
- 成本面板、OIDC、MCP  
- 客户侧 PagerDuty 集成细则（由部署方按上表映射）
