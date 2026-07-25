#!/usr/bin/env bash
# L9 pilot preflight: offline isolation unit test + CI quality gate fuses.
# Does not require Compose. Exit: 0=pass, 1=fail, 2=skip (missing deps).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_DIR="$ROOT/apps/api"

log() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }

if [[ ! -d "$API_DIR" ]]; then
	warn "apps/api not found at $API_DIR"
	exit 2
fi

cd "$API_DIR"

if ! command -v uv >/dev/null 2>&1; then
	warn "SKIP pilot-preflight: uv not found"
	warn "Install uv (https://docs.astral.sh/uv/) and re-run from repo with apps/api deps."
	exit 2
fi

log "cross-tenant / workspace / group isolation unit test"
set +e
uv run pytest tests/test_access_scope.py -q --tb=short
ISO_RC=$?
set -e
if [[ $ISO_RC -ne 0 ]]; then
	warn "isolation unit test FAILED (exit $ISO_RC)"
	exit 1
fi

log "CI release gate (fuse / isolation hard stops)"
REPORT="${MERIKNOW_GATE_REPORT:-/tmp/meriknow-pilot-preflight-gate.json}"
set +e
# Defensive: host .env may set INTERNAL_AUTH_ENABLED=true; eval isolates anyway.
INTERNAL_AUTH_ENABLED=false uv run python scripts/run_release_gates.py --mode ci \
	--baseline tests/eval/baselines/ci-deterministic.json \
	--report-out "$REPORT"
GATE_RC=$?
set -e
if [[ $GATE_RC -ne 0 ]]; then
	warn "CI quality gate FAILED (exit $GATE_RC); report=$REPORT"
	exit 1
fi

log "preflight PASS (isolation + CI gate); report=$REPORT"
exit 0
