# 开发者指南

> 产品定位：[PRODUCT.md](./PRODUCT.md) · 架构：[ARCHITECTURE.md](./ARCHITECTURE.md)
> · 接手与清理：[HANDOFF.md](./HANDOFF.md)

## 仓库布局

```text
UnoRAG/
  docker-compose.yml     # 本机 infra：Postgres / Qdrant / Redis
  apps/web/              # Next.js 控制面
  apps/api/              # FastAPI 数据面 + lifecycle_worker
  deploy/                # 客户式 Compose / Helm
  docs/                  # 产品与工程文档
  testdata/              # 评测与样例文件
```

## 本机联调

### 前置

- Docker + Docker Compose
- Node.js 22、pnpm 9
- Python 3.12+、`uv`

本地拓扑包含 PostgreSQL/Qdrant/Redis 基础设施，以及 Web、API、
lifecycle worker、outbox worker 四个应用进程。根目录 `pnpm dev` **只启动 Web**，
不是完整应用。

### 1. 启动基础设施

```bash
cd UnoRAG
docker compose up -d
# Qdrant :6333 · Postgres :5432 · Redis :6379
```

### 2. 首次配置

```bash
cp -n apps/web/.env.example apps/web/.env.local
cp -n apps/api/.env.example apps/api/.env
mkdir -p .unorag/documents
```

编辑两个配置文件，至少确认：

| 配置 | 要求 |
|------|------|
| web `UNORAG_INTERNAL_SECRET` | 与 API `INTERNAL_AUTH_SECRET` 完全相同，至少 32 字符 |
| web `UNORAG_SESSION_SECRET` | 至少 32 字符，且不能等于 internal secret |
| 两侧 `DOCUMENT_STORAGE_ROOT` | 同一个绝对路径，例如 `<repo>/.unorag/documents` |
| API `ASK_MODE` | 无模型密钥时用 `stub` 验证链路；真实问答使用 `live` 并配置一个模型 key |

不要直接沿用两个 example 中不同的 internal secret 占位值。

### 3. 安装依赖并迁移

```bash
# 仓库根目录
pnpm install
pnpm --dir apps/web db:migrate
pnpm --dir apps/web db:bootstrap

cd apps/api
uv sync
MIGRATOR_DATABASE_URL=postgresql://unorag:unorag@localhost:5432/unorag \
  uv run python scripts/apply_rag_migrations.py
cd ../..
```

### 4. 启动四个应用进程

以下命令分别放在四个终端中运行：

```bash
# Terminal 1 · FastAPI data plane
cd apps/api
uv run uvicorn app.main:app --reload --port 8000
```

```bash
# Terminal 2 · document lifecycle
cd apps/api
uv run python -m app.lifecycle_worker
```

```bash
# Terminal 3 · library projection
cd apps/web
pnpm outbox:run
```

```bash
# Terminal 4 · Next.js control plane
cd apps/web
pnpm dev
```

### 5. 验证

| 检查 | URL / 命令 |
|------|------------|
| 工作台 | http://localhost:3000/app |
| 同源健康 | `GET http://localhost:3000/api/rag/health` |
| API 健康 | `GET http://localhost:8000/health` |
| 登录 | `.env.local` 中 `UNORAG_ADMIN_EMAIL` / `UNORAG_ADMIN_PASSWORD` |

私有化客户式安装见 [`deploy/README.md`](../deploy/README.md) 与
[`runbooks/private-deployment.md`](./runbooks/private-deployment.md)。

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
| `UNORAG_INTERNAL_SECRET` | 与 api `INTERNAL_AUTH_SECRET` **完全相同** |
| `UNORAG_SESSION_SECRET` | Cookie 签名；≥32；**≠** internal |
| `DATABASE_URL` | Drizzle 只管 `app` schema |
| `DOCUMENT_STORAGE_ROOT` | 与 worker 共享原文；生产必填 |
| `DOCUMENT_LIFECYCLE_V2` | 默认开；仅 `false`/`0` 关闭 |
| `UNORAG_ADMIN_*` / org·workspace UUID | `pnpm db:bootstrap` |

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
| `DOCUMENT_STORAGE_ROOT` | **生产唯一权威**；勿再把 `DOCUMENT_STORAGE_DIR` 写进 runbook（仅测试/本机 fallback） |
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
| [HANDOFF.md](./HANDOFF.md) | 代码地图、测试分层、文档与本地产物清理规则 |
| ADR-0004 | 控制面 / 数据面边界 |
