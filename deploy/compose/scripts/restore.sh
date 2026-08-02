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
for required in postgres.sql dbos-system.dump documents.tgz qdrant.tgz; do
	if [[ ! -f "$BACKUP_DIR/$required" ]]; then
		echo "refusing restore: missing $BACKUP_DIR/$required" >&2
		exit 1
	fi
done
if [[ -f "$BACKUP_DIR/CHECKSUMS.sha256" ]]; then
	echo "==> verifying backup checksums"
	(
		cd "$BACKUP_DIR"
		if command -v sha256sum >/dev/null 2>&1; then
			sha256sum -c CHECKSUMS.sha256
		else
			shasum -a 256 -c CHECKSUMS.sha256
		fi
	)
else
	echo "warning: legacy backup has no checksum manifest" >&2
fi

PROJECT="$(mk_config_get COMPOSE_PROJECT_NAME || echo unorag)"
POSTGRES_USER="$(mk_config_get POSTGRES_USER || echo unorag)"
POSTGRES_DB="$(mk_config_get POSTGRES_DB || echo unorag)"
DBOS_DB="$(mk_config_get UNORAG_DBOS_DATABASE || echo unorag_dbos)"

echo "==> stopping app services (keeping volumes)"
mk_compose stop caddy web dbos-control dbos-worker || true

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

echo "==> recreate and verify runtime logins, grants, and DBOS database"
mk_compose --profile migrate run --rm configure-db-roles

if [[ -f "$BACKUP_DIR/dbos-system.dump" ]]; then
	echo "==> restore DBOS system database"
	mk_compose exec -T postgres \
		pg_restore -U "${POSTGRES_USER}" -d "${DBOS_DB}" \
		--clean --if-exists --no-owner --no-acl \
		--role=unorag_dbos_login --exit-on-error \
		< "$BACKUP_DIR/dbos-system.dump"
else
	echo "refusing restore: backup has no dbos-system.dump required by DBOS" >&2
	exit 1
fi

echo "==> verify restored runtime boundaries"
mk_compose --profile migrate run --rm configure-db-roles

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

echo "==> starting DBOS and application stack"
mk_compose up -d --wait dbos-worker dbos-control web caddy

echo "restore complete — verify /api/rag/health, citations, and active versions"
echo "see docs/runbooks/private-deployment.md"
