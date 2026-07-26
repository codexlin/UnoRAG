#!/usr/bin/env bash
# Rolling upgrade with lifecycle-worker drain (SIGTERM + stop_grace_period).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "${ROOT}/scripts/compose-env.sh"

mk_require_runtime_config || exit 1

HTTP_PORT="$(mk_config_get HTTP_PORT || echo 80)"

echo "==> pre-upgrade backup recommended: ./scripts/backup.sh <dir>"
echo "==> building new images"
mk_compose build web api migrate-web

echo "==> migrations (additive; run before switching traffic)"
mk_compose up -d postgres
mk_compose up -d --wait postgres
mk_compose --profile migrate run --rm migrate-web
mk_compose --profile migrate run --rm migrate-rag

echo "==> draining lifecycle-worker (SIGTERM; finishes current step, no new claims)"
mk_compose stop lifecycle-worker

echo "==> rolling api + web + worker"
mk_compose up -d --no-deps api
mk_compose up -d --no-deps --wait api
mk_compose up -d --no-deps web
mk_compose up -d --no-deps --wait web
mk_compose up -d --no-deps lifecycle-worker
mk_compose up -d --no-deps caddy

echo "==> post-upgrade probes"
curl -sf "http://localhost:${HTTP_PORT}/api/rag/health" | tee /tmp/meriknow-upgrade-health.json
echo
echo "upgrade complete — verify ask/upload and lifecycle:inspect before removing old images"
