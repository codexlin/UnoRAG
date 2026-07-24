#!/usr/bin/env bash
# Fresh private-deployment install: build → infra → migrate → bootstrap → app.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
	echo "missing .env — copy env.example and set secrets first:" >&2
	echo "  cp env.example .env" >&2
	exit 1
fi

# shellcheck disable=SC1091
set -a && source .env && set +a

if [[ "${MERIKNOW_INTERNAL_SECRET}" == *"replace-with-random"* ]] \
	|| [[ "${MERIKNOW_SESSION_SECRET}" == *"replace-with-random"* ]] \
	|| [[ "${INTERNAL_AUTH_SECRET}" == *"replace-with-random"* ]]; then
	echo "refusing to install with placeholder secrets in .env" >&2
	exit 1
fi

echo "==> building images"
docker compose build web api migrate-web

echo "==> starting infrastructure"
docker compose up -d postgres qdrant redis
docker compose up -d --wait postgres qdrant redis

echo "==> applying migrations (migrator credential; not runtime DDL)"
docker compose --profile migrate run --rm migrate-web
docker compose --profile migrate run --rm migrate-rag

echo "==> configuring least-privilege roles (idempotent)"
if [[ -f ../../ops/postgres/configure-runtime-roles.sql ]]; then
	docker compose exec -T postgres \
		psql -U "${POSTGRES_USER:-meriknow}" -d "${POSTGRES_DB:-meriknow}" \
		< ../../ops/postgres/configure-runtime-roles.sql
else
	echo "warn: ops/postgres/configure-runtime-roles.sql not found; skip" >&2
fi

echo "==> bootstrapping control-plane admin/workspace"
docker compose --profile migrate run --rm bootstrap

echo "==> starting application stack"
docker compose up -d caddy web api lifecycle-worker
docker compose up -d --wait caddy web api lifecycle-worker || true

echo
echo "install complete"
echo "  UI:     http://localhost:${HTTP_PORT:-80}/"
echo "  health: curl -sf http://localhost:${HTTP_PORT:-80}/api/rag/health"
echo "  note:   FastAPI is not published; only Caddy→web is on the edge"
echo
echo "next: review docs/runbooks/private-deployment.md (readiness + backup)"
