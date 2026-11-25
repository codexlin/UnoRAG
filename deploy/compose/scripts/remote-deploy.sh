#!/usr/bin/env bash
# Single-entry Compose release deploy runner for GitHub Actions CD or operators.
# Performs lock acquisition, manifest identity checks, optional clean tag sync,
# verified pre-upgrade backup with retention, signed upgrade, lifecycle gate,
# and optional safe image pruning.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${ROOT}/../.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "${ROOT}/scripts/compose-env.sh"
# shellcheck disable=SC1091
source "${ROOT}/scripts/release-env.sh"

MANIFEST=""
RELEASE_TAG=""
EXPECTED_REVISION=""
BACKUP_ROOT=""
BACKUP_RETAIN="3"
SYNC_CHECKOUT=0
PRUNE_OLD_IMAGES=0
SKIP_SMOKE=0

usage() {
	cat <<'EOF'
Usage:
  remote-deploy.sh \
    --manifest PATH \
    --release-tag vX.Y.Z \
    --expected-revision 40-HEX-SHA \
    [--backup-root PATH] \
    [--backup-retain N] \
    [--sync-checkout] \
    [--prune-old-images] \
    [--skip-smoke]

Notes:
  - Requires a signed digest manifest (UNORAG_VERIFY_IMAGE_SIGNATURES=true).
  - Acquires an exclusive non-blocking flock under deploy/compose/.upgrade-state/deploy.lock.
  - --sync-checkout fails closed if tracked files in the deployment git checkout are dirty.
  - Database migrations are forward-only; previous image pins remain in .upgrade-state/previous-images.env.
EOF
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '==> %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
	case "$1" in
		--manifest) MANIFEST="${2:-}"; shift 2 ;;
		--release-tag) RELEASE_TAG="${2:-}"; shift 2 ;;
		--expected-revision) EXPECTED_REVISION="${2:-}"; shift 2 ;;
		--backup-root) BACKUP_ROOT="${2:-}"; shift 2 ;;
		--backup-retain) BACKUP_RETAIN="${2:-}"; shift 2 ;;
		--sync-checkout) SYNC_CHECKOUT=1; shift ;;
		--prune-old-images) PRUNE_OLD_IMAGES=1; shift ;;
		--skip-smoke) SKIP_SMOKE=1; shift ;;
		-h|--help) usage; exit 0 ;;
		*) die "unknown argument: $1" ;;
	esac
done

