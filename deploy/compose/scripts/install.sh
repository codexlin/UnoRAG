#!/usr/bin/env bash
# Fresh private-deployment install: build → infra → migrate → bootstrap → app.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "${ROOT}/scripts/compose-env.sh"

if [[ ! -f ../config/runtime.env || ! -f ../config/runtime.secret || ! -f ../config/bootstrap.env ]]; then
	echo "missing split config — run ./scripts/init-config.sh and fill secrets first" >&2
	exit 1
fi

INTERNAL="$(mk_config_get MERIKNOW_INTERNAL_SECRET || true)"
SESSION="$(mk_config_get MERIKNOW_SESSION_SECRET || true)"
ADMIN_PW="$(mk_config_get MERIKNOW_ADMIN_PASSWORD || true)"
LLM_KEY="$(mk_config_get LLM_API_KEY || true)"

if [[ -z "$INTERNAL" || "$INTERNAL" == *"replace-with-random"* || "${#INTERNAL}" -lt 32 ]]; then
	echo "refusing to install: MERIKNOW_INTERNAL_SECRET missing/placeholder/<32 chars" >&2
	exit 1
fi
if [[ -z "$SESSION" || "$SESSION" == *"replace-with-random"* || "${#SESSION}" -lt 32 ]]; then
	echo "refusing to install: MERIKNOW_SESSION_SECRET missing/placeholder/<32 chars" >&2
	exit 1
fi
if [[ "$INTERNAL" == "$SESSION" ]]; then
	echo "refusing to install: MERIKNOW_INTERNAL_SECRET must differ from MERIKNOW_SESSION_SECRET" >&2
	exit 1
fi
if [[ -z "$ADMIN_PW" || "$ADMIN_PW" == "change-this-before-deployment" ]]; then
	echo "refusing to install: set MERIKNOW_ADMIN_PASSWORD in ../config/bootstrap.env" >&2
	exit 1
fi
if [[ -z "$LLM_KEY" ]]; then
	echo "refusing to install: set LLM_API_KEY in ../config/runtime.secret" >&2
	exit 1
fi

HTTP_PORT="$(mk_config_get HTTP_PORT || echo 80)"

echo "==> building images"
mk_compose build web api migrate-web

echo "==> starting infrastructure"
mk_compose up -d postgres qdrant redis
mk_compose up -d --wait postgres qdrant redis

echo "==> applying migrations (migrator credential; not runtime DDL)"
mk_compose --profile migrate run --rm migrate-web
mk_compose --profile migrate run --rm migrate-rag

echo "==> configuring least-privilege roles (idempotent)"
POSTGRES_USER="$(mk_config_get POSTGRES_USER || echo meriknow)"
POSTGRES_DB="$(mk_config_get POSTGRES_DB || echo meriknow)"
if [[ -f ../../ops/postgres/configure-runtime-roles.sql ]]; then
	mk_compose exec -T postgres \
		psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
		< ../../ops/postgres/configure-runtime-roles.sql
else
	echo "warn: ops/postgres/configure-runtime-roles.sql not found; skip" >&2
fi

echo "==> bootstrapping control-plane admin/workspace (create-only password)"
# Password is create-only: re-running install does not reset an existing admin.
# To rotate: ./scripts/rotate-admin-password.sh
mk_compose_bootstrap --profile migrate run --rm bootstrap

echo "==> starting application stack"
mk_compose up -d caddy web api lifecycle-worker
mk_compose up -d --wait caddy web api lifecycle-worker || true

echo
echo "install complete"
echo "  UI:     http://localhost:${HTTP_PORT}/"
echo "  health: curl -sf http://localhost:${HTTP_PORT}/api/rag/health"
echo "  note:   FastAPI is not published; only Caddy→web is on the edge"
echo "  note:   admin password is only in bootstrap.env (not in web runtime)"
echo
echo "next: review docs/runbooks/private-deployment.md (readiness + backup)"
