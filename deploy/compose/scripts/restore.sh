#!/usr/bin/env bash
# Restore from a backup directory produced by backup.sh.
# DESTRUCTIVE — requires CONFIRM=YES.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "${ROOT}/scripts/compose-env.sh"

BACKUP_DIR="${1:-}"
if [[ -z "$BACKUP_DIR" || ! -d "$BACKUP_DIR" ]]; then
	echo "usage: CONFIRM=YES $0 /path/to/backup-dir" >&2
	exit 1
fi
if [[ "${CONFIRM:-}" != "YES" ]]; then
	echo "refusing restore without CONFIRM=YES (destructive)" >&2
	exit 1
fi

PROJECT="$(mk_config_get COMPOSE_PROJECT_NAME || echo unorag)"
POSTGRES_USER="$(mk_config_get POSTGRES_USER || echo unorag)"
POSTGRES_DB="$(mk_config_get POSTGRES_DB || echo unorag)"

echo "==> stopping app services (keeping volumes)"
mk_compose stop caddy web api lifecycle-worker outbox-worker || true

echo "==> ensuring infra is up"
mk_compose up -d postgres qdrant redis
mk_compose up -d --wait postgres qdrant redis

echo "==> restore postgres"
mk_compose exec -T postgres \
	psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
	-v ON_ERROR_STOP=1 \
	-c "DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS rag CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
mk_compose exec -T postgres \
	psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
	-v ON_ERROR_STOP=1 \
	< "$BACKUP_DIR/postgres.sql"

echo "==> restore document storage"
docker run --rm \
	-v "${PROJECT}_document_storage:/data" \
	-v "$BACKUP_DIR:/backup:ro" \
	alpine:3.21 sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar -C /data -xzf /backup/documents.tgz'

echo "==> restore qdrant (stop first)"
mk_compose stop qdrant
docker run --rm \
	-v "${PROJECT}_qdrant_data:/data" \
	-v "$BACKUP_DIR:/backup:ro" \
	alpine:3.21 sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar -C /data -xzf /backup/qdrant.tgz'
mk_compose up -d --wait qdrant

echo "==> starting application stack (incl. outbox-worker)"
mk_compose up -d caddy web api lifecycle-worker outbox-worker

echo "restore complete — verify /api/rag/health, citations, and active versions"
echo "see docs/runbooks/private-deployment.md"
