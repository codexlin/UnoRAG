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

echo "==> postgres dump → $OUT/postgres.sql"
mk_compose exec -T postgres \
	pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
	--format=plain --no-owner --no-acl \
	> "$OUT/postgres.sql"

echo "==> document storage → $OUT/documents.tgz"
mk_compose run --rm --no-deps --user root --entrypoint "" web \
	tar -C "$STORAGE_ROOT" -czf - . > "$OUT/documents.tgz"

echo "==> qdrant storage → $OUT/qdrant.tgz"
docker run --rm \
	-v "${PROJECT}_qdrant_data:/data:ro" \
	-v "$OUT:/backup" \
	alpine:3.21 tar -C /data -czf /backup/qdrant.tgz .

cat > "$OUT/MANIFEST.txt" <<EOF
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
postgres=postgres.sql
documents=documents.tgz
qdrant=qdrant.tgz
project=${PROJECT}
EOF

echo "backup complete → $OUT"
