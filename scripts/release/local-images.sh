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
#   local:    web / migrator / ops / DBOS worker
#   registry: REGISTRY/unorag:web-TAG | :migrator-TAG | :ops-TAG | :worker-TAG
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

dbos_application_version() {
	local sha
	sha="$(git rev-parse --verify HEAD 2>/dev/null || true)"
	if [[ "$sha" =~ ^[0-9a-fA-F]{40,64}$ ]]; then
		echo "unorag-${sha:0:16}"
	else
		# Source archives may not include .git; the validated release tag remains
		# deterministic and is bounded to DBOS's 128-character identifier limit.
		echo "unorag-${TAG:0:120}"
	fi
}

resolve_platform() {
	if [[ "$PLATFORM" == "local" ]]; then
		PLATFORM=""
	fi
}

local_web() { echo "unorag-web:${TAG}"; }
local_migrator() { echo "unorag-web-migrator:${TAG}"; }
local_ops() { echo "unorag-web-ops:${TAG}"; }
local_worker() { echo "unorag-web-worker:${TAG}"; }

remote_repo() {
	[[ -n "$REGISTRY" ]] || die "--registry required (e.g. registry.cn-hangzhou.aliyuncs.com/my-ns)"
	local r="${REGISTRY%/}"
	echo "${r}/unorag"
}

remote_web() { echo "$(remote_repo):web-${TAG}"; }
remote_migrator() { echo "$(remote_repo):migrator-${TAG}"; }
remote_ops() { echo "$(remote_repo):ops-${TAG}"; }
remote_worker() { echo "$(remote_repo):worker-${TAG}"; }

build_images() {
	local plat_args=()
	if [[ -n "${PLATFORM}" ]]; then
		plat_args=(--platform "$PLATFORM")
		log "platform=${PLATFORM}"
	else
		log "platform=local (native)"
	fi

	log "build web runner → $(local_web)"
	docker build ${plat_args[@]+"${plat_args[@]}"} \
		-f deploy/docker/web.Dockerfile \
		--target runner \
		-t "$(local_web)" \
		.

	log "build web migrator → $(local_migrator)"
	docker build ${plat_args[@]+"${plat_args[@]}"} \
		-f deploy/docker/web.Dockerfile \
		--target migrator \
		-t "$(local_migrator)" \
		.

	log "build web operations image → $(local_ops)"
	docker build ${plat_args[@]+"${plat_args[@]}"} \
		-f deploy/docker/web.Dockerfile \
		--target ops \
		-t "$(local_ops)" \
		.

	log "build DBOS worker → $(local_worker)"
	docker build ${plat_args[@]+"${plat_args[@]}"} \
		-f deploy/docker/web.Dockerfile \
		--target worker \
		-t "$(local_worker)" \
		.
}

tag_for_registry() {
	docker tag "$(local_web)" "$(remote_web)"
	docker tag "$(local_migrator)" "$(remote_migrator)"
	docker tag "$(local_ops)" "$(remote_ops)"
	docker tag "$(local_worker)" "$(remote_worker)"
}

push_images() {
	log "push $(remote_web)"
	docker push "$(remote_web)"
	log "push $(remote_migrator)"
	docker push "$(remote_migrator)"
	log "push $(remote_ops)"
	docker push "$(remote_ops)"
	log "push $(remote_worker)"
	docker push "$(remote_worker)"
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
	local web_ref mig_ref ops_ref worker_ref web_d mig_d ops_d worker_d
	local env_file json_file dbos_version image_platform
	dbos_version="$(dbos_application_version)"
	if [[ -n "$PLATFORM" ]]; then
		image_platform="$PLATFORM"
	else
		image_platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$(local_web)")"
	fi

	if [[ "$mode" == "registry" ]]; then
		web_ref="$(remote_web)"
		mig_ref="$(remote_migrator)"
		ops_ref="$(remote_ops)"
		worker_ref="$(remote_worker)"
		env_file="${out}/release-registry.env"
		json_file="${out}/release-manifest.json"
	else
		web_ref="$(local_web)"
		mig_ref="$(local_migrator)"
		ops_ref="$(local_ops)"
		worker_ref="$(local_worker)"
		env_file="${out}/release-local.env"
		json_file="${out}/release-manifest.local.json"
	fi

	web_d="$(digest_of "$web_ref")"
	mig_d="$(digest_of "$mig_ref")"
	ops_d="$(digest_of "$ops_ref")"
	worker_d="$(digest_of "$worker_ref")"

	if [[ "$mode" == "registry" ]]; then
		local repo
		repo="$(remote_repo)"
		cat >"$env_file" <<EOF
UNORAG_WEB_IMAGE=${repo}@${web_d}
UNORAG_WEB_MIGRATOR_IMAGE=${repo}@${mig_d}
UNORAG_WEB_OPS_IMAGE=${repo}@${ops_d}
UNORAG_DBOS_WORKER_IMAGE=${repo}@${worker_d}
UNORAG_DBOS_APPLICATION_VERSION=${dbos_version}
UNORAG_IMAGE_PLATFORM=${image_platform}
EOF
	else
		cat >"$env_file" <<EOF
UNORAG_WEB_IMAGE=${web_ref}
UNORAG_WEB_MIGRATOR_IMAGE=${mig_ref}
UNORAG_WEB_OPS_IMAGE=${ops_ref}
UNORAG_DBOS_WORKER_IMAGE=${worker_ref}
UNORAG_DBOS_APPLICATION_VERSION=${dbos_version}
UNORAG_IMAGE_PLATFORM=${image_platform}
EOF
	fi

	cat >"$json_file" <<EOF
{
  "tag": "${TAG}",
  "git_sha": "$(git rev-parse HEAD 2>/dev/null || echo unknown)",
  "platform": "${image_platform}",
  "mode": "${mode}",
  "dbos_application_version": "${dbos_version}",
  "images": {
    "web": {"ref": "${web_ref}", "digest": "${web_d}"},
    "migrator": {"ref": "${mig_ref}", "digest": "${mig_d}"},
    "ops": {"ref": "${ops_ref}", "digest": "${ops_d}"},
    "worker": {"ref": "${worker_ref}", "digest": "${worker_d}"}
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
