#!/usr/bin/env bash
# One-time bundled-Postgres transition from shared DSNs to isolated logins.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRET_FILE="${ROOT}/../config/runtime.secret"

if [[ "${1:-}" != "--bundled-postgres" || $# -ne 1 ]]; then
	echo "usage: $0 --bundled-postgres" >&2
	echo "external PostgreSQL operators must provision login roles and DSN overrides themselves" >&2
	exit 2
fi
if [[ ! -f "$SECRET_FILE" ]]; then
	echo "missing ${SECRET_FILE}; run ./scripts/init-config.sh first" >&2
	exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
	echo "openssl is required to generate runtime database passwords" >&2
	exit 1
fi

get_value() {
	local key="$1"
	awk -F= -v k="$key" '
		$1 == k { value = substr($0, index($0, "=") + 1) }
		END { print value }
	' "$SECRET_FILE"
}

resolve_password() {
	local key="$1" value
	value="$(get_value "$key")"
	if [[ -z "$value" ]]; then
		value="$(openssl rand -hex 32)"
	fi
	if [[ "${#value}" -lt 32 || ! "$value" =~ ^[A-Za-z0-9._~-]+$ ]]; then
		echo "${key} must be at least 32 URL-safe characters" >&2
		exit 1
	fi
	printf '%s' "$value"
}

WEB_PASSWORD="$(resolve_password UNORAG_WEB_DB_PASSWORD)"
API_PASSWORD="$(resolve_password UNORAG_API_DB_PASSWORD)"
WORKER_PASSWORD="$(resolve_password UNORAG_WORKER_DB_PASSWORD)"
OUTBOX_PASSWORD="$(resolve_password UNORAG_OUTBOX_DB_PASSWORD)"
RAG_READ_PASSWORD="$(resolve_password UNORAG_RAG_READ_DB_PASSWORD)"
DBOS_PASSWORD="$(resolve_password UNORAG_DBOS_DB_PASSWORD)"

tmp="$(mktemp "${SECRET_FILE}.tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
chmod 600 "$tmp"

awk '
	BEGIN {
		skip["DATABASE_URL"] = 1
		skip["WEB_DATABASE_URL"] = 1
		skip["API_DATABASE_URL"] = 1
		skip["WORKER_DATABASE_URL"] = 1
		skip["OUTBOX_DATABASE_URL"] = 1
		skip["RAG_READ_DATABASE_URL"] = 1
		skip["MIGRATOR_DATABASE_URL"] = 1
		skip["UNORAG_WEB_DB_PASSWORD"] = 1
		skip["UNORAG_API_DB_PASSWORD"] = 1
		skip["UNORAG_WORKER_DB_PASSWORD"] = 1
		skip["UNORAG_OUTBOX_DB_PASSWORD"] = 1
		skip["UNORAG_RAG_READ_DB_PASSWORD"] = 1
		skip["UNORAG_DBOS_DB_PASSWORD"] = 1
		skip["DBOS_SYSTEM_DATABASE_URL"] = 1
	}
	{
		key = $0
		sub(/=.*/, "", key)
		if (!skip[key]) print
	}
' "$SECRET_FILE" >"$tmp"

{
	printf '\n# Bundled PostgreSQL least-privilege runtime logins (generated; URL-safe)\n'
	printf 'UNORAG_WEB_DB_PASSWORD=%s\n' "$WEB_PASSWORD"
	printf 'UNORAG_API_DB_PASSWORD=%s\n' "$API_PASSWORD"
	printf 'UNORAG_WORKER_DB_PASSWORD=%s\n' "$WORKER_PASSWORD"
	printf 'UNORAG_OUTBOX_DB_PASSWORD=%s\n' "$OUTBOX_PASSWORD"
	printf 'UNORAG_RAG_READ_DB_PASSWORD=%s\n' "$RAG_READ_PASSWORD"
	printf 'UNORAG_DBOS_DB_PASSWORD=%s\n' "$DBOS_PASSWORD"
} >>"$tmp"

mv "$tmp" "$SECRET_FILE"
trap - EXIT
chmod 600 "$SECRET_FILE"

echo "prepared isolated bundled-Postgres credentials in ${SECRET_FILE}"
echo "shared runtime DSN overrides were removed; no secret values were printed"
