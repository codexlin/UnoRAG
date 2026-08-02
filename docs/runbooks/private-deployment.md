# Private Deployment Runbook

Reference package: [`deploy/compose`](../../deploy/compose) for a single node and
[`deploy/helm/unorag`](../../deploy/helm/unorag) for Kubernetes.

## Topology

```text
Browser / customer app
  -> Caddy
      -> Next.js web (product + Retrieve/Ask)

Private network only:
  DBOS worker + control -> PostgreSQL / Qdrant / document volume / ParserProvider
  Next.js               -> PostgreSQL / Qdrant / Redis / document volume / models
```

The runtime has no FastAPI, outbox, or Python lifecycle service. PostgreSQL `app`
is the only business schema. DBOS uses a separate system database.

## Install

```bash
cd deploy/compose
./scripts/init-config.sh
# Edit ../config/runtime.env, runtime.secret, bootstrap.env
./scripts/install.sh
```

Required secrets:

- `POSTGRES_PASSWORD`
- independent `UNORAG_WEB_DB_PASSWORD`, `UNORAG_WORKER_DB_PASSWORD`,
  `UNORAG_DBOS_DB_PASSWORD` with at least 32 URL-safe characters
- `UNORAG_SESSION_SECRET` with at least 32 characters
- `LLM_API_KEY`
- one-time `UNORAG_ADMIN_PASSWORD` in `bootstrap.env`

Generate bundled database credentials without printing them:

```bash
./scripts/prepare-runtime-db-secrets.sh --bundled-postgres
```

External PostgreSQL operators provision equivalent roles and set `WEB_DATABASE_URL`,
`WORKER_DATABASE_URL`, `DBOS_SYSTEM_DATABASE_URL`, and `MIGRATOR_DATABASE_URL`.
Runtime identities have no DDL permission.

The installer builds four targets, starts infrastructure, applies Drizzle migrations,
configures roles, bootstraps the first organization/workspace/admin, starts DBOS, runs
ACL reconciliation, and starts Web/Caddy.

## Parser Configuration

LiteParse is always available in the worker. Configure self-hosted MinerU with:

```dotenv
MINERU_PROVIDER=self_hosted
MINERU_SELF_HOSTED_URL=http://mineru:6006
MINERU_TRANSPORT=sync
```

The URL itself registers MinerU; there is no separate enable switch. The endpoint must
remain inside the customer-approved trust boundary. Cloud ParserProviders are not part
of the current release.

The current TS runtime supports the standard MinerU `/file_parse` contract and the
generic `/tasks` contract. The retired 302.AI-specific upload/task/ZIP adapter is not
ported; any `MINERU_PROVIDER` other than `self_hosted` fails worker startup.

## Readiness

```bash
curl -fsS http://localhost/api/rag/health | jq .
source scripts/compose-env.sh
mk_compose ps
mk_compose --profile ops run --rm inspect-lifecycle
```

| Component | Expected probe |
|---|---|
| Caddy/Web | `/api/rag/health` returns 200 |
| DBOS worker | container health calls private `:3001/dbos-healthz` |
| DBOS control | ready marker remains fresh |
| PostgreSQL | `pg_isready` |
| Qdrant | private `:6333` ready |
| Redis | `redis-cli ping` |

Do not expose PostgreSQL, Qdrant, Redis, DBOS admin, or ParserProvider ports at the
public edge.

## Upgrade

Create a consistent backup first. Release manifests contain four pinned images and
the DBOS application version:

```bash
./scripts/backup.sh ./backups/pre-upgrade
./scripts/upgrade.sh --manifest /path/to/release-registry.env

# Explicit equivalent
./scripts/upgrade.sh \
  --web IMAGE --migrator IMAGE --ops IMAGE --worker IMAGE \
  --dbos-version lifecycle-v2
```

The script rejects `latest`, saves previous pins, pulls images, applies forward-only
migrations, rolls DBOS before Web, reconciles ACL projections, checks health, and runs
pilot smoke when available.

Migration 0020 intentionally fails if non-terminal Python-owned lifecycle jobs remain.
Drain or terminate those jobs before applying it. Terminal Python rows remain historical.

Application rollback restores previous image pins. It never down-migrates PostgreSQL.
For incompatible or corrupt data, use the backup restore path.

## Backup And Restore

```bash
./scripts/backup.sh ./backups/$(date +%Y%m%d-%H%M%S)
CONFIRM=YES ./scripts/restore.sh /absolute/path/to/backup
```

Backup enters a maintenance window and captures:

- application PostgreSQL plain dump;
- DBOS system database custom dump;
- document storage archive;
- cold Qdrant volume archive;
- manifest and SHA-256 checksums.

Restore is destructive and requires all four artifacts plus `CONFIRM=YES`. It restores
PostgreSQL, roles, DBOS state, documents, Qdrant, then starts DBOS and Web. Redis session
state is deliberately not part of recovery; users sign in again.

After restore verify login, active versions, one existing citation, one new upload,
Retrieve/Ask, deletion, `inspect-lifecycle`, and cross-workspace isolation.

## Operations

```bash
# Inspect dead, stuck, and ACL projection state
source scripts/compose-env.sh
mk_compose --profile ops run --rm inspect-lifecycle

# Retry a failed document deletion with a new durable job
mk_compose run --rm --no-deps dbos-control \
  ./node_modules/.bin/tsx src/worker/dispatch-entry.ts \
  --retry-document-delete <failed-job-uuid>
```

Use [`ops/min_alerts`](../../ops/min_alerts) or customer observability for health,
dead/stuck jobs, Ask 5xx, worker heartbeat and disk usage. Secrets belong in deployment
secret stores and must never be written to images, reports, command history, or Git.
