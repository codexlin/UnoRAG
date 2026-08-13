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
STORAGE_DRIVER="$(mk_config_get DOCUMENT_STORAGE_DRIVER || echo local)"
POSTGRES_USER="$(mk_config_get POSTGRES_USER || echo unorag)"
POSTGRES_DB="$(mk_config_get POSTGRES_DB || echo unorag)"
DBOS_DB="$(mk_config_get UNORAG_DBOS_DATABASE || echo unorag_dbos)"
DBOS_WAS_RUNNING=0
QDRANT_WAS_RUNNING=0
APP_WAS_RUNNING=()

for service in caddy web; do
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

if [[ "$STORAGE_DRIVER" == "local" ]]; then
	DOCUMENTS_ARTIFACT="documents.tgz"
	echo "==> document storage → $OUT/documents.tgz"
	mk_compose run --rm --no-deps --user root --entrypoint "" web \
		tar -C "$STORAGE_ROOT" -czf - . > "$OUT/documents.tgz"
elif [[ "$STORAGE_DRIVER" == "cos" ]]; then
	DOCUMENTS_ARTIFACT="documents.cos.txt"
	echo "==> COS objects remain in the private bucket; recording remote storage boundary"
	cat > "$OUT/documents.cos.txt" <<EOF
driver=cos
bucket=$(mk_config_get COS_BUCKET)
region=$(mk_config_get COS_REGION)
public_base_url=$(mk_config_get COS_PUBLIC_BASE_URL || true)
backup_requirement=Enable COS versioning and an independent replication or inventory policy.
EOF
else
	echo "unsupported DOCUMENT_STORAGE_DRIVER=$STORAGE_DRIVER" >&2
	exit 1
fi

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
documents=${DOCUMENTS_ARTIFACT}
document_storage_driver=${STORAGE_DRIVER}
qdrant=qdrant.tgz
project=${PROJECT}
consistency=maintenance-window
dbos_application_version=$(mk_config_get UNORAG_DBOS_APPLICATION_VERSION || echo lifecycle-v2)
web_image=$(mk_config_get UNORAG_WEB_IMAGE || true)
ops_image=$(mk_config_get UNORAG_WEB_OPS_IMAGE || true)
dbos_worker_image=$(mk_config_get UNORAG_DBOS_WORKER_IMAGE || true)
EOF

(
	cd "$OUT"
	ARTIFACTS=(postgres.sql dbos-system.dump qdrant.tgz MANIFEST.txt)
	if [[ "$STORAGE_DRIVER" == "local" ]]; then
		ARTIFACTS+=(documents.tgz)
	else
		ARTIFACTS+=(documents.cos.txt)
	fi
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "${ARTIFACTS[@]}"
	else
		shasum -a 256 "${ARTIFACTS[@]}"
	fi
) >"$OUT/CHECKSUMS.sha256"

trap - EXIT
restart_services
echo "backup complete → $OUT"
