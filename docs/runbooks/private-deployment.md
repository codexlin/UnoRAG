# Private Deployment Runbook

客户环境安装、升级、回滚与备份恢复。配套包：[`deploy/`](../../deploy/README.md)。

## 1. 拓扑

```text
Browser
  -> Caddy (TLS / :80)
      -> Next.js Control Plane (web)
           -> FastAPI RAG Data Plane (api, unpublished)
           -> PostgreSQL / Qdrant / Redis
      -> Python lifecycle-worker (unpublished; claims app.jobs)
      -> Node outbox-worker (unpublished; projects app.outbox_events → RAG)
      -> DBOS worker + control (optional migration cohort; unpublished)
           -> dedicated DBOS system database
  -> DOCUMENT_STORAGE_ROOT shared volume (web + worker)
  -> Customer LLM / embedding / rerank / MinerU endpoints
```

**Fail-closed 边界**

| 规则 | 要求 |
|---|---|
| 边缘只暴露控制面 | 不要发布 `api:8000`；浏览器只打 Caddy→web |
| 生产鉴权 | `APP_ENV=production`、`INTERNAL_AUTH_ENABLED=true`、`INTERNAL_AUTH_SECRET`≥32 且与 web `UNORAG_INTERNAL_SECRET` 相同、`INTERNAL_AUTH_REPLAY_BACKEND=redis`；`UNORAG_SESSION_SECRET` 必须是另一把密钥 |
| Active generation | `ACTIVE_GENERATION_GATE_ENABLED=true`、`ACTIVE_GENERATION_CACHE_TTL_SECONDS=0` |
| 产品上传 | 仅 Next.js → `app.jobs` → lifecycle_worker；FastAPI ingest 写路径永久 410 |
| Secret | 仅环境 / secret manager；禁止写入镜像或日志 |
| DDL | 仅 migrator 凭据执行迁移；运行账号无 DDL |

根目录 `docker-compose.yml` 仅供开发基础设施。客户安装使用 `deploy/compose/`。

## 2. 安装（全新环境）

### 2.1 准备

```bash
cd deploy/compose
./scripts/init-config.sh
# 编辑 ../config/runtime.env / runtime.secret / bootstrap.env
# 生成密钥（示例）：openssl rand -base64 48
```

至少填写：`POSTGRES_PASSWORD`、六个 `UNORAG_*_DB_PASSWORD`（含独立
`UNORAG_DBOS_DB_PASSWORD`）、
`UNORAG_INTERNAL_SECRET`、`UNORAG_SESSION_SECRET`（必须与 INTERNAL 不同）、
`LLM_API_KEY`，以及 `bootstrap.env` 中的 `UNORAG_ADMIN_PASSWORD`。数据库密码使用
`openssl rand -hex 32` 等 URL-safe 值，且不得复用管理员密码。

旧版 bundled-Postgres 部署升级前可执行：

```bash
./scripts/prepare-runtime-db-secrets.sh --bundled-postgres
```

脚本只更新 gitignored 的 `runtime.secret`，生成六个独立密码并移除旧共享 DSN
override，不输出密码。外部托管 PostgreSQL 不运行该脚本，由数据库管理员创建登录
账号、授予对应 runtime role，并填写 `WEB/API/WORKER/OUTBOX/RAG_READ_DATABASE_URL`。
HTTPS 部署还应在 `runtime.env` 设置 `UNORAG_BASE_URL=https://你的域名`，供升级
健康检查与 pilot smoke 使用；本地 HTTP 部署可留空。
Compose 会把 `UNORAG_INTERNAL_SECRET` 映射为 API 的 `INTERNAL_AUTH_SECRET`，
无需再填第二份。

外部托管 Postgres/Qdrant/Redis 时，改 `runtime.env` / `runtime.secret` 中的连接即可，
并可在部署覆盖中去掉对应 Compose 服务（需自行保证网络可达）。当前文档存储必须由
web 与 lifecycle worker 共享 `DOCUMENT_STORAGE_ROOT`；S3/MinIO adapter 尚未交付，
不能只填 URL 就切换。
勿 `source` secret 文件污染宿主机 shell，也不要直接执行
`docker compose --env-file ...`（宿主机同名变量优先级更高）。统一使用
`source scripts/compose-env.sh && mk_compose ...`；需要 bootstrap 配置时使用
`mk_compose_bootstrap ...`。helper 会清除受管宿主变量，再加载拆分配置。

### 2.2 一键安装

```bash
chmod +x scripts/*.sh
./scripts/install.sh
```

脚本顺序：

