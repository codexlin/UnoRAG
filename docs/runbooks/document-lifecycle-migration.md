# Document Lifecycle Migration Runbook

## Scope

This runbook applies migration `0004_cloudy_madripoor` and configures the
runtime PostgreSQL roles used by `web`, `rag-api`, and `rag-worker`.

## Preconditions

1. Back up PostgreSQL.
2. Stop document uploads and legacy reindex operations.
3. Confirm no unsupported state values exist:

```sql
SELECT DISTINCT status FROM app.documents;
SELECT DISTINCT status FROM app.document_versions;
SELECT DISTINCT status FROM app.jobs;
```

Allowed values are defined in
`contracts/document-lifecycle-v1.json`. Resolve unknown values before
continuing.

4. Confirm lifecycle pointers are currently valid:

```sql
SELECT active.document_id, active.version_id
FROM app.document_active_versions AS active
LEFT JOIN app.document_versions AS version
  ON version.id = active.version_id
 AND version.document_id = active.document_id
WHERE version.id IS NULL;
```

The query must return zero rows.

## Apply

Run migrations with the deployment/migrator credential:

```bash
cd apps/web
DATABASE_URL=postgresql://... pnpm db:migrate
```

Apply the Python-owned RAG read model with the migrator credential:

```bash
cd ../api
MIGRATOR_DATABASE_URL=postgresql://... \
  uv run python scripts/apply_rag_migrations.py
```

This runner serializes migrations with a PostgreSQL advisory lock and rejects
checksum changes to an already-applied file. It also requeues L2 jobs parked at
`completed/awaiting_activation`.

Configure the non-login runtime roles as the PostgreSQL owner after both app
and rag migrations exist:

```bash
psql "$DATABASE_URL" -f ops/postgres/configure-runtime-roles.sql
```

Create customer-specific login roles and grant exactly one runtime role to
each login. Do not reuse the migrator credential at runtime.

## Verify

```bash
cd apps/web
pnpm db:check

cd ../api
JOB_TEST_DATABASE_URL=postgresql://... uv run pytest \
  tests/test_job_repository_postgres.py
```

Verify that:

- two workers claim disjoint jobs;
- an invalid lease cannot heartbeat;
- `meriknow_worker` cannot update `app.organizations`;
- invalid statuses and cross-document desired-version pointers are rejected.
- activation updates `app.document_active_versions` and
  `rag.active_document_generations` in one transaction;
- a late job becomes `superseded` and cannot replace a newer desired version.

## Rollback

Before any V2 job is created, rollback may remove the new indexes,
constraints, and nullable columns after restoring the previous application.
After V2 jobs exist, do not drop lifecycle columns. Roll back application
traffic, leave the additive Schema in place, and restore legacy upload routing.

Qdrant is unaffected by L0 because staging generations begin in L2.

## L3 activation and gate

FastAPI production configuration:

```bash
export ACTIVE_GENERATION_GATE_ENABLED=true
export RAG_READ_DATABASE_URL=postgresql://rag_read_login:secret@postgres:5432/meriknow
export ACTIVE_GENERATION_CACHE_TTL_SECONDS=0
```

Activation order:

1. validate indexed point count;
2. set the new Qdrant generation hint to `active`;
3. atomically switch app pointer and rag read model with desired/lease/generation CAS;
4. mark the previous hint `inactive`;
5. retain previous points until `rag.generation_cleanup_queue.delete_after`.

The PostgreSQL read model is authoritative. An active Qdrant hint without a
matching read-model row is invisible. A failed old-hint cleanup is also safe:
the read model excludes that generation and the durable cleanup row records
the retry requirement. When the gate is enabled, points without a
`generation_id` are also invisible; reindex legacy documents before enabling
the gate for production traffic.

## L4 parser rollout

The native lifecycle upload accepts TXT, Markdown, DOCX, and PDF. Configure the
worker, not the browser-facing web process, with the MinerU endpoint:

```bash
export MINERU_ENABLED=true
export MINERU_URL=http://mineru:6006
export MINERU_PARSE_PATH=/file_parse
export MINERU_TIMEOUT_S=120
export MINERU_MAX_RETRIES=2
export MINERU_MODE=auto
```

Before rollout, verify `GET /health` on MinerU and parse one scanned PDF with
`return_content_list=true` and `response_format_zip=false`. Production startup
rejects `MINERU_USE_FAKE=true` and rejects an enabled MinerU without a URL.

`mineru_timeout`, `mineru_rate_limited`, `mineru_service_error`,
`mineru_unreachable`, and `mineru_invalid_response` retry with the Job backoff
and become `dead` after `max_attempts`. Request rejection and missing
configuration fail permanently. During retries, the old active generation
remains authoritative. Parser page diagnostics are retained in
`document_versions.parser_report`.

## L2 lifecycle worker

Next.js 与 worker 必须挂载同一个 `DOCUMENT_STORAGE_ROOT`。生产环境使用独立
PostgreSQL 登录并只授予 `meriknow_worker`：

```sql
GRANT meriknow_worker TO meriknow_worker_login;
```

```bash
cd apps/api
export WORKER_DATABASE_URL=postgresql://meriknow_worker_login:secret@postgres:5432/meriknow
export DOCUMENT_STORAGE_ROOT=/var/lib/meriknow/documents
uv run python -m app.lifecycle_worker
```

健康判断：

- `queued/retry` 应持续被 claim；
- 运行中 Job 的 `heartbeat_at` 应至少每 30 秒刷新；
- 正常 L2 终态为 `status=completed, stage=awaiting_activation`；
- 对应 version 为 `indexed`，Qdrant payload 为
  `lifecycle_visibility=staging`；
