#!/usr/bin/env bash
# Backup PostgreSQL, document objects, and Qdrant storage.
# Restore order: postgres -> documents -> qdrant (see private-deployment runbook).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT="${1:-}"
if [[ -z "$OUT" ]]; then
	OUT="$ROOT/backups/meriknow-$(date +%Y%m%dT%H%M%S)"
fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

# shellcheck disable=SC1091
[[ -f .env ]] && set -a && source .env && set +a

PROJECT="${COMPOSE_PROJECT_NAME:-meriknow}"
STORAGE_ROOT="${DOCUMENT_STORAGE_ROOT:-/var/lib/meriknow/documents}"

echo "==> postgres dump → $OUT/postgres.sql"
docker compose exec -T postgres \
	pg_dump -U "${POSTGRES_USER:-meriknow}" -d "${POSTGRES_DB:-meriknow}" \
	--format=plain --no-owner --no-acl \
	> "$OUT/postgres.sql"

echo "==> document storage → $OUT/documents.tgz"
docker compose run --rm --no-deps --user root --entrypoint "" web \
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
restore_order=postgres -> documents -> qdrant -> start apps
EOF

echo "backup written to $OUT"
