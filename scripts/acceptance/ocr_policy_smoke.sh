#!/usr/bin/env bash
# Deterministic OCR policy + MinerU unavailable smoke.
#
# Uses a released ephemeral loopback port to produce a real connection-refused
# fault. It never reads or calls the configured production MinerU endpoint.
set -euo pipefail

ACC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$ACC_DIR/../.." && pwd)"
REPORT="${MERIKNOW_OCR_SMOKE_REPORT:-$ACC_DIR/.ocr_policy_last_run.json}"

command -v uv >/dev/null 2>&1 || {
	printf 'BLOCKED: uv is required\n' >&2
	exit 2
}

cd "$ROOT/apps/api"
UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/meriknow-uv}" \
	PYTHONPYCACHEPREFIX="${PYTHONPYCACHEPREFIX:-/tmp/meriknow-ocr-smoke-pycache}" \
	PYTHONPATH=. \
	uv run python "$ACC_DIR/ocr_policy_smoke.py" --report "$REPORT"