- `lease_expires_at` 过期的 Job 会由任意健康 worker reaper 回收；
- `dead` 必须告警并由管理员检查 source、模型和 Qdrant 后手动 retry。

## Generation cleanup sweeper

激活成功后，旧 generation 会进入 `rag.generation_cleanup_queue`，并在
`delete_after`（默认 7 天）之后才删除 Qdrant 点。lifecycle worker 循环内会
顺带消费到期行；也可单独跑：

```bash
cd apps/api
export WORKER_DATABASE_URL=postgresql://meriknow_worker_login:secret@postgres:5432/meriknow
uv run python -m app.generation_cleanup_sweeper
# 持续循环：LIFECYCLE_CLEANUP_LOOP=1 uv run python -m app.generation_cleanup_sweeper
```

应用 RAG migration `0002_generation_cleanup_sweep.sql` 后，队列行带有
`sweep_status`（`pending` → `sweeping` → `deleted` / `error`）。仍处于
`rag.active_document_generations` 的 generation 不会被删除。

停止时发送 `SIGTERM`。worker 会停止 claim 新 Job，当前同步步骤结束后退出。
若容器被强杀，lease 过期后会自动恢复；同 generation 的确定性 point ID
保证重放不会产生重复点。

可选 readiness 文件（编排探针）：

```bash
export LIFECYCLE_WORKER_READY_FILE=/tmp/meriknow-lifecycle-ready
uv run python -m app.lifecycle_worker
# 进程进入主循环后写入该文件；SIGTERM 退出时删除
```

## Document / library delete (L5)

浏览器删除走 Next 控制面，不再同步调用 FastAPI `DELETE /v1/documents/{id}`：

1. `DELETE /api/libraries/{libraryId}/documents/{documentId}` 将 document
   标为 `deleting`，取消未完成 ingest，并入队 `document.delete` job；
2. lifecycle worker 清理 Qdrant（generation + doc_id）、对象存储与 RAG
   metadata，再把 document/version 标为 `deleted`；
3. library 删除 fan-out 为多个 `document.delete`（`library_delete=true`）。
   最后一个文档清理完成后，worker 写入 `library.delete` outbox，并标记
   library `deleted`。空库仍立即硬删 + outbox。

运维巡检：

```bash
cd apps/web
DATABASE_URL=postgresql://... pnpm lifecycle:inspect
# CI / 告警：pnpm lifecycle:check
```

报告字段：`dead_jobs`、`stuck_jobs`（lease 过期或心跳超时）、
`deleting_documents`、`cleanup_errors`、`libraries`（deleting/deleted）。

## L6 legacy ingest exit

生产路径只有控制面 + lifecycle worker：

```text
Browser
  -> Next.js /api/libraries/.../documents (upload/replace/reindex/delete)
  -> app.jobs
  -> Python lifecycle worker (PostgreSQL claim)
```

FastAPI 浏览器写路径已永久关闭（无开关可打开），始终返回
`410 legacy_ingest_writes_disabled`：

- `POST /v1/ingest`
- `POST /v1/ingest/upload`
- `POST /v1/documents/{id}/replace`
- `POST /v1/documents/{id}/reindex`
- `DELETE /v1/documents/{id}`

Next BFF `/api/rag/...` 对同样写路径直接 `410`，不再 dual-write
`app.documents`，也不再对 document list 做 RAG probe 同步。Ask / Ask stream /
archive / download 仍走 HMAC 代理。

控制面重索引：

```bash
POST /api/libraries/{libraryId}/documents/{docId}/reindex
```

复用现有 version 的 `storage_key`/`content_hash`，创建新 version +
`document.ingest` job，不经 ARQ。

激活 CAS：document 处于 `deleting`/`deleted` 时 `prepare_activation` /
`activate_generation` 失败；library 状态刷新不会把 `deleting` 清成
`ready`/`indexing`。

## L6 stock backfill (versions / Qdrant)

Existing `app.documents` created by the retired dual-write path may lack
`document_versions`, `desired_version_id`, and active pointers.

```bash
# 1) Dry-run then apply version/active backfill (reads public.documents when present)
cd apps/web
DATABASE_URL=postgresql://... pnpm lifecycle:backfill-versions
DATABASE_URL=postgresql://... pnpm lifecycle:backfill-versions:apply

# 2) Tag old Qdrant points with generation_id + ACL from active versions
cd ../api
DATABASE_URL=postgresql://... QDRANT_URL=http://127.0.0.1:6333 \
  uv run python scripts/backfill_qdrant_lifecycle_payload.py
DATABASE_URL=postgresql://... QDRANT_URL=http://127.0.0.1:6333 \
  uv run python scripts/backfill_qdrant_lifecycle_payload.py --apply

# 3) Preferred full repair for missing/placeholder storage_key:
#    POST /api/libraries/{libraryId}/documents/{docId}/reindex
#    (creates a new generation via app.jobs; do not use deprecated reindex_all.py)
```

`public.documents` remains a **compatibility projection** for data-plane reads
and backfill joins. Product status, desired version, and jobs live only in
`app.*`. Operators must not treat `public.documents.status` as authoritative.

`derive_document_version_id` was removed in L6; lifecycle ingest always passes
real `app.document_versions.id` UUIDs. ARQ / FastAPI ingest write paths are
gone; test harnesses may mint a UUID when calling sync `process_document_ingest`.

## L7 quality release gates

See [quality-release-gates.md](./quality-release-gates.md).