1. 构建 `web` / `api` / `web-migrator` / `outbox` / `DBOS worker` 镜像
2. 启动 Postgres / Qdrant / Redis
3. `migrate-web`（Drizzle `app.*`）→ `migrate-rag`（`rag.*`）
4. 幂等应用 runtime roles、独立登录账号和权限断言
5. `bootstrap` 控制面组织/工作区/管理员
6. 启动 Caddy / web / api / lifecycle-worker / outbox-worker

### 2.3 手工等价步骤

```bash
source scripts/compose-env.sh
mk_compose build web api migrate-web
mk_compose up -d --wait postgres qdrant redis
mk_compose --profile migrate run --rm migrate-web
mk_compose --profile migrate run --rm migrate-rag
mk_compose --profile migrate run --rm configure-db-roles
mk_compose_bootstrap --profile migrate run --rm bootstrap
mk_compose up -d caddy web api lifecycle-worker outbox-worker
```

### 2.4 DBOS cleanup cohort（显式启用）

DBOS 只负责被明确分配的 cleanup 行。默认安装不会启动 profile，也不会修改
`execution_engine=python` 的队列行。

```bash
# 1. 启动 executor + control；两者不对外暴露端口
mk_compose --profile dbos up -d --wait dbos-worker dbos-control

# 2. 小批接管到期且仍为 pending/error 的 Python cleanup
mk_compose --profile dbos run --rm --no-deps \
  -e UNORAG_DBOS_ADOPTION_CONFIRMED=true \
  dbos-control \
  ./node_modules/.bin/tsx src/worker/dispatch-entry.ts \
  --adopt-pending-cleanup --adopt-limit 10
```

接管采用 document advisory lock + 行锁和 CAS；不会接管 `sweeping` 行，也不会删除
active generation。停止 cohort 时先停 `dbos-control`，等待 `dbos-worker` 完成已物化
任务；确认不存在非终态 DBOS job 后再停 executor。已接管行不反向改回 Python；
未接管的新行仍由 Python 处理。不得直接改已有
`app.jobs.execution_engine/workflow_id`，这两个字段由数据库触发器保护为不可变。

生命周期迁移细节另见
[`document-lifecycle-migration.md`](./document-lifecycle-migration.md)。

## 3. Readiness

| 组件 | 探针 | 期望 |
|---|---|---|
| Edge / 控制面 | `GET /api/rag/health`（经 Caddy） | HTTP 200；代理到 FastAPI `/health` |
| FastAPI | 容器内 `GET /health` | `status=ok` 时需 metadata + active-generation gate + ask_ready；否则 `unavailable`/`degraded` |
| lifecycle-worker | 文件 `/tmp/unorag-lifecycle-ready` | 进入主循环后创建；SIGTERM 删除 |
| outbox-worker | 进程常驻 `process-outbox.mjs --watch` | 投影文库变更；无单独 ready 文件 |
| DBOS worker（可选） | `GET :3001/dbos-healthz`（仅容器/Pod 内） | executor 已连接独立 system DB |
| DBOS control（可选） | 常驻进程 + `dbos.control.tick` 日志 | dispatch/reconcile 无持续失败 |
| Postgres | `pg_isready` | healthy |
| Qdrant | TCP `:6333` / `readyz` | healthy |
| Redis | `redis-cli ping` | `PONG` |

生产启动后建议：

```bash
curl -sf http://localhost/api/rag/health | jq .
cd ../../apps/web
DATABASE_URL=... pnpm lifecycle:inspect
```

`lifecycle:inspect` 需要已应用 `rag` 迁移（含 `rag.generation_cleanup_queue`）。
若缺表，先跑 `migrate-rag`，不要对生产执行 destructive backfill apply。

控制面兼容性：web 与 api 必须共享同一 `UNORAG_INTERNAL_SECRET` /
`INTERNAL_AUTH_SECRET`；Lifecycle V2 默认为产品上传路径（勿设
`DOCUMENT_LIFECYCLE_V2=false`），且双方挂载同一 `DOCUMENT_STORAGE_ROOT`。

## 4. 升级

默认路径是 **Registry pull**（不是本机 `compose build`）。须提供 pin 过的
release（拒绝 `latest` / 空 tag）。详见
[`docs/ops/cicd.md`](../ops/cicd.md)。

```bash
./scripts/backup.sh ./backups/pre-upgrade
./scripts/upgrade.sh --manifest /path/to/release.env
# 或：./scripts/upgrade.sh --web IMG --api IMG --migrator IMG --outbox IMG
# 或：./scripts/upgrade.sh --from-runtime   # 使用 runtime.env 已有 pin
```

升级要点：

