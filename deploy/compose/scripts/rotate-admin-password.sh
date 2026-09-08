#!/usr/bin/env bash
# Opt-in admin password rotation via bootstrap upsert.
# Usage:
#   ./scripts/rotate-admin-password.sh
# Requires bootstrap.env with UNORAG_ADMIN_PASSWORD set to the new value.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "${ROOT}/scripts/compose-env.sh"

if [[ ! -f ../config/bootstrap.env ]]; then
	echo "missing ../config/bootstrap.env — run init-config.sh first" >&2
	exit 1
fi

ADMIN_PW="$(mk_config_get UNORAG_ADMIN_PASSWORD || true)"
if [[ ${#ADMIN_PW} -lt 7 || ${#ADMIN_PW} -gt 256 || ! "$ADMIN_PW" =~ [[:lower:]] || ! "$ADMIN_PW" =~ [[:upper:]] || "$ADMIN_PW" == "change-this-before-deployment" ]]; then
	echo "set UNORAG_ADMIN_PASSWORD to 7-256 characters with uppercase and lowercase letters first" >&2
	exit 1
fi

echo "==> rotating admin password (upsert)"
UNORAG_ADMIN_PASSWORD_UPSERT=1 mk_compose_bootstrap --profile migrate run --rm \
	-e UNORAG_ADMIN_PASSWORD_UPSERT=1 \
	bootstrap

umask 077
printf '%s\n' "$ADMIN_PW" >"${ROOT}/.smoke-admin-password"
chmod 600 "${ROOT}/.smoke-admin-password"

echo "admin password rotated; first-login change required (value not printed)"
