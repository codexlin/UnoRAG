# 开发者指南

> 产品定位：[PRODUCT.md](./PRODUCT.md) · 架构：[ARCHITECTURE.md](./ARCHITECTURE.md)

## 仓库布局

```text
MeriKnow/
  docker-compose.yml     # 本机 infra：Postgres / Qdrant / Redis
  apps/web/              # Next.js 控制面
  apps/api/              # FastAPI 数据面 + lifecycle_worker
  deploy/                # 客户式 Compose / Helm
  docs/                  # 产品与工程文档
  testdata/              # 评测与样例文件
```

## 本机一键联调

```bash
cd MeriKnow
docker compose up -d
# Qdrant :6333 · Postgres :5432 · Redis :6379

# —— Control Plane ——
cd apps/web
cp -n .env.example .env.local
pnpm install
pnpm db:migrate
pnpm db:bootstrap
pnpm outbox:run &          # 文库投影；另开终端亦可
pnpm dev                   # http://localhost:3000/app

# —— Data Plane ——
cd apps/api
cp -n .env.example .env
# 填 DATABASE_URL、INTERNAL_AUTH_*、模型 key（ASK_MODE=live）
uv sync
uv run uvicorn app.main:app --reload --port 8000

# —— Lifecycle worker（产品上传必需）——
# 与 web 共用 DOCUMENT_STORAGE_ROOT（本地可先建目录）
export DOCUMENT_STORAGE_ROOT="${DOCUMENT_STORAGE_ROOT:-$PWD/../../.meriknow/documents}"
mkdir -p "$DOCUMENT_STORAGE_ROOT"
uv run python -m app.lifecycle_worker
```

| 检查 | URL / 命令 |
|------|------------|
| 工作台 | http://localhost:3000/app |
| 同源健康 | `GET http://localhost:3000/api/rag/health` |
| API 健康 | `GET http://localhost:8000/health` |
| 登录 | `.env.local` 中 `MERIKNOW_ADMIN_EMAIL` / `MERIKNOW_ADMIN_PASSWORD` |

私有化客户式安装见 [`deploy/README.md`](../deploy/README.md) 与 [`runbooks/private-deployment.md`](./runbooks/private-deployment.md)。

## 环境变量分层

### 原则

| 层 | 放哪里 | 例子 |
|----|--------|------|
| 密钥与基建 | `apps/web/.env.local` · `apps/api/.env` | DB、Qdrant、HMAC、模型 key、存储根 |
| 产品旋钮 | 工作区设置 ⊕ `ask_defaults.py` | hybrid、rerank、top_k、session_memory、裁决阈值 |
| 解析/运维开关 | api `.env` | MinerU、OCR、chunk profile、lifecycle 租约 |

**不要**再把问答产品行为绑到已废弃 env（如 `HYBRID_ENABLED`）。测试里若仍 setenv，仅用于证明「env 不生效」。

### Web（控制面）要点

权威模板：`apps/web/.env.example`

| 变量 | 说明 |
|------|------|
| `RAG_API_URL` | FastAPI 基址（仅服务端） |
| `MERIKNOW_INTERNAL_SECRET` | 与 api `INTERNAL_AUTH_SECRET` **完全相同** |
| `MERIKNOW_SESSION_SECRET` | Cookie 签名；≥32；**≠** internal |
| `DATABASE_URL` | Drizzle 只管 `app` schema |
| `DOCUMENT_STORAGE_ROOT` | 与 worker 共享原文；生产必填 |
| `DOCUMENT_LIFECYCLE_V2` | 默认开；仅 `false`/`0` 关闭 |
| `MERIKNOW_ADMIN_*` / org·workspace UUID | `pnpm db:bootstrap` |

### API（数据面）要点

权威模板：`apps/api/.env.example`（A 必填 / B 调参 / C 可选 / D 遗留）

| 变量 | 说明 |
|------|------|
| `INTERNAL_AUTH_ENABLED` | 多用户必须 `true` |
| `INTERNAL_AUTH_SECRET` | = web internal secret |
| `INTERNAL_AUTH_REPLAY_BACKEND` | 生产 `redis` |
| `DATABASE_URL` + `METADATA_BACKEND=postgres` | 元数据 / turns |
| `QDRANT_*` | 向量 |
| `OPENAI_API_KEY` **或** `DASHSCOPE_API_KEY` | 二选一 |
| `DOCUMENT_STORAGE_ROOT` | 优先于遗留 `DOCUMENT_STORAGE_DIR` |
| `WORKER_DATABASE_URL` | worker 最小权限登录（生产） |
| `ACTIVE_GENERATION_GATE_ENABLED` | 生产必须开；`CACHE_TTL=0` |
| `MINERU_*` / `OCR_*` / `INGEST_PIPELINE` | 解析与切分基建；短窗熔断见 `MINERU_CIRCUIT_FAILURE_THRESHOLD` / `MINERU_CIRCUIT_OPEN_SECONDS`（默认 3 / 90s，不必关 `MINERU_ENABLED`） |

产品上传：**永不**通过 FastAPI `/v1/ingest*`（永久 410）。

## 常用命令

```bash
# API 测试
cd apps/api && uv run pytest
uv run python scripts/run_eval_cases.py

# rag schema
MIGRATOR_DATABASE_URL=postgresql://... \
  uv run python scripts/apply_rag_migrations.py

# Web
cd apps/web
pnpm db:generate && pnpm db:check && pnpm db:migrate
pnpm outbox:check
pnpm test:postgres   # 需 OUTBOX_TEST_DATABASE_URL
```

## 开发时安全注意

- 浏览器只访问 `:3000`；不要教用户直连 `:8000` 做产品操作。
- `INTERNAL_AUTH_ENABLED=false` 时所有人落到 `principal=development`，档案会串——仅限单人本机。
- 生产三联：`APP_ENV=production` + internal auth + Redis replay。

## 深入阅读

| 文档 | 何时看 |
|------|--------|
| [`apps/api/README.md`](../apps/api/README.md) | worker、MinerU 错误码、ask curl |
| [`apps/web/README.md`](../apps/web/README.md) | 邀请、outbox、Drizzle |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 入库 / ask / 会话路径 |
| [INTEGRATION.md](./INTEGRATION.md) | 模式 B |
| ADR-0004 | 控制面 / 数据面边界 |
