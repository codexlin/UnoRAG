#!/usr/bin/env bash
# Private-deployment stability battery (release go/no-go).
# Does NOT run ablation — that is an experimental quality tool.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
API="$ROOT/apps/api"
REPORT_DIR="${MERIKNOW_STABILITY_REPORT_DIR:-/tmp/meriknow-private-stability}"
mkdir -p "$REPORT_DIR"

log() { printf '==> %s\n' "$*"; }

log "private stability battery → $REPORT_DIR"

log "1/3 pilot-preflight (isolation + CI gate)"
bash "$ROOT/deploy/compose/scripts/pilot-preflight.sh" \
	| tee "$REPORT_DIR/preflight.log"

log "2/3 API eval cases + release gate ci"
cd "$API"
INTERNAL_AUTH_ENABLED=false uv run python scripts/run_eval_cases.py \
	| tee "$REPORT_DIR/eval_cases.log"
INTERNAL_AUTH_ENABLED=false uv run python scripts/run_release_gates.py --mode ci \
	--report-out "$REPORT_DIR/gate-ci.json"

log "3/3 focused contract tests (policy / gates / eval runner)"
INTERNAL_AUTH_ENABLED=false uv run pytest \
	tests/eval/test_eval_cases_runner.py \
	tests/eval/test_release_gates.py \
	tests/eval/test_ablation_matrix.py \
	tests/test_policy_profiles.py \
	-q --tb=line \
	| tee "$REPORT_DIR/pytest-focused.log"

log "PASS — reports in $REPORT_DIR"
log "Note: run_ablation_matrix.py is experimental; not part of this battery."