1. **先迁移、再切流量**（**additive** schema；迁移失败 **不**自动回滚数据库）。
2. **worker drain**：SIGTERM `lifecycle-worker`（`stop_grace_period: 2m`）。
3. 滚动 `api` → `web` → `lifecycle-worker` → **`outbox-worker`** → `caddy`。
4. 重置并验证 runtime role 权限，再切换运行服务。
5. Health 后自动跑 `pilot-smoke.sh`（若可执行；SKIP=exit 2 不触发回滚）。
6. 应用失败时脚本可按 `.upgrade-state/previous-images.env` **回切旧镜像**（应用回滚 ≠ DB 回滚）。

升级后验收：health、上传/替换一文档、Ask 引用、`lifecycle:inspect` 无异常堆积。

全生命周期巡检使用短生命周期 ops job，不复用 outbox worker 的受限账号：

```bash
source scripts/compose-env.sh
mk_compose --profile ops run --rm inspect-lifecycle
```

## 5. 回滚

1. 停止写入（或 drain worker）。
2. 将 `UNORAG_WEB_IMAGE` / `UNORAG_WEB_MIGRATOR_IMAGE` /
   `UNORAG_API_IMAGE` / `UNORAG_OUTBOX_IMAGE` / `UNORAG_DBOS_WORKER_IMAGE`
   与 `UNORAG_DBOS_APPLICATION_VERSION` 指回上一发布清单
   （或重跑升级脚本的自动应用回滚），
   `source scripts/compose-env.sh && mk_compose up -d api web lifecycle-worker outbox-worker caddy`。
   DBOS profile 原本已运行时，`upgrade.sh` 会一并 drain/恢复 `dbos-worker` 与
   `dbos-control`。
3. **不要**盲目 down-migrate Schema。Additive 列可保留；若版本要求恢复数据，
   使用备份按第 6 节 restore。
4. 若仅应用回归：回滚镜像即可；若出现数据损坏或不兼容迁移，走 backup restore。

应用回滚后再次执行 readiness 与一次 Ask/上传冒烟。

## 6. 备份与恢复

### 6.1 备份顺序（脚本已封装）

```bash
./scripts/backup.sh ./backups/unorag-$(date +%Y%m%d)
```

产物：

- `postgres.sql` — `app` / `rag` / 相关 schema
- `dbos-system.dump` — durable workflow 状态与 step checkpoints
- `documents.tgz` — container path `/var/lib/unorag/documents` (Compose invariant)
- `qdrant.tgz` — 向量存储
- `MANIFEST.txt`
- `CHECKSUMS.sha256` — 恢复前强制校验的归档摘要

脚本会进入短维护窗口：记录当前运行服务，停止 Caddy 与全部业务写入者，
优雅停止 DBOS executor/control，完成两库 dump、文档对象归档与 Qdrant 冷备，
然后只恢复备份前实际运行的服务。该路径以短暂停机换取跨存储一致性。

### 6.2 恢复顺序（必须）

```text
1. 停止 app 与 DBOS control/executor
2. 校验 `CHECKSUMS.sha256`
3. 恢复 PostgreSQL 业务库（事实源：active version / ACL / jobs）
4. 重建并验证 runtime login / grants 与独立 DBOS database
5. 恢复 DBOS system database（durable workflow/checkpoints）
6. 恢复 document objects（storage_key 指向的文件）
7. 恢复 Qdrant
8. 启动 app，跑 readiness + 抽样 citation
```

```bash
CONFIRM=YES ./scripts/restore.sh ./backups/unorag-YYYYMMDD
```

**错误顺序会破坏 citation / active generation 一致性。**
Redis 可重建（仅 replay/cache）；不必从备份恢复。

## 7. 扩容与故障

| 场景 | 动作 |
|---|---|
| 提高 ingest 吞吐 | 增加 `lifecycle-worker` 副本（同 image/command）；靠 PG lease 互斥 |
| API 只读扩展 | 增加 `api` 副本；共用 Postgres/Qdrant/Redis |
| Worker 崩溃 | lease 过期后重放；同 generation 确定性 point id |
| Qdrant 短暂不可用 | health 变 degraded；恢复后勿跳过 active-generation gate |
| 模型 endpoint 断开 | Ask 失败；除客户配置的 endpoint 外产品不依赖公网 |
| dead/stuck jobs | `pnpm lifecycle:inspect` / `lifecycle:check` |

日志保留与资源 limit：Compose 参考未强制 `deploy.resources`；客户可按主机配额在
override 文件中加 `mem_limit` / `cpus`，并外接日志栈。

## 8. 安全与密钥

- `.env` 权限 `600`；不进 Git。
- 轮换 `UNORAG_INTERNAL_SECRET` 时 web 与 api **同时**更新并滚动重启。
- 生产禁用：`MINERU_USE_FAKE`、浏览器直连 FastAPI、legacy ingest writes。
- 长期服务分别使用 `unorag_web_login`、`unorag_api_login`、
  `unorag_worker_login`、`unorag_outbox_login`、`unorag_rag_read_login`；
  每个登录只继承一个同名职责 role。不要用 migrator 跑业务。
