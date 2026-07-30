#!/usr/bin/env bash
# Backup PostgreSQL, document objects, and Qdrant storage.
# Restore order: postgres -> documents -> qdrant (see private-deployment runbook).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "${ROOT}/scripts/compose-env.sh"

OUT="${1:-}"
if [[ -z "$OUT" ]]; then
	OUT="$ROOT/backups/unorag-$(date +%Y%m%dT%H%M%S)"
fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

PROJECT="$(mk_config_get COMPOSE_PROJECT_NAME || echo unorag)"
# Compose invariant — must match docker-compose named-volume mount (not runtime.env).
STORAGE_ROOT="/var/lib/unorag/documents"
POSTGRES_USER="$(mk_config_get POSTGRES_USER || echo unorag)"
POSTGRES_DB="$(mk_config_get POSTGRES_DB || echo unorag)"
DBOS_DB="$(mk_config_get UNORAG_DBOS_DATABASE || echo unorag_dbos)"
DBOS_WAS_RUNNING=0
QDRANT_WAS_RUNNING=0
APP_WAS_RUNNING=()

for service in caddy web api lifecycle-worker outbox-worker; do
	if [[ -n "$(mk_compose ps --status running -q "$service" 2>/dev/null || true)" ]]; then
		APP_WAS_RUNNING+=("$service")
	fi
done
if [[ -n "$(mk_compose ps --status running -q qdrant 2>/dev/null || true)" ]]; then
	QDRANT_WAS_RUNNING=1
fi
if [[ -n "$(mk_compose --profile dbos ps --status running -q dbos-worker 2>/dev/null || true)" ]]; then
	DBOS_WAS_RUNNING=1
fi

restart_services() {
	if [[ "$QDRANT_WAS_RUNNING" -eq 1 ]]; then
		mk_compose up -d --wait qdrant >/dev/null
	fi
	if [[ "${#APP_WAS_RUNNING[@]}" -gt 0 ]]; then
		mk_compose up -d "${APP_WAS_RUNNING[@]}" >/dev/null
	fi
	if [[ "$DBOS_WAS_RUNNING" -eq 1 ]]; then
		mk_compose --profile dbos up -d dbos-worker dbos-control >/dev/null
	fi
}
trap restart_services EXIT

echo "==> entering maintenance window (draining all Compose writers)"
if [[ "${#APP_WAS_RUNNING[@]}" -gt 0 ]]; then
	mk_compose stop "${APP_WAS_RUNNING[@]}"
fi
if [[ "$DBOS_WAS_RUNNING" -eq 1 ]]; then
	mk_compose --profile dbos stop dbos-control dbos-worker
fi

echo "==> postgres dump → $OUT/postgres.sql"
mk_compose exec -T postgres \
	pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
	--format=plain --no-owner --no-acl \
	> "$OUT/postgres.sql"

echo "==> DBOS system database dump → $OUT/dbos-system.dump"
mk_compose exec -T postgres \
	pg_dump -U "${POSTGRES_USER}" -d "${DBOS_DB}" \
	--format=custom --no-owner --no-acl \
	> "$OUT/dbos-system.dump"

echo "==> document storage → $OUT/documents.tgz"
mk_compose run --rm --no-deps --user root --entrypoint "" web \
	tar -C "$STORAGE_ROOT" -czf - . > "$OUT/documents.tgz"

echo "==> qdrant cold storage → $OUT/qdrant.tgz"
if [[ "$QDRANT_WAS_RUNNING" -eq 1 ]]; then
	mk_compose stop qdrant
fi
docker run --rm \
	-v "${PROJECT}_qdrant_data:/data:ro" \
	-v "$OUT:/backup" \
	alpine:3.21 tar -C /data -czf /backup/qdrant.tgz .

cat > "$OUT/MANIFEST.txt" <<EOF
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
postgres=postgres.sql
dbos_system=dbos-system.dump
documents=documents.tgz
qdrant=qdrant.tgz
project=${PROJECT}
consistency=maintenance-window
dbos_application_version=$(mk_config_get UNORAG_DBOS_APPLICATION_VERSION || echo lifecycle-v2)
web_image=$(mk_config_get UNORAG_WEB_IMAGE || true)
api_image=$(mk_config_get UNORAG_API_IMAGE || true)
dbos_worker_image=$(mk_config_get UNORAG_DBOS_WORKER_IMAGE || true)
EOF

(
	cd "$OUT"
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum postgres.sql dbos-system.dump documents.tgz qdrant.tgz MANIFEST.txt
	else
		shasum -a 256 postgres.sql dbos-system.dump documents.tgz qdrant.tgz MANIFEST.txt
	fi
) >"$OUT/CHECKSUMS.sha256"

trap - EXIT
restart_services
echo "backup complete → $OUT"
