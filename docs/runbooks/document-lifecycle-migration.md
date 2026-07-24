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

停止时发送 `SIGTERM`。worker 会停止 claim 新 Job，当前同步步骤结束后退出。
若容器被强杀，lease 过期后会自动恢复；同 generation 的确定性 point ID
保证重放不会产生重复点。
