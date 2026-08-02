#!/usr/bin/env bash
# Private-deployment static stability battery. Run pilot-smoke for live checks.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REPORT_DIR="${UNORAG_STABILITY_REPORT_DIR:-/tmp/unorag-private-stability}"
mkdir -p "$REPORT_DIR"

echo "==> offline preflight"
"$ROOT/deploy/compose/scripts/pilot-preflight.sh" \
	| tee "$REPORT_DIR/preflight.log"

echo "==> formatting and lint"
pnpm --dir "$ROOT" --filter web lint | tee "$REPORT_DIR/lint.log"

if command -v helm >/dev/null 2>&1; then
	echo "==> Helm lint"
	helm lint "$ROOT/deploy/helm/unorag" --set config.openaiBaseUrl=http://llm \
		| tee "$REPORT_DIR/helm.log"
fi

echo "PASS: static stability reports in $REPORT_DIR"
