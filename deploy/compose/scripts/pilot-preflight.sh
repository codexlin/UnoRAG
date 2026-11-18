#!/usr/bin/env bash
# Offline release preflight for the native TypeScript RAG runtime.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

command -v pnpm >/dev/null 2>&1 || {
	echo "SKIP pilot-preflight: pnpm not found" >&2
	exit 2
}

echo "==> deterministic product, security, retrieval, and lifecycle tests"
pnpm test:fast

echo "==> Web control-plane contract tests"
pnpm test:contract

echo "==> static types and migration history"
pnpm typecheck
pnpm db:check

echo "preflight PASS"
