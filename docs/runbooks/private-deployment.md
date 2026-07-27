# Private Deployment Runbook（L8）

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
  -> DOCUMENT_STORAGE_ROOT shared volume (web + worker)
  -> Customer LLM / embedding / rerank / MinerU endpoints
```

**Fail-closed 边界**

| 规则 | 要求 |
|---|---|
| 边缘只暴露控制面 | 不要发布 `api:8000`；浏览器只打 Caddy→web |
| 生产鉴权 | `APP_ENV=production`、`INTERNAL_AUTH_ENABLED=true`、`INTERNAL_AUTH_SECRET`≥32 且与 web `MERIKNOW_INTERNAL_SECRET` 相同、`INTERNAL_AUTH_REPLAY_BACKEND=redis`；`MERIKNOW_SESSION_SECRET` 必须是另一把密钥 |
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

至少填写：`POSTGRES_PASSWORD`、`MERIKNOW_INTERNAL_SECRET`、
`MERIKNOW_SESSION_SECRET`（必须与 INTERNAL 不同）、`LLM_API_KEY`、
各 `*_DATABASE_URL`，以及 `bootstrap.env` 中的 `MERIKNOW_ADMIN_PASSWORD`。
Compose 会把 `MERIKNOW_INTERNAL_SECRET` 映射为 API 的 `INTERNAL_AUTH_SECRET`，
无需再填第二份。

外部托管 Postgres/Qdrant/Redis/S3 时，改 `runtime.env` / `runtime.secret` 中的 URL 即可；
可去掉对应 Compose 服务（需自行保证网络可达）。
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

1. 构建 `web` / `api` / `web-migrator` 镜像  
2. 启动 Postgres / Qdrant / Redis  
3. `migrate-web`（Drizzle `app.*`）→ `migrate-rag`（`rag.*`）  
4. 应用 `ops/postgres/configure-runtime-roles.sql`  
5. `bootstrap` 控制面组织/工作区/管理员  
6. 启动 Caddy / web / api / lifecycle-worker / outbox-worker   

### 2.3 手工等价步骤

```bash
source scripts/compose-env.sh
mk_compose build web api migrate-web
mk_compose up -d --wait postgres qdrant redis
mk_compose --profile migrate run --rm migrate-web
mk_compose --profile migrate run --rm migrate-rag
mk_compose exec -T postgres \
  psql -U meriknow -d meriknow \
  < ../../ops/postgres/configure-runtime-roles.sql
mk_compose_bootstrap --profile migrate run --rm bootstrap
mk_compose up -d caddy web api lifecycle-worker outbox-worker
```

生命周期迁移细节另见
[`document-lifecycle-migration.md`](./document-lifecycle-migration.md)。

## 3. Readiness

| 组件 | 探针 | 期望 |
|---|---|---|
| Edge / 控制面 | `GET /api/rag/health`（经 Caddy） | HTTP 200；代理到 FastAPI `/health` |
| FastAPI | 容器内 `GET /health` | `status=ok` 时需 metadata + active-generation gate + ask_ready；否则 `unavailable`/`degraded` |
| lifecycle-worker | 文件 `/tmp/meriknow-lifecycle-ready` | 进入主循环后创建；SIGTERM 删除 |
| outbox-worker | 进程常驻 `process-outbox.mjs --watch` | 投影文库变更；无单独 ready 文件 |
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

控制面兼容性：web 与 api 必须共享同一 `MERIKNOW_INTERNAL_SECRET` /
`INTERNAL_AUTH_SECRET`；Lifecycle V2 默认为产品上传路径（勿设
`DOCUMENT_LIFECYCLE_V2=false`），且双方挂载同一 `DOCUMENT_STORAGE_ROOT`。

## 4. 升级

```bash
./scripts/backup.sh ./backups/pre-upgrade
./scripts/upgrade.sh
```

升级要点：

1. **先迁移、再切流量**（additive schema）。  
2. **worker drain**：`source scripts/compose-env.sh && mk_compose stop lifecycle-worker` 发送 SIGTERM；  
   worker 停止 claim，当前同步步骤结束后退出（`stop_grace_period: 2m`）。  
3. 滚动 `api` → `web` → 拉起新 `lifecycle-worker` / `outbox-worker` → `caddy`。  
4. 多 pipeline version 可短暂并存；检索以 PostgreSQL active generation 为准。  

升级后验收：health、上传/替换一文档、Ask 引用、`lifecycle:inspect` 无异常堆积。

## 5. 回滚

1. 停止写入（或 drain worker）。  
2. 将 `MERIKNOW_WEB_IMAGE` / `MERIKNOW_API_IMAGE` 指回上一版本 tag，  
   `source scripts/compose-env.sh && mk_compose up -d api web lifecycle-worker outbox-worker caddy`。  
3. **不要**盲目 down-migrate Schema。Additive 列可保留；若版本要求恢复数据，  
   使用备份按第 6 节 restore。  
4. 若仅应用回归：回滚镜像即可；若出现数据损坏或不兼容迁移，走 backup restore。  

应用回滚后再次执行 readiness 与一次 Ask/上传冒烟。

## 6. 备份与恢复

### 6.1 备份顺序（脚本已封装）

```bash
./scripts/backup.sh ./backups/meriknow-$(date +%Y%m%d)
```

产物：

- `postgres.sql` — `app` / `rag` / 相关 schema  
- `documents.tgz` — container path `/var/lib/meriknow/documents` (Compose invariant)
- `qdrant.tgz` — 向量存储  
- `MANIFEST.txt`  

一致性建议：短暂暂停上传或在低峰备份；严格一致性需要短停写窗口。

### 6.2 恢复顺序（必须）

```text
1. 停止 app（web/api/worker/caddy）
2. 恢复 PostgreSQL（事实源：active version / ACL / jobs）
3. 恢复 document objects（storage_key 指向的文件）
4. 恢复 Qdrant
5. 启动 app，跑 readiness + 抽样 citation
```

```bash
CONFIRM=YES ./scripts/restore.sh ./backups/meriknow-YYYYMMDD
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
- 轮换 `MERIKNOW_INTERNAL_SECRET` 时 web 与 api **同时**更新并滚动重启。  
- 生产禁用：`MINERU_USE_FAKE`、浏览器直连 FastAPI、legacy ingest writes。  
- 运行登录应授予 `meriknow_web` / `meriknow_worker` / `meriknow_rag_read`  
  （见 `ops/postgres/configure-runtime-roles.sql`），不要用 migrator 跑业务。  

