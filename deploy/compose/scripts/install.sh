#!/usr/bin/env bash
# Fresh private deployment: build, start infrastructure, migrate, bootstrap, start.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "${ROOT}/scripts/compose-env.sh"

WITH_OBSERVABILITY=0
WITH_LANGFUSE=0
while [[ $# -gt 0 ]]; do
	case "$1" in
		--with-ops|--with-observability) WITH_OBSERVABILITY=1; shift ;;
		--with-langfuse) WITH_LANGFUSE=1; WITH_OBSERVABILITY=1; shift ;;
		-h|--help)
			echo "usage: $0 [--with-observability] [--with-langfuse]"
			exit 0
			;;
		*) echo "unknown argument: $1" >&2; exit 1 ;;
	esac
done

runtime_compose() {
	if [[ "$WITH_LANGFUSE" -eq 1 ]]; then
		mk_compose_langfuse "$@"
	elif [[ "$WITH_OBSERVABILITY" -eq 1 ]]; then
		mk_compose_observability "$@"
	else
		mk_compose "$@"
	fi
}

for file in ../config/runtime.env ../config/runtime.secret ../config/bootstrap.env; do
	[[ -f "$file" ]] || {
		echo "missing $file; run ./scripts/init-config.sh and fill it first" >&2
		exit 1
	}
done
mk_validate_dbos_config

SESSION="$(mk_config_get UNORAG_SESSION_SECRET || true)"
ADMIN_PW="$(mk_config_get UNORAG_ADMIN_PASSWORD || true)"
LLM_KEY="$(mk_config_get LLM_API_KEY || true)"
POSTGRES_PW="$(mk_config_get POSTGRES_PASSWORD || true)"

[[ ${#SESSION} -ge 32 && "$SESSION" != *"replace-with-random"* ]] || {
	echo "refusing install: UNORAG_SESSION_SECRET must contain at least 32 characters" >&2
	exit 1
}
[[ -n "$ADMIN_PW" && "$ADMIN_PW" != "change-this-before-deployment" ]] || {
	echo "refusing install: set UNORAG_ADMIN_PASSWORD in ../config/bootstrap.env" >&2
	exit 1
}
[[ -n "$LLM_KEY" ]] || {
	echo "refusing install: set LLM_API_KEY in ../config/runtime.secret" >&2
	exit 1
}

for name in UNORAG_WEB_DB_PASSWORD UNORAG_WORKER_DB_PASSWORD UNORAG_DBOS_DB_PASSWORD; do
	secret="$(mk_config_get "$name" || true)"
	if [[ ${#secret} -lt 32 || ! "$secret" =~ ^[A-Za-z0-9._~-]+$ ]]; then
		echo "refusing install: $name must be at least 32 URL-safe characters" >&2
		exit 1
	fi
	[[ "$secret" != "$POSTGRES_PW" ]] || {
		echo "refusing install: $name must differ from POSTGRES_PASSWORD" >&2
		exit 1
	}
done

if [[ "$WITH_OBSERVABILITY" -eq 1 ]]; then
	GRAFANA_PW="$(mk_config_get GRAFANA_ADMIN_PASSWORD || true)"
	[[ ${#GRAFANA_PW} -ge 16 ]] || {
		echo "refusing Ops install: GRAFANA_ADMIN_PASSWORD must contain at least 16 characters" >&2
		exit 1
	}
fi

if [[ "$WITH_LANGFUSE" -eq 1 ]]; then
	LANGFUSE_ENDPOINT="$(mk_config_get LANGFUSE_OTLP_ENDPOINT || true)"
	LANGFUSE_AUTH="$(mk_config_get LANGFUSE_OTLP_AUTHORIZATION || true)"
	[[ "$LANGFUSE_ENDPOINT" =~ ^https?://.+/api/public/otel/?$ ]] || {
		echo "refusing Langfuse install: LANGFUSE_OTLP_ENDPOINT must end in /api/public/otel" >&2
		exit 1
	}
	[[ "$LANGFUSE_AUTH" =~ ^Basic\ [A-Za-z0-9+/=]+$ ]] || {
		echo "refusing Langfuse install: LANGFUSE_OTLP_AUTHORIZATION must be a Basic authorization value" >&2
		exit 1
	}
fi

HTTP_PORT="$(mk_config_get HTTP_PORT || echo 80)"

echo "==> building TypeScript runtime images"
mk_compose build web migrate-web bootstrap inspect-lifecycle dbos-worker

echo "==> starting PostgreSQL, Qdrant, and Redis"
mk_compose up -d --wait postgres qdrant redis

echo "==> applying Drizzle migrations"
mk_compose --profile migrate run --rm migrate-web

echo "==> configuring least-privilege database roles"
mk_compose --profile migrate run --rm configure-db-roles

echo "==> bootstrapping organization, workspace, and administrator"
mk_compose_bootstrap --profile migrate run --rm bootstrap

echo "==> starting DBOS worker and control loop"
if [[ "$WITH_OBSERVABILITY" -eq 1 ]]; then
	echo "==> starting optional observability backends"
	if [[ "$WITH_LANGFUSE" -eq 1 ]]; then
		mk_compose_langfuse up -d tempo loki alertmanager otel-collector prometheus grafana
	else
		mk_compose_observability up -d tempo loki alertmanager otel-collector prometheus grafana
	fi
fi
runtime_compose up -d --wait dbos-worker dbos-control

echo "==> reconciling and verifying lifecycle state"
mk_compose --profile ops run --rm backfill-acl-projections
mk_compose --profile ops run --rm inspect-lifecycle

echo "==> starting the product edge"
runtime_compose up -d --wait web caddy

if [[ "$WITH_OBSERVABILITY" -eq 1 ]]; then
	"${ROOT}/scripts/observability-smoke.sh"
fi

echo
echo "install complete"
echo "  UI:     http://localhost:${HTTP_PORT}/"
echo "  ready:  curl -sf http://localhost:${HTTP_PORT}/api/rag/health/ready"
echo "  runtime: Next.js control plane + native RAG + DBOS worker"
echo "  parser: external HTTP providers selected by ParserProvider"
if [[ "$WITH_OBSERVABILITY" -eq 1 ]]; then
	echo "  Grafana: http://127.0.0.1:$(mk_config_get GRAFANA_PORT || echo 3300)/"
fi
if [[ "$WITH_LANGFUSE" -eq 1 ]]; then
	echo "  Langfuse: metadata-only OTLP fan-out enabled"
fi
