#!/usr/bin/env bash
# Rolling upgrade with lifecycle-worker drain (SIGTERM + stop_grace_period).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
	echo "missing .env" >&2
	exit 1
fi

echo "==> pre-upgrade backup recommended: ./scripts/backup.sh <dir>"
echo "==> building new images"
docker compose build web api migrate-web

echo "==> migrations (additive; run before switching traffic)"
docker compose up -d postgres
docker compose up -d --wait postgres
docker compose --profile migrate run --rm migrate-web
docker compose --profile migrate run --rm migrate-rag

echo "==> draining lifecycle-worker (SIGTERM; finishes current step, no new claims)"
docker compose stop lifecycle-worker

echo "==> rolling api + web + worker"
docker compose up -d --no-deps api
docker compose up -d --no-deps --wait api
docker compose up -d --no-deps web
docker compose up -d --no-deps --wait web
docker compose up -d --no-deps lifecycle-worker
docker compose up -d --no-deps caddy

echo "==> post-upgrade probes"
curl -sf "http://localhost:${HTTP_PORT:-80}/api/rag/health" | tee /tmp/meriknow-upgrade-health.json
echo
echo "upgrade complete — verify ask/upload and lifecycle:inspect before removing old images"
