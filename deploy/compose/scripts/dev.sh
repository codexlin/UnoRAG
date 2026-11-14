#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/compose-env.sh"
export UNORAG_COMPOSE_OVERLAY="${SCRIPT_DIR}/../docker-compose.development.yml"

case "${1:-up}" in
  up)
    mk_compose build web
    mk_compose up -d postgres qdrant redis document-storage-init
    mk_compose stop web dbos-control dbos-worker
    # A dedicated Linux volume keeps native dependencies off the host tree.
    mk_compose run --rm --no-deps -e CI=true web pnpm install --frozen-lockfile
    mk_compose --profile migrate run --rm --no-deps migrate-web
    mk_compose up -d --wait --wait-timeout 180 --no-deps web dbos-worker dbos-control
    printf 'Development URL: %s/login\n' "${UNORAG_DEV_BASE_URL:-http://localhost:${UNORAG_DEV_PORT:-3001}}"
    ;;
  logs)
    mk_compose logs -f --tail 100 web dbos-worker dbos-control
    ;;
  stop)
    mk_compose stop web dbos-control dbos-worker
    ;;
  *)
    printf 'Usage: bash deploy/compose/scripts/dev.sh [up|logs|stop]\n' >&2
    exit 2
    ;;
esac