- `migrate-web` / `migrate-rag` 是唯一 DDL 路径；FastAPI metadata 启动只校验
  schema，不再执行 `CREATE TABLE` / `ALTER TABLE`。

### 8.1 解析配置边界（deploy vs 产品）

| Deploy-only（`runtime.env` / Secret / Helm） | Workspace / 知识库意图（UI） |
|---|---|
| `MINERU_PROVIDER`、`MINERU_*_URL`、`MINERU_302_API_KEY`（仅 worker） | `parse_preference`：`auto` / `quality` / `local_only` |
| `EXTERNAL_PARSER_ALLOWED`、成本单价/日预算 | `scan_handling`：`auto` / `force_ocr` / `disabled`（仅文本） |
| 超时、槽位容量、`MINERU_MODE` | 文档详情展示实际解析器 / 是否出域 / 降级原因 |

库 PATCH/POST 若携带 Provider、API Key、成本费率等字段会 **400 拒绝**。详见 [ADR 0002](../adr/0002-mineru-complex-pdf.md)。

### 8.2 最低告警（Resend 邮件）

私有试点优先用 Resend 邮件接 `ops/min_alerts`（飞书 webhook 可选后置）。复制 `ops/min_alerts/env.example` → `ops/min_alerts/.env`，至少配置：

- `RESEND_API_KEY` · `ALERT_EMAIL_FROM` · `ALERT_EMAIL_TO`
- `UNORAG_HEALTH_URL`（经边缘，如 `https://unorag.example.com/api/rag/health`）
- 可选：`DATABASE_URL`、`LIFECYCLE_WORKER_READY_FILE`、`DOCUMENT_STORAGE_ROOT`

周期执行：`python3 ops/min_alerts/check.py once`（详见 [`ops/min_alerts/README.md`](../../ops/min_alerts/README.md)）。密钥勿入库。

## 9. Helm / Kubernetes（起步骨架）

Compose 适合单机；多副本生产使用 [`deploy/helm/unorag`](../../deploy/helm/unorag)。

要点：

- 部署 **web / api / lifecycle-worker / outbox-worker**；**不**内置 Postgres、Qdrant、Redis、MinIO。
- `values.external.*` 填客户托管连接；密钥走 `secret.existingSecret`（勿提交明文）。
- Ingress（可选）只暴露 **web**；api 保持 ClusterIP（fail-closed）。
- readiness：web `GET /api/rag/health`、api `GET /health`、Python/DBOS control
  就绪文件、DBOS executor `GET /dbos-healthz`。
- DBOS executor 使用 StatefulSet ordinal 作为稳定 executor identity；不要在
  非兼容 workflow 仍运行时缩容对应 ordinal。
- 文档对象：默认 `ReadWriteMany` PVC；S3/MinIO 适配仍后置。
- 迁移：`migrate.web` / `migrate.rag` 为可选 Helm hook Job。

```bash
helm upgrade --install unorag ./deploy/helm/unorag -n unorag \
  --set secret.existingSecret=unorag-runtime \
  --set external.qdrant.url=http://qdrant.infra:6333 \
  --set external.redis.url=redis://redis.infra:6379
```

细节与密钥键名见 [`deploy/helm/README.md`](../../deploy/helm/README.md)。

## 10. 当前后置

- Helm 容量参数、HPA、PDB、NetworkPolicy 硬化
- SBOM、Cosign 签名与 provenance
- MinIO/S3 作为一等对象后端（当前默认共享卷 / PVC）

**供应链说明：** release workflow 已对 web / api / migrator / outbox / DBOS worker 五张镜像执行
Trivy `HIGH/CRITICAL` 门禁，并产出 digest manifest。客户交付时应归档对应扫描日志；
完整 SBOM、Cosign 签名和 provenance 仍后置。

## 11. 本地验证清单

```bash
cd deploy/compose
./scripts/init-config.sh   # 填 deploy/config 下真实密钥与模型 key
./scripts/install.sh
curl -sf http://localhost/api/rag/health
# 浏览器打开 http://localhost/ 登录 admin
# 上传一个 md，等待 ready，Ask 一次
DATABASE_URL=postgresql://... pnpm --dir ../../apps/web lifecycle:inspect

# 试点冒烟（可选；栈/密钥不可用时 exit 2 干净跳过）
./scripts/pilot-smoke.sh
```

试点 go/no-go：[`pilot-acceptance.md`](./pilot-acceptance.md) ·
[`docs/acceptance/`](../acceptance/README.md)。