### 8.1 解析配置边界（deploy vs 产品）

| Deploy-only（`runtime.env` / Secret / Helm） | Workspace / 知识库意图（UI） |
|---|---|
| `MINERU_PROVIDER`、`MINERU_*_URL`、`MINERU_302_API_KEY`（仅 worker） | `parse_preference`：`auto` / `quality` / `local_only` |
| `EXTERNAL_PARSER_ALLOWED`、成本单价/日预算 | `scan_handling`：`auto` / `force_ocr` / `disabled`（仅文本） |
| 超时、槽位容量、`MINERU_MODE` | 文档详情展示实际解析器 / 是否出域 / 降级原因 |

库 PATCH/POST 若携带 Provider、API Key、成本费率等字段会 **400 拒绝**。详见 [ADR 0002](../adr/0002-mineru-complex-pdf.md)。

## 9. Helm / Kubernetes（起步骨架）

Compose 适合单机；多副本生产使用 [`deploy/helm/meriknow`](../../deploy/helm/meriknow)。

要点：

- 部署 **web / api / lifecycle-worker / outbox-worker**；**不**内置 Postgres、Qdrant、Redis、MinIO。  
- `values.external.*` 填客户托管连接；密钥走 `secret.existingSecret`（勿提交明文）。  
- Ingress（可选）只暴露 **web**；api 保持 ClusterIP（fail-closed）。  
- readiness：web `GET /api/rag/health`、api `GET /health`、worker 就绪文件。  
- 文档对象：默认 `ReadWriteMany` PVC；S3/MinIO 适配仍后置。  
- 迁移：`migrate.web` / `migrate.rag` 为可选 Helm hook Job。

```bash
helm upgrade --install meriknow ./deploy/helm/meriknow -n meriknow \
  --set secret.existingSecret=meriknow-runtime \
  --set external.qdrant.url=http://qdrant.infra:6333 \
  --set external.redis.url=redis://redis.infra:6379
```

细节与密钥键名见 [`deploy/helm/README.md`](../../deploy/helm/README.md)。

## 10. 本片后置

- Helm 容量参数、HPA、PDB、NetworkPolicy 硬化  
- SBOM、镜像 digest 锁定、依赖/镜像 CVE 扫描流水线  
- MinIO/S3 作为一等对象后端（当前默认共享卷 / PVC）  

**SBOM 薄说明：** Compose/Helm 已 pin 镜像 tag。完整 SBOM/CVE CI 后置；
客户交付前可对构建镜像自行跑 `syft`/`trivy` 并归档。未扫描须写入已知限制。

## 11. 本地验证清单

```bash
cd deploy/compose
./scripts/init-config.sh   # 填 deploy/config 下真实密钥与模型 key
./scripts/install.sh
curl -sf http://localhost/api/rag/health
# 浏览器打开 http://localhost/ 登录 admin
# 上传一个 md，等待 ready，Ask 一次
DATABASE_URL=postgresql://... pnpm --dir ../../apps/web lifecycle:inspect

# L9 冒烟（可选；栈/密钥不可用时 exit 2 干净跳过）
./scripts/pilot-smoke.sh
```

试点 go/no-go：[`pilot-acceptance.md`](./pilot-acceptance.md) ·
[`docs/acceptance/`](../acceptance/README.md)。
