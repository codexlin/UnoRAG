#!/usr/bin/env bash
# Local (or self-hosted) image build / push / manifest — same pins as upgrade.sh.
#
# Build once → optional push → write release.env with digest refs.
# Rejects empty tags and :latest. Does not talk to GitHub Actions.
#
# Usage:
#   ./scripts/release/local-images.sh build   --tag v0.0.1
#   ./scripts/release/local-images.sh push    --tag v0.0.1 --registry registry.example.com/ns
#   ./scripts/release/local-images.sh release --tag v0.0.1 --registry registry.example.com/ns --out dist/release
#
# Image naming (aligned with release-images.yml):
#   local:    unorag-web:TAG / unorag-api:TAG / unorag-web-migrator:TAG / unorag-web-outbox:TAG
#   registry: REGISTRY/unorag:web-TAG | :api-TAG | :migrator-TAG | :outbox-TAG
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

CMD=""
TAG=""
REGISTRY=""
OUT_DIR="${ROOT}/dist/release"
PLATFORM="linux/amd64"
PUSH=0

usage() {
	cat <<'EOF'
Local image build / push / digest manifest (GH Actions bypass).

Usage:
  local-images.sh build   --tag TAG [--platform linux/amd64|local]
  local-images.sh push    --tag TAG --registry HOST/NAMESPACE [--platform ...]
  local-images.sh release --tag TAG --registry HOST/NAMESPACE [--out DIR] [--platform ...]

  build    Build four targets into the local Docker engine (no push).
  push     Build (if needed), tag for registry, push, write digest manifest.
  release  Alias for push + always write manifest under --out.

Rejects empty TAG and the floating tag "latest".
Default --platform is linux/amd64 (server deploy from Apple Silicon).
Use --platform local for native arch only (not for amd64 servers).
EOF
	exit "${1:-0}"
}

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

