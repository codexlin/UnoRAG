# MeriKnow API（RAG Data Plane）

FastAPI + LangChain + LangGraph。Ask 图见 [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)。

浏览器应访问 Next.js `/api/rag/*`，**不要**直连本服务做产品操作。产品定位与双模式：[`docs/PRODUCT.md`](../../docs/PRODUCT.md)。本地联调总入口：[`docs/DEV.md`](../../docs/DEV.md)。

## 前置：Qdrant / Postgres / Redis

仓库根目录：

```bash
docker compose up -d
curl -s http://localhost:6333/readyz
```

## 本地启动

```bash
cd apps/api
cp .env.example .env   # 首次；权威分层见文件头注释
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

产品上传另需 lifecycle worker（与 web 共享 `DOCUMENT_STORAGE_ROOT`）：

```bash
uv run python -m app.lifecycle_worker
```

| 端点 | 说明 |
|------|------|
| `GET /health` | 探针（可无内部鉴权） |
| `POST /v1/ask` · `/v1/ask/stream` | 有据问答 |
| `POST /v1/threads` 等 | 主动归档 / 续聊 |
| `/v1/ingest*` 等写路径 | **永久 410** |

私有化生产：

```bash
APP_ENV=production
INTERNAL_AUTH_ENABLED=true
INTERNAL_AUTH_SECRET=<与 Next.js MERIKNOW_INTERNAL_SECRET 相同>
INTERNAL_AUTH_REPLAY_BACKEND=redis
```

> 禁止将开发默认值用于部署。FastAPI 只放在内部网络，仅向 Next.js 与 worker 开放。

开发态直连示例（`INTERNAL_AUTH_ENABLED=false` 时）：

```bash
curl -s -X POST http://localhost:8000/v1/ask \
  -H 'content-type: application/json' \
  -d '{"question":"病假需要在几天内补交证明？","library_id":"lib-hr","session_id":"demo-1"}'
```

多轮同 `session_id`；归档会话传 `thread_id`。响应 `retrieval_debug.rewrite` 在追问时应为 `history`。

## 环境变量

见 [`.env.example`](./.env.example)。要点：

| 变量 | 说明 |
|------|------|
| `INTERNAL_AUTH_ENABLED` | 多用户必须 `true`，否则 `principal=development` 串台 |
| `INTERNAL_AUTH_SECRET` | = web `MERIKNOW_INTERNAL_SECRET` |
| `OPENAI_API_KEY` **或** `DASHSCOPE_API_KEY` | 只配一个 |
| `DOCUMENT_STORAGE_ROOT` | 与 web 共享原文卷 |
| 问答/检索产品旋钮 | 代码默认 ⊕ 工作区覆盖，**不**读 env（`ask_defaults.py`） |
| 产品上传 | Next → `app.jobs` → lifecycle_worker |

## Document Lifecycle Worker

```bash
export WORKER_DATABASE_URL=postgresql://worker_login:secret@localhost:5432/meriknow
export DOCUMENT_STORAGE_ROOT=/var/lib/meriknow/documents
uv run python -m app.lifecycle_worker
```

- Claim：`FOR UPDATE SKIP LOCKED` + heartbeat；过期租约 → retry → dead
- L2 点均为 `staging`，L3 激活前不进检索
- ARQ / FastAPI browser ingest 写路径已移除；Redis 仅用于 HMAC replay 等

首次启用前：

```bash
MIGRATOR_DATABASE_URL=postgresql://... \
  uv run python scripts/apply_rag_migrations.py
# 再执行 ops/postgres/configure-runtime-roles.sql
```

## Lifecycle 解析与错误

支持 `.txt` / `.md` / `.markdown` / `.docx` / `.pdf`。文本 PDF→PyMuPDF；扫描/双栏/复杂表可由 `MINERU_MODE=auto` 升级 MinerU。

`MINERU_PROVIDER=self_hosted`（默认）使用同步 `/file_parse`，并兼容旧
`MINERU_URL`；推荐新部署使用 `MINERU_SELF_HOSTED_URL`。云解析使用
`MINERU_PROVIDER=302ai`，还必须同时配置
`EXTERNAL_PARSER_ALLOWED=true` 和 Secret `MINERU_302_API_KEY`。该显式门禁用于
确认 PDF 会离开当前部署边界；Key 不进入 ConfigMap、job payload 或解析报告。
Compose/Helm 仅把该 Key 注入 lifecycle worker，不注入 API/Web。

**产品配置边界：** 上述 Provider / Key / 出域许可 / URL / 成本 / 超时 / 容量均为
**deploy-only**。知识库用户只设 `parse_preference`（`auto`|`quality`|`local_only`）
与 `scan_handling`（`auto`|`force_ocr`|`disabled`）；不得通过 API 选择供应商。
见 ADR 0002。

302 是异步任务：首次执行上传并保存非敏感 `task_id`，随后释放 worker lease；
按 `MINERU_302_POLL_INTERVAL_S` 延迟续跑，不占用 MinerU slot，也不消耗 job
attempt。`MINERU_302_MAX_WAIT_S`（默认 900）防止异常任务无限轮询。成功 ZIP
中的 `*_content_list.json` 与自建响应统一转换为 `DocumentIR`，后续 chunk /
index / citation 无需感知供应商。

`MINERU_ENABLED=true` 时仍可自动降级。连续 `mineru_unreachable`（连接拒绝等）达到阈值后进入**短窗熔断**：一段时间内跳过 HTTP，直接 PyMuPDF degrade（有字）/ failed（无字）；到期半开探活 1 次，成功则恢复升级 MinerU。不重跑已入库文档。可选：`MINERU_CIRCUIT_FAILURE_THRESHOLD`（默认 3）、`MINERU_CIRCUIT_OPEN_SECONDS`（默认 90）。`soft_timeout` / `429` 不计入熔断。

| error_code | Job 行为 |
|---|---|
| `mineru_pending` | 保存 task id，立刻释放 lease，延迟轮询；不消耗 attempt |
| `mineru_soft_timeout` / `mineru_rate_limited` | 立刻还槽 + retry（较长退避）；**不**计入短窗熔断 |
| `mineru_timeout` / `mineru_service_error` / `mineru_invalid_response` | auto 且已有 PyMuPDF 节点 → degrade 继续 ingest；否则 retry → dead |
| `mineru_unreachable` | auto 且已有 PyMuPDF 节点 → degrade；否则 **failed（不重试）**；计入短窗熔断 |
| `mineru_circuit_open` | 熔断开路跳过 HTTP；有节点 → degrade；无节点 → failed（不重试） |
| `mineru_request_rejected` / `mineru_not_configured` | failed，不重试 |
| `mineru_budget_exceeded` | 日预算门禁；failed，不重试（未发起 billable submit） |

302 可观测性（P1）：结构化 JSON 事件 `mineru.302.*`（upload/create/pending/complete/fail/
budget_*）；`parser_report.metrics` 含页数与估计成本，`mineru_task_id` 仅脱敏。
环境变量见 `MINERU_302_COST_PER_PAGE` / `MINERU_302_DAILY_BUDGET` /
`MINERU_302_LONG_PENDING_S`（`runtime.env.example`）。详情：ADR 0002。

## 测试与样例

```bash
uv run pytest
uv run python scripts/ingest_sample.py   # 开发样例，非产品 HTTP ingest
uv run python scripts/run_eval_cases.py
```
