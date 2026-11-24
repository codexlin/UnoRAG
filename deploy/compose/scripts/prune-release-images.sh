#!/usr/bin/env bash
# Safely prune obsolete UnoRAG release images while preserving active, rollback,
# and container-referenced images. Never uses --force and never touches volumes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "${ROOT}/scripts/compose-env.sh"
# shellcheck disable=SC1091
source "${ROOT}/scripts/release-env.sh"

RUNTIME_ADVANCED_ENV="$(cd "${ROOT}/../config" && pwd)/runtime.advanced.env"
PREVIOUS_ENV="${ROOT}/.upgrade-state/previous-images.env"
DRY_RUN=0
PRUNE_EXITED_OPS=0
EXTRA_MANIFESTS=()

usage() {
	cat <<'EOF'
Usage:
  prune-release-images.sh [--dry-run] [--prune-exited-ops] [--keep-manifest PATH]...

Options:
  --dry-run             Print protected and candidate images without removing anything.
  --prune-exited-ops    Remove exited one-shot ops/migration containers belonging only
                        to this COMPOSE_PROJECT_NAME before evaluating image references.
  --keep-manifest PATH  Preserve all four release images referenced in PATH (repeatable).
  -h, --help            Show this help message.

Preserves:
  - Every image referenced by any existing Docker container on this host
  - All four active images in deploy/config/runtime.advanced.env
  - All four rollback images in deploy/compose/.upgrade-state/previous-images.env
  - All images in any --keep-manifest file

Never invokes --force and never removes Docker volumes.
EOF
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }

while [[ $# -gt 0 ]]; do
	case "$1" in
		--dry-run) DRY_RUN=1; shift ;;
		--prune-exited-ops) PRUNE_EXITED_OPS=1; shift ;;
		--keep-manifest)
			[[ -n "${2:-}" ]] || die "--keep-manifest requires a file path"
			EXTRA_MANIFESTS+=("$2")
			shift 2
			;;
		-h|--help) usage; exit 0 ;;
		*) die "unknown argument: $1" ;;
	esac
done

command -v docker >/dev/null 2>&1 || die "docker is required"
[[ -f "$RUNTIME_ADVANCED_ENV" ]] || die "missing runtime configuration: $RUNTIME_ADVANCED_ENV"
for manifest in ${EXTRA_MANIFESTS[@]+"${EXTRA_MANIFESTS[@]}"}; do
	[[ -f "$manifest" ]] || die "keep manifest not found: $manifest"
done

PROJECT="$(mk_config_get COMPOSE_PROJECT_NAME || echo unorag)"

extract_repo_name() {
	local ref="$1"
	if [[ "$ref" == *@sha256:* ]]; then
		printf '%s\n' "${ref%%@sha256:*}"
		return 0
	fi
	# Strip trailing :tag only after the last slash (preserves host:port).
	local last_segment="${ref##*/}"
	if [[ "$last_segment" == *:* ]]; then
		printf '%s\n' "${ref%:*}"
		return 0
	fi
	printf '%s\n' "$ref"
}

REMOVED_CONTAINERS=0
if [[ "$PRUNE_EXITED_OPS" -eq 1 ]]; then
	ONE_SHOT_SERVICES=(
		migrate-web
		configure-db-roles
		document-storage-init
		bootstrap
		backfill-acl-projections
		check-dbos-drain
		inspect-lifecycle
	)
	for service in "${ONE_SHOT_SERVICES[@]}"; do
		while IFS= read -r container_id; do
			[[ -n "$container_id" ]] || continue
			if [[ "$DRY_RUN" -eq 1 ]]; then
				log "[dry-run] would remove exited one-shot container ${container_id} (project=${PROJECT}, service=${service})"
			else
				if docker rm "$container_id" >/dev/null; then
					log "removed exited one-shot container ${container_id} (project=${PROJECT}, service=${service})"
					REMOVED_CONTAINERS=$((REMOVED_CONTAINERS + 1))
				else
					warn "could not remove exited container ${container_id}; continuing"
				fi
			fi
		done < <(docker ps -aq \
			--filter "label=com.docker.compose.project=${PROJECT}" \
			--filter "label=com.docker.compose.service=${service}" \
			--filter "status=exited")
	done
fi

declare -A PROTECTED_REFS=()
declare -A PROTECTED_IDS=()
declare -A MANAGED_REPOS=()
ACTIVE_RESOLVED_COUNT=0

