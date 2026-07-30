# UnoRAG local release (bypass GitHub-hosted Actions when billing is blocked).
# Requires: just (https://github.com/casey/just), Docker, optional uv/pnpm for check.
#
# Install: brew install just
# List:    just --list
#
# Examples:
#   just images v0.0.1-local
#   JUST_SKIP_CHECK=1 just release v0.0.1 registry.cn-hangzhou.aliyuncs.com/my-ns
#   just upgrade dist/release/release-registry.env

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

out := "dist/release"
default_platform := "linux/amd64"

default:
	@just --list

# --- quality (optional before release) ---

brand:
	./scripts/check_brand_residue.sh

# Fast local gates (not full CI). Skip with JUST_SKIP_CHECK=1 on release.
check: brand
	#!/usr/bin/env bash
	cd apps/api
	if command -v uv >/dev/null 2>&1; then
		uv sync --group dev
		uv run python scripts/run_release_gates.py \
			--mode ci \
			--baseline tests/eval/baselines/ci-deterministic.json \
			--report-out /tmp/unorag-ci-gate.json
	else
		echo "skip api gates: uv not found" >&2
	fi
	cd ../..
	if command -v pnpm >/dev/null 2>&1; then
		pnpm install --frozen-lockfile
		pnpm --filter web test
		pnpm --filter web lint
	else
		echo "skip web check: pnpm not found" >&2
	fi

# --- images ---

# Build five images locally (no push). Writes dist/release/release-local.env
# Usage: just images v0.0.1 [linux/amd64|local]
images tag platform=default_platform:
	#!/usr/bin/env bash
	[[ -n "{{tag}}" ]] || { echo "error: pass tag (never latest), e.g. just images v0.0.1" >&2; exit 1; }
	./scripts/release/local-images.sh build --tag "{{tag}}" --platform "{{platform}}" --out "{{out}}"

# Build + push web, migrator, API, outbox, and DBOS worker images + digest manifest
# Usage: just push v0.0.1 registry.example.com/ns [linux/amd64]
push tag registry platform=default_platform:
	#!/usr/bin/env bash
	[[ -n "{{tag}}" && -n "{{registry}}" ]] || {
		echo "error: just push TAG REGISTRY" >&2
		exit 1
	}
	./scripts/release/local-images.sh push --tag "{{tag}}" --registry "{{registry}}" --platform "{{platform}}" --out "{{out}}"

# check (unless JUST_SKIP_CHECK=1) → push → print upgrade hint
# Usage: JUST_SKIP_CHECK=1 just release v0.0.1 registry.example.com/ns
release tag registry platform=default_platform:
	#!/usr/bin/env bash
	[[ -n "{{tag}}" && -n "{{registry}}" ]] || {
		echo "error: just release TAG REGISTRY" >&2
		exit 1
	}
	if [[ "${JUST_SKIP_CHECK:-}" != "1" ]]; then
		just check
	else
		echo "==> skip check (JUST_SKIP_CHECK=1)"
	fi
	./scripts/release/local-images.sh release --tag "{{tag}}" --registry "{{registry}}" --platform "{{platform}}" --out "{{out}}"
	echo
	echo "Next (on deploy host):"
	echo "  ./deploy/compose/scripts/backup.sh ./backups/pre-upgrade"
	echo "  ./deploy/compose/scripts/upgrade.sh --manifest {{out}}/release-registry.env"

# Run upgrade.sh against a manifest (must be executed where compose stack lives)
upgrade manifest:
	./deploy/compose/scripts/upgrade.sh --manifest "{{manifest}}"