[[ -n "$MANIFEST" && -f "$MANIFEST" ]] || die "manifest file not found: ${MANIFEST:-<empty>}"
[[ "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] \
	|| die "invalid release tag: ${RELEASE_TAG:-<empty>}"
[[ "$EXPECTED_REVISION" =~ ^[a-f0-9]{40}$ ]] \
	|| die "expected revision must be a 40-character lowercase git SHA"
[[ "$BACKUP_RETAIN" =~ ^[1-9][0-9]*$ ]] \
	|| die "backup retain count must be a positive integer: ${BACKUP_RETAIN:-<empty>}"

if [[ -z "$BACKUP_ROOT" ]]; then
	BACKUP_ROOT="${ROOT}/backups"
fi

STATE_DIR="${ROOT}/.upgrade-state"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
LOCK_FILE="${STATE_DIR}/deploy.lock"
exec 9>"$LOCK_FILE"
if command -v flock >/dev/null 2>&1; then
	flock -n 9 || die "another deployment is already in progress (${LOCK_FILE})"
fi

MANIFEST_VERSION="$(mk_release_env_get "$MANIFEST" UNORAG_VERSION)"
MANIFEST_REVISION="$(mk_release_env_get "$MANIFEST" UNORAG_REVISION)"
MANIFEST_VERIFY_SIG="$(mk_release_env_get "$MANIFEST" UNORAG_VERIFY_IMAGE_SIGNATURES)"
MANIFEST_DBOS_VERSION="$(mk_release_env_get "$MANIFEST" UNORAG_DBOS_APPLICATION_VERSION)"
EXPECTED_VERSION="${RELEASE_TAG#v}"
EXPECTED_DBOS_VERSION="unorag-${EXPECTED_REVISION:0:16}"

[[ "$MANIFEST_VERIFY_SIG" == "true" ]] \
	|| die "production deploy requires UNORAG_VERIFY_IMAGE_SIGNATURES=true in manifest"
[[ "$MANIFEST_VERSION" == "$EXPECTED_VERSION" ]] \
	|| die "manifest UNORAG_VERSION (${MANIFEST_VERSION:-<empty>}) does not match release tag ${RELEASE_TAG}"
[[ "$MANIFEST_REVISION" == "$EXPECTED_REVISION" ]] \
	|| die "manifest UNORAG_REVISION (${MANIFEST_REVISION:-<empty>}) does not match expected revision ${EXPECTED_REVISION}"
[[ "$MANIFEST_DBOS_VERSION" == "$EXPECTED_DBOS_VERSION" ]] \
	|| die "manifest UNORAG_DBOS_APPLICATION_VERSION (${MANIFEST_DBOS_VERSION:-<empty>}) does not match ${EXPECTED_DBOS_VERSION}"

for key in UNORAG_WEB_IMAGE UNORAG_WEB_MIGRATOR_IMAGE UNORAG_WEB_OPS_IMAGE UNORAG_DBOS_WORKER_IMAGE; do
	mk_release_assert_image "$key" "$(mk_release_env_get "$MANIFEST" "$key")" digest
done

log "pre-deploy disk usage"
df -h "$ROOT" || true

if [[ "$SYNC_CHECKOUT" -eq 1 && -d "${REPO_ROOT}/.git" ]]; then
	log "syncing deployment checkout to immutable tag ${RELEASE_TAG}"
	git -c safe.directory="$REPO_ROOT" -C "$REPO_ROOT" diff --quiet || die "deployment checkout has unstaged modifications to tracked files"
	git -c safe.directory="$REPO_ROOT" -C "$REPO_ROOT" diff --cached --quiet || die "deployment checkout has staged modifications to tracked files"
	git -c safe.directory="$REPO_ROOT" -C "$REPO_ROOT" fetch --tags origin
	TAG_COMMIT="$(git -c safe.directory="$REPO_ROOT" -C "$REPO_ROOT" rev-parse "${RELEASE_TAG}^{commit}" 2>/dev/null || true)"
	[[ "$TAG_COMMIT" == "$EXPECTED_REVISION" ]] \
		|| die "tag ${RELEASE_TAG} resolves to ${TAG_COMMIT:-<missing>}, expected ${EXPECTED_REVISION}"
	git -c safe.directory="$REPO_ROOT" -C "$REPO_ROOT" checkout --detach "${RELEASE_TAG}"
fi

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_ROOT}/pre-${RELEASE_TAG}-${TIMESTAMP}"
mkdir -p "$BACKUP_ROOT"

log "creating verified pre-upgrade backup → ${BACKUP_DIR} (retain=${BACKUP_RETAIN})"
"${ROOT}/scripts/backup.sh" --retain "$BACKUP_RETAIN" "$BACKUP_DIR"

UPGRADE_ARGS=(--manifest "$MANIFEST")
if [[ "$SKIP_SMOKE" -eq 1 ]]; then
	UPGRADE_ARGS+=(--skip-smoke)
fi
if [[ "$PRUNE_OLD_IMAGES" -eq 1 ]]; then
	UPGRADE_ARGS+=(--prune-old-images)
fi

log "running signed upgrade to ${RELEASE_TAG} (${EXPECTED_REVISION:0:12})"
"${ROOT}/scripts/upgrade.sh" "${UPGRADE_ARGS[@]}"

log "verifying post-upgrade lifecycle invariants"
mk_compose --profile ops run --rm inspect-lifecycle

log "post-deploy disk usage"
df -h "$ROOT" || true
log "deploy succeeded: release=${RELEASE_TAG} revision=${EXPECTED_REVISION} backup=${BACKUP_DIR}"
log "rollback command (application images only): ./scripts/upgrade.sh --manifest .upgrade-state/previous-images.env"
