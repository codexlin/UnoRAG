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
mk_validate_dbos_config
DBOS_REQUIRED=0
if mk_dbos_required; then
	DBOS_REQUIRED=1
fi

INTERNAL="$(mk_config_get UNORAG_INTERNAL_SECRET || true)"
SESSION="$(mk_config_get UNORAG_SESSION_SECRET || true)"
ADMIN_PW="$(mk_config_get UNORAG_ADMIN_PASSWORD || true)"
LLM_KEY="$(mk_config_get LLM_API_KEY || true)"
POSTGRES_PW="$(mk_config_get POSTGRES_PASSWORD || true)"

if [[ -z "$INTERNAL" || "$INTERNAL" == *"replace-with-random"* || "${#INTERNAL}" -lt 32 ]]; then
	echo "refusing to install: UNORAG_INTERNAL_SECRET missing/placeholder/<32 chars" >&2
	exit 1
fi
if [[ -z "$SESSION" || "$SESSION" == *"replace-with-random"* || "${#SESSION}" -lt 32 ]]; then
	echo "refusing to install: UNORAG_SESSION_SECRET missing/placeholder/<32 chars" >&2
	exit 1
fi
if [[ "$INTERNAL" == "$SESSION" ]]; then
	echo "refusing to install: UNORAG_INTERNAL_SECRET must differ from UNORAG_SESSION_SECRET" >&2
	exit 1
fi
if [[ -z "$ADMIN_PW" || "$ADMIN_PW" == "change-this-before-deployment" ]]; then
	echo "refusing to install: set UNORAG_ADMIN_PASSWORD in ../config/bootstrap.env" >&2
	exit 1
fi
if [[ -z "$LLM_KEY" ]]; then
	echo "refusing to install: set LLM_API_KEY in ../config/runtime.secret" >&2
	exit 1
fi
for db_secret_name in \
	UNORAG_WEB_DB_PASSWORD \
	UNORAG_API_DB_PASSWORD \
	UNORAG_WORKER_DB_PASSWORD \
	UNORAG_OUTBOX_DB_PASSWORD \
	UNORAG_RAG_READ_DB_PASSWORD \
	UNORAG_DBOS_DB_PASSWORD; do
	db_secret="$(mk_config_get "$db_secret_name" || true)"
	if [[ "${#db_secret}" -lt 32 || ! "$db_secret" =~ ^[A-Za-z0-9._~-]+$ ]]; then
		echo "refusing to install: ${db_secret_name} must be >=32 URL-safe characters" >&2
		exit 1
	fi
	if [[ "$db_secret" == "$POSTGRES_PW" ]]; then
		echo "refusing to install: ${db_secret_name} must differ from POSTGRES_PASSWORD" >&2
		exit 1
	fi
done

HTTP_PORT="$(mk_config_get HTTP_PORT || echo 80)"

echo "==> building images"
mk_compose build web api migrate-web outbox-worker dbos-worker

echo "==> starting infrastructure"
mk_compose up -d postgres qdrant redis
mk_compose up -d --wait postgres qdrant redis

echo "==> applying migrations (migrator credential; not runtime DDL)"
mk_compose --profile migrate run --rm migrate-web
mk_compose --profile migrate run --rm migrate-rag

echo "==> configuring least-privilege roles and logins (idempotent)"
mk_compose --profile migrate run --rm configure-db-roles

echo "==> bootstrapping control-plane admin/workspace (create-only password)"
# Password is create-only: re-running install does not reset an existing admin.
# To rotate: ./scripts/rotate-admin-password.sh
mk_compose_bootstrap --profile migrate run --rm bootstrap

if [[ "$DBOS_REQUIRED" -eq 1 ]]; then
	echo "==> starting required DBOS executor and control loop"
	mk_compose --profile dbos up -d dbos-worker dbos-control
	mk_compose --profile dbos up -d --wait dbos-worker dbos-control
	echo "==> reconciling restricted ACL projections"
	mk_compose --profile ops run --rm backfill-acl-projections
fi

echo "==> verifying ACL projection gate"
mk_compose --profile ops run --rm inspect-lifecycle \
	node scripts/inspect-lifecycle.mjs --fail-on-acl-projection

echo "==> starting application stack"
mk_compose up -d caddy web api lifecycle-worker outbox-worker
mk_compose up -d --wait caddy web api lifecycle-worker outbox-worker || true

echo
echo "install complete"
echo "  UI:     http://localhost:${HTTP_PORT}/"
echo "  health: curl -sf http://localhost:${HTTP_PORT}/api/rag/health"
echo "  note:   FastAPI is not published; only Caddy→web is on the edge"
echo "  note:   admin password is only in bootstrap.env (not in web runtime)"
echo "  note:   outbox-worker projects library mutations to the RAG API"
if [[ "$DBOS_REQUIRED" -eq 1 ]]; then
	echo "  note:   DBOS executor/control are required by enabled lifecycle capabilities"
fi
echo
echo "next: review docs/runbooks/private-deployment.md (readiness + backup)"
