# UnoRAG local release (bypass GitHub-hosted Actions when billing is blocked).
# Requires: just (https://github.com/casey/just), Docker, optional uv/pnpm for check.
#
# Install: brew install just
# List:    just --list

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# Override: just release tag=v0.1.0 registry=registry.cn-hangzhou.aliyuncs.com/my-ns
tag := ""
registry := ""
out := "dist/release"
platform := "linux/amd64"
manifest := "dist/release/release-registry.env"

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

# Build three images locally (no push). Writes dist/release/release-local.env
images tag=tag platform=platform:
	#!/usr/bin/env bash
	[[ -n "{{tag}}" ]] || { echo "error: pass tag=... (never latest)" >&2; exit 1; }
	./scripts/release/local-images.sh build --tag "{{tag}}" --platform "{{platform}}" --out "{{out}}"

# Build + push to REGISTRY/unorag:{web,api,migrator}-TAG + digest manifest
push tag=tag registry=registry platform=platform out=out:
	#!/usr/bin/env bash
	[[ -n "{{tag}}" ]] || { echo "error: pass tag=..." >&2; exit 1; }
	[[ -n "{{registry}}" ]] || { echo "error: pass registry=HOST/NAMESPACE" >&2; exit 1; }
	./scripts/release/local-images.sh push --tag "{{tag}}" --registry "{{registry}}" --platform "{{platform}}" --out "{{out}}"

# check (unless JUST_SKIP_CHECK=1) → push → print upgrade hint
release tag=tag registry=registry platform=platform out=out:
	#!/usr/bin/env bash
	[[ -n "{{tag}}" ]] || { echo "error: pass tag=..." >&2; exit 1; }
	[[ -n "{{registry}}" ]] || { echo "error: pass registry=HOST/NAMESPACE" >&2; exit 1; }
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
upgrade manifest=manifest:
	./deploy/compose/scripts/upgrade.sh --manifest "{{manifest}}"