assert_tag() {
	local t="$1"
	[[ -n "$t" ]] || die "empty --tag"
	[[ "$t" != "latest" ]] || die "refusing floating tag 'latest'"
	[[ "$t" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "invalid tag: $t"
}

resolve_platform() {
	if [[ "$PLATFORM" == "local" ]]; then
		PLATFORM=""
	fi
}

local_web() { echo "unorag-web:${TAG}"; }
local_api() { echo "unorag-api:${TAG}"; }
local_migrator() { echo "unorag-web-migrator:${TAG}"; }
local_outbox() { echo "unorag-web-outbox:${TAG}"; }

remote_repo() {
	[[ -n "$REGISTRY" ]] || die "--registry required (e.g. registry.cn-hangzhou.aliyuncs.com/my-ns)"
	local r="${REGISTRY%/}"
	echo "${r}/unorag"
}

remote_web() { echo "$(remote_repo):web-${TAG}"; }
remote_api() { echo "$(remote_repo):api-${TAG}"; }
remote_migrator() { echo "$(remote_repo):migrator-${TAG}"; }
remote_outbox() { echo "$(remote_repo):outbox-${TAG}"; }

build_images() {
	local plat_args=()
	if [[ -n "${PLATFORM}" ]]; then
		plat_args=(--platform "$PLATFORM")
		log "platform=${PLATFORM}"
	else
		log "platform=local (native)"
	fi

	log "build web runner → $(local_web)"
	docker build "${plat_args[@]}" \
		-f deploy/docker/web.Dockerfile \
		--target runner \
		-t "$(local_web)" \
		.

	log "build web migrator → $(local_migrator)"
	docker build "${plat_args[@]}" \
		-f deploy/docker/web.Dockerfile \
		--target migrator \
		-t "$(local_migrator)" \
		.

	log "build web outbox → $(local_outbox)"
	docker build "${plat_args[@]}" \
		-f deploy/docker/web.Dockerfile \
		--target outbox \
		-t "$(local_outbox)" \
		.

	log "build api → $(local_api)"
	docker build "${plat_args[@]}" \
		-f deploy/docker/api.Dockerfile \
		-t "$(local_api)" \
		.
}

tag_for_registry() {
	docker tag "$(local_web)" "$(remote_web)"
	docker tag "$(local_api)" "$(remote_api)"
	docker tag "$(local_migrator)" "$(remote_migrator)"
	docker tag "$(local_outbox)" "$(remote_outbox)"
}

push_images() {
	log "push $(remote_web)"
	docker push "$(remote_web)"
	log "push $(remote_api)"
	docker push "$(remote_api)"
	log "push $(remote_migrator)"
	docker push "$(remote_migrator)"
	log "push $(remote_outbox)"
	docker push "$(remote_outbox)"
}

digest_of() {
	local ref="$1"
	local dig
	dig="$(docker image inspect --format '{{index .RepoDigests 0}}' "$ref" 2>/dev/null || true)"
	if [[ -n "$dig" && "$dig" == *@sha256:* ]]; then
		echo "${dig#*@}"
		return 0
	fi
	dig="$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)"
	[[ "$dig" == sha256:* ]] || die "cannot resolve digest for $ref"
	echo "$dig"
}

write_manifest() {
	local out="$1"
	local mode="$2" # local | registry
	mkdir -p "$out"
	local web_ref api_ref mig_ref out_ref web_d api_d mig_d out_d
	local env_file json_file

	if [[ "$mode" == "registry" ]]; then
		web_ref="$(remote_web)"
		api_ref="$(remote_api)"
		mig_ref="$(remote_migrator)"
		out_ref="$(remote_outbox)"
		env_file="${out}/release-registry.env"
		json_file="${out}/release-manifest.json"
	else
		web_ref="$(local_web)"
		api_ref="$(local_api)"
		mig_ref="$(local_migrator)"
		out_ref="$(local_outbox)"
		env_file="${out}/release-local.env"
		json_file="${out}/release-manifest.local.json"
	fi

	web_d="$(digest_of "$web_ref")"
	api_d="$(digest_of "$api_ref")"
	mig_d="$(digest_of "$mig_ref")"
	out_d="$(digest_of "$out_ref")"

	if [[ "$mode" == "registry" ]]; then
		local repo
		repo="$(remote_repo)"
		cat >"$env_file" <<EOF
UNORAG_WEB_IMAGE=${repo}@${web_d}
UNORAG_API_IMAGE=${repo}@${api_d}
UNORAG_WEB_MIGRATOR_IMAGE=${repo}@${mig_d}
UNORAG_OUTBOX_IMAGE=${repo}@${out_d}
EOF
	else
		cat >"$env_file" <<EOF
UNORAG_WEB_IMAGE=${web_ref}
UNORAG_API_IMAGE=${api_ref}
UNORAG_WEB_MIGRATOR_IMAGE=${mig_ref}
UNORAG_OUTBOX_IMAGE=${out_ref}
EOF
	fi

	cat >"$json_file" <<EOF
{
  "tag": "${TAG}",
  "git_sha": "$(git rev-parse HEAD 2>/dev/null || echo unknown)",
  "platform": "${PLATFORM:-local}",
  "mode": "${mode}",
  "images": {
    "web": {"ref": "${web_ref}", "digest": "${web_d}"},
    "api": {"ref": "${api_ref}", "digest": "${api_d}"},
    "migrator": {"ref": "${mig_ref}", "digest": "${mig_d}"},
    "outbox": {"ref": "${out_ref}", "digest": "${out_d}"}
  },
  "manifest_env": "$(basename "$env_file")"
}
EOF

	log "wrote ${env_file}"
	log "wrote ${json_file}"
	if [[ "$mode" == "registry" ]]; then
		log "deploy with: ./deploy/compose/scripts/upgrade.sh --manifest ${env_file}"
	else
		log "local env only — push with: just push ${TAG} HOST/NAMESPACE"
	fi
	cat "$env_file"
}

[[ $# -gt 0 ]] || usage 1
case "$1" in
	-h | --help) usage 0 ;;
	build | push | release)
		CMD="$1"
		shift
		;;
	*)
		die "unknown command: $1 (see --help)"
		;;
esac

while [[ $# -gt 0 ]]; do
	case "$1" in
		--tag)
			TAG="${2:-}"
			shift 2
			;;
		--registry)
			REGISTRY="${2:-}"
			shift 2
			;;
		--out)
			OUT_DIR="${2:-}"
			shift 2
			;;
		--platform)
			PLATFORM="${2:-}"
			shift 2
			;;
		-h | --help) usage 0 ;;
		*)
			die "unknown argument: $1"
			;;
	esac
done

assert_tag "$TAG"
resolve_platform

case "$CMD" in
	build)
		build_images
		write_manifest "$OUT_DIR" local
		;;
	push | release)
		[[ -n "$REGISTRY" ]] || die "--registry required for ${CMD}"
		PUSH=1
		build_images
		tag_for_registry
		push_images
		write_manifest "$OUT_DIR" registry
		;;
esac

log "done (push=${PUSH})"
