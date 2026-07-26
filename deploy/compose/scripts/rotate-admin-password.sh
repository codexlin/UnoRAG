#!/usr/bin/env bash
# Opt-in admin password rotation via bootstrap upsert.
# Usage:
#   ./scripts/rotate-admin-password.sh
# Requires bootstrap.env with MERIKNOW_ADMIN_PASSWORD set to the new value.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "${ROOT}/scripts/compose-env.sh"

if [[ ! -f ../config/bootstrap.env ]]; then
	echo "missing ../config/bootstrap.env — run init-config.sh first" >&2
	exit 1
fi

ADMIN_PW="$(mk_config_get MERIKNOW_ADMIN_PASSWORD || true)"
if [[ -z "$ADMIN_PW" || "$ADMIN_PW" == "change-this-before-deployment" ]]; then
	echo "set MERIKNOW_ADMIN_PASSWORD in ../config/bootstrap.env to the new password first" >&2
	exit 1
fi

echo "==> rotating admin password (upsert)"
MERIKNOW_ADMIN_PASSWORD_UPSERT=1 mk_compose_bootstrap --profile migrate run --rm \
	-e MERIKNOW_ADMIN_PASSWORD_UPSERT=1 \
	bootstrap

echo "admin password rotated (value not printed)"