collect_manifest_images() {
	local file="$1" is_active="$2" key ref repo img_id
	for key in \
		UNORAG_WEB_IMAGE \
		UNORAG_WEB_MIGRATOR_IMAGE \
		UNORAG_WEB_OPS_IMAGE \
		UNORAG_DBOS_WORKER_IMAGE; do
		ref="$(mk_release_env_get "$file" "$key" || true)"
		[[ -n "$ref" ]] || continue
		PROTECTED_REFS["$ref"]=1
		repo="$(extract_repo_name "$ref")"
		[[ -n "$repo" ]] && MANAGED_REPOS["$repo"]=1
		img_id="$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)"
		if [[ -n "$img_id" ]]; then
			PROTECTED_IDS["$img_id"]=1
			if [[ "$is_active" == "1" ]]; then
				ACTIVE_RESOLVED_COUNT=$((ACTIVE_RESOLVED_COUNT + 1))
			fi
		fi
	done
}

collect_manifest_images "$RUNTIME_ADVANCED_ENV" 1
if [[ -f "$PREVIOUS_ENV" ]]; then
	collect_manifest_images "$PREVIOUS_ENV" 0
fi
for manifest in ${EXTRA_MANIFESTS[@]+"${EXTRA_MANIFESTS[@]}"}; do
	collect_manifest_images "$manifest" 0
done

if [[ "${#MANAGED_REPOS[@]}" -eq 0 ]]; then
	die "no managed UnoRAG image repositories found in $RUNTIME_ADVANCED_ENV; refusing to prune"
fi

# Collect every image ID referenced by any container on this Docker host.
declare -A CONTAINER_IMAGE_IDS=()
while IFS= read -r cid; do
	[[ -n "$cid" ]] || continue
	cimg="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
	[[ -n "$cimg" ]] && CONTAINER_IMAGE_IDS["$cimg"]=1
done < <(docker ps -aq)

# Also match protected digest/tag references directly from `docker images`
# so both overlay2 and containerd image stores resolve IDs consistently.
IMAGES_TABLE="$(docker images --no-trunc --digests --format '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Digest}}')"
while IFS=$'\t' read -r img_id repo tag digest; do
	[[ -n "$img_id" ]] || continue
	if [[ -n "$digest" && "$digest" != "<none>" && -n "${PROTECTED_REFS["${repo}@${digest}"]:-}" ]]; then
		PROTECTED_IDS["$img_id"]=1
		ACTIVE_RESOLVED_COUNT=$((ACTIVE_RESOLVED_COUNT + 1))
	fi
	if [[ -n "$tag" && "$tag" != "<none>" && -n "${PROTECTED_REFS["${repo}:${tag}"]:-}" ]]; then
		PROTECTED_IDS["$img_id"]=1
		ACTIVE_RESOLVED_COUNT=$((ACTIVE_RESOLVED_COUNT + 1))
	fi
done <<< "$IMAGES_TABLE"

if [[ "$ACTIVE_RESOLVED_COUNT" -eq 0 ]]; then
	die "none of the active runtime images in $RUNTIME_ADVANCED_ENV resolved locally; refusing to prune"
fi

declare -A SEEN_TARGETS=()
REMOVED_IMAGES=0
SKIPPED_IMAGES=0

while IFS=$'\t' read -r img_id repo tag digest; do
	[[ -n "$img_id" ]] || continue
	[[ -n "${MANAGED_REPOS["$repo"]:-}" ]] || continue
	if [[ -n "${PROTECTED_IDS["$img_id"]:-}" ]]; then
		continue
	fi
	if [[ -n "${CONTAINER_IMAGE_IDS["$img_id"]:-}" ]]; then
		SKIPPED_IMAGES=$((SKIPPED_IMAGES + 1))
		continue
	fi

	if [[ -n "$tag" && "$tag" != "<none>" ]]; then
		target="${repo}:${tag}"
	elif [[ -n "$digest" && "$digest" != "<none>" ]]; then
		target="${repo}@${digest}"
	else
		target="$img_id"
	fi

	[[ -z "${SEEN_TARGETS["$target"]:-}" ]] || continue
	SEEN_TARGETS["$target"]=1

	if [[ "$DRY_RUN" -eq 1 ]]; then
		log "[dry-run] would remove obsolete image ${target} (${img_id})"
		REMOVED_IMAGES=$((REMOVED_IMAGES + 1))
	else
		if docker image rm "$target" >/dev/null 2>&1; then
			log "removed obsolete image ${target}"
			REMOVED_IMAGES=$((REMOVED_IMAGES + 1))
		else
			warn "kept image ${target} (still referenced or already removed)"
			SKIPPED_IMAGES=$((SKIPPED_IMAGES + 1))
		fi
	fi
done <<< "$IMAGES_TABLE"

log "image prune summary: protected_ids=${#PROTECTED_IDS[@]} container_referenced_ids=${#CONTAINER_IMAGE_IDS[@]} removed_containers=${REMOVED_CONTAINERS} removed_images=${REMOVED_IMAGES} skipped_images=${SKIPPED_IMAGES}"
if [[ "$DRY_RUN" -eq 0 ]]; then
	docker system df || true
fi
