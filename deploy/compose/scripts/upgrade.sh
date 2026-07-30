#!/usr/bin/env bash
# Rolling upgrade via registry pull (not local build).
#
# Migration assumption (additive only):
#   Schema migrations are forward-only / additive. If migrate fails, this script
#   does NOT auto down-migrate or restore the database. Use ./scripts/backup.sh
#   beforehand and ./scripts/restore.sh if data-plane recovery is required.
#   Application rollback = redeploy previous image digests/tags (app-only).
#
# Default path: docker compose pull → migrate → drain → roll services → health
# → optional pilot-smoke. Local `compose build` is NOT the upgrade path
# (break-glass: --allow-build).
#
# Usage:
#   ./scripts/upgrade.sh --manifest /path/to/release.env
#   ./scripts/upgrade.sh --web IMG --api IMG --migrator IMG [--outbox IMG] [--worker IMG]
#   ./scripts/upgrade.sh --from-runtime   # pull+redeploy pins already in runtime.env
#
# Manifest must pin web/api/migrator. Outbox and DBOS worker pins are required
# for current releases; legacy manifests retain the existing runtime worker pin.
# Rejects empty tags and :latest.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "${ROOT}/scripts/compose-env.sh"

CONFIG_DIR="$(cd "${ROOT}/../config" && pwd)"
RUNTIME_ENV="${CONFIG_DIR}/runtime.env"
STATE_DIR="${ROOT}/.upgrade-state"
PREV_ENV="${STATE_DIR}/previous-images.env"
NEW_ENV="${STATE_DIR}/target-images.env"
SMOKE_SCRIPT="${ROOT}/scripts/pilot-smoke.sh"

WEB_IMAGE=""
API_IMAGE=""
MIGRATOR_IMAGE=""
OUTBOX_IMAGE=""
WORKER_IMAGE=""
DBOS_APPLICATION_VERSION=""
MANIFEST=""
FROM_RUNTIME=0
ALLOW_BUILD=0
SKIP_SMOKE=0
DID_SWITCH=0
DBOS_WAS_RUNNING=0

usage() {
	cat <<'EOF'
Rolling upgrade via registry pull (not local build).

Usage:
  ./scripts/upgrade.sh --manifest /path/to/release.env
  ./scripts/upgrade.sh --web IMG --api IMG --migrator IMG [--outbox IMG] [--worker IMG] [--dbos-version VERSION]
  ./scripts/upgrade.sh --from-runtime

Options:
  --allow-build   break-glass local compose build
  --skip-smoke    skip pilot-smoke.sh after health
  -h, --help      show this help

Rejects empty tags and :latest. Migration is additive; DB is never auto down-migrated.
EOF
	exit "${1:-0}"
}

log() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
	case "$1" in
		-h | --help) usage 0 ;;
		--manifest)
			MANIFEST="${2:-}"
			shift 2
			;;
		--web)
			WEB_IMAGE="${2:-}"
			shift 2
			;;
		--api)
			API_IMAGE="${2:-}"
			shift 2
			;;
		--migrator)
			MIGRATOR_IMAGE="${2:-}"
			shift 2
			;;
		--outbox)
			OUTBOX_IMAGE="${2:-}"
			shift 2
			;;
		--worker)
			WORKER_IMAGE="${2:-}"
			shift 2
			;;
		--dbos-version)
			DBOS_APPLICATION_VERSION="${2:-}"
			shift 2
			;;
		--from-runtime)
			FROM_RUNTIME=1
			shift
			;;
		--allow-build)
			ALLOW_BUILD=1
			shift
			;;
		--skip-smoke)
			SKIP_SMOKE=1
			shift
			;;
		*)
			die "unknown argument: $1 (see --help)"
			;;
	esac
done

mk_require_runtime_config || exit 1
[[ -f "$RUNTIME_ENV" ]] || die "missing $RUNTIME_ENV"

if [[ -z "$(mk_config_get UNORAG_DBOS_DB_PASSWORD || true)" ]]; then
	log "preparing missing DBOS credential for an existing bundled-Postgres install"
	"${ROOT}/scripts/prepare-runtime-db-secrets.sh" --bundled-postgres
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true

# Read KEY=value from a dotenv-style file (last wins).
env_file_get() {
	local file="$1" key="$2" value=""
	[[ -f "$file" ]] || return 1
	value="$(
		awk -F= -v k="$key" '
			/^[[:space:]]*#/ { next }
			/^[[:space:]]*$/ { next }
			$1 == k { v = substr($0, index($0, "=") + 1) }
			END { if (v != "") print v }
		' "$file" 2>/dev/null || true
	)"
	[[ -n "$value" ]] || return 1
	printf '%s' "$value"
}

# Validate image ref: must have a tag or digest; tag must not be latest.
assert_pinned_image() {
	local name="$1" ref="$2"
	local tag=""

	[[ -n "$ref" ]] || die "$name is empty (pin a digest or version tag)"

	if [[ "$ref" == *@sha256:* ]]; then
		return 0
	fi

	if [[ "$ref" != *:* ]]; then
		die "$name='$ref' has no tag/digest (refusing untagged / floating ref)"
	fi

	# registry:port/name:tag — take substring after last '/' then after first ':' of that
	tag="${ref##*/}"
	if [[ "$tag" == *:* ]]; then
		tag="${tag#*:}"
	else
		# host:port/name with no tag after last slash — treat whole after last : as tag
		tag="${ref##*:}"
	fi

	[[ -n "$tag" ]] || die "$name='$ref' has empty tag"
	if [[ "$tag" == "latest" || "$tag" == latest@* ]]; then
		die "$name='$ref' uses forbidden tag 'latest' (pin digest or version)"
	fi
}

set_runtime_release_keys() {
	local web="$1" api="$2" migrator="$3" outbox="$4" worker="$5" dbos_version="$6"
	local tmp
	tmp="$(mktemp)"
	# shellcheck disable=SC2016
	awk -v web="$web" -v api="$api" -v migrator="$migrator" -v outbox="$outbox" -v worker="$worker" -v dbos_version="$dbos_version" '
		BEGIN {
			seen_web = 0; seen_api = 0; seen_migrator = 0; seen_outbox = 0; seen_worker = 0; seen_dbos_version = 0
		}
		/^[[:space:]]*UNORAG_WEB_IMAGE=/ {
			print "UNORAG_WEB_IMAGE=" web
			seen_web = 1
			next
		}
		/^[[:space:]]*UNORAG_API_IMAGE=/ {
			print "UNORAG_API_IMAGE=" api
			seen_api = 1
			next
		}
		/^[[:space:]]*UNORAG_WEB_MIGRATOR_IMAGE=/ {
			print "UNORAG_WEB_MIGRATOR_IMAGE=" migrator
			seen_migrator = 1
			next
		}
		/^[[:space:]]*UNORAG_OUTBOX_IMAGE=/ {
			print "UNORAG_OUTBOX_IMAGE=" outbox
			seen_outbox = 1
			next
		}
		/^[[:space:]]*UNORAG_DBOS_WORKER_IMAGE=/ {
			print "UNORAG_DBOS_WORKER_IMAGE=" worker
			seen_worker = 1
			next
		}
		/^[[:space:]]*UNORAG_DBOS_APPLICATION_VERSION=/ {
			print "UNORAG_DBOS_APPLICATION_VERSION=" dbos_version
			seen_dbos_version = 1
			next
		}
		{ print }
		END {
			if (!seen_web) print "UNORAG_WEB_IMAGE=" web
			if (!seen_api) print "UNORAG_API_IMAGE=" api
			if (!seen_migrator) print "UNORAG_WEB_MIGRATOR_IMAGE=" migrator
			if (!seen_outbox) print "UNORAG_OUTBOX_IMAGE=" outbox
			if (!seen_worker) print "UNORAG_DBOS_WORKER_IMAGE=" worker
			if (!seen_dbos_version) print "UNORAG_DBOS_APPLICATION_VERSION=" dbos_version
		}
	' "$RUNTIME_ENV" >"$tmp"
	mv "$tmp" "$RUNTIME_ENV"
}

resolve_service_digest() {
	local service="$1"
	local id
	id="$(mk_compose ps -q "$service" 2>/dev/null | head -n1 || true)"
	if [[ -z "$id" ]]; then
		printf ''
		return 0
	fi
	docker inspect --format '{{.Image}}' "$id" 2>/dev/null || printf ''
}

save_previous_images() {
	local web api migrator outbox worker dbos_version
	web="$(env_file_get "$RUNTIME_ENV" UNORAG_WEB_IMAGE || true)"
	api="$(env_file_get "$RUNTIME_ENV" UNORAG_API_IMAGE || true)"
	migrator="$(env_file_get "$RUNTIME_ENV" UNORAG_WEB_MIGRATOR_IMAGE || true)"
	outbox="$(env_file_get "$RUNTIME_ENV" UNORAG_OUTBOX_IMAGE || true)"
	worker="$(env_file_get "$RUNTIME_ENV" UNORAG_DBOS_WORKER_IMAGE || true)"
	dbos_version="$(env_file_get "$RUNTIME_ENV" UNORAG_DBOS_APPLICATION_VERSION || true)"
	[[ -n "$outbox" ]] || outbox="$migrator"
	[[ -n "$worker" ]] || worker="unorag-web-worker:local"
	# A missing key can only come from a pre-lifecycle-v2 installation.
	[[ -n "$dbos_version" ]] || dbos_version="cleanup-v1"
	{
		echo "# previous pins captured $(date -u +%Y-%m-%dT%H:%M:%SZ)"
		echo "UNORAG_WEB_IMAGE=${web}"
		echo "UNORAG_API_IMAGE=${api}"
		echo "UNORAG_WEB_MIGRATOR_IMAGE=${migrator}"
		echo "UNORAG_OUTBOX_IMAGE=${outbox}"
		echo "UNORAG_DBOS_WORKER_IMAGE=${worker}"
		echo "UNORAG_DBOS_APPLICATION_VERSION=${dbos_version}"
		echo "UNORAG_PREV_WEB_DIGEST=$(resolve_service_digest web)"
		echo "UNORAG_PREV_API_DIGEST=$(resolve_service_digest api)"
		echo "UNORAG_PREV_LIFECYCLE_DIGEST=$(resolve_service_digest lifecycle-worker)"
		echo "UNORAG_PREV_OUTBOX_DIGEST=$(resolve_service_digest outbox-worker)"
		echo "UNORAG_PREV_DBOS_WORKER_DIGEST=$(resolve_service_digest dbos-worker)"
	} >"$PREV_ENV"
	chmod 600 "$PREV_ENV" 2>/dev/null || true
	log "saved previous image pins → $PREV_ENV"
}

rollback_apps() {
	local web api migrator outbox worker dbos_version
	warn "application rollback: redeploying previous image pins (no DB down-migrate)"
	[[ -f "$PREV_ENV" ]] || die "missing $PREV_ENV; cannot rollback automatically"

	web="$(env_file_get "$PREV_ENV" UNORAG_WEB_IMAGE || true)"
	api="$(env_file_get "$PREV_ENV" UNORAG_API_IMAGE || true)"
	migrator="$(env_file_get "$PREV_ENV" UNORAG_WEB_MIGRATOR_IMAGE || true)"
	outbox="$(env_file_get "$PREV_ENV" UNORAG_OUTBOX_IMAGE || true)"
	worker="$(env_file_get "$PREV_ENV" UNORAG_DBOS_WORKER_IMAGE || true)"
	dbos_version="$(env_file_get "$PREV_ENV" UNORAG_DBOS_APPLICATION_VERSION || true)"
	[[ -n "$outbox" ]] || outbox="$migrator"
	[[ -n "$worker" ]] || worker="unorag-web-worker:local"
	[[ -n "$dbos_version" ]] || dbos_version="cleanup-v1"
	[[ -n "$web" && -n "$api" && -n "$migrator" && -n "$outbox" && -n "$worker" && -n "$dbos_version" ]] || die "previous release pins incomplete in $PREV_ENV"

	set_runtime_release_keys "$web" "$api" "$migrator" "$outbox" "$worker" "$dbos_version"
	if [[ "$ALLOW_BUILD" -eq 1 ]]; then
		warn "rollback with --allow-build: attempting pull, then local build if needed"
		mk_compose pull web api lifecycle-worker outbox-worker migrate-web || true
		mk_compose build web api migrate-web outbox-worker || true
		mk_compose --profile dbos build dbos-worker || true
	else
		# Previous pins may be local-only tags; pull best-effort.
		if ! mk_compose pull web api lifecycle-worker outbox-worker migrate-web; then
			warn "rollback pull failed (ok if previous pins were local-only); continuing with local images"
		fi
		mk_compose --profile dbos pull dbos-worker || true
	fi

	mk_compose stop lifecycle-worker || true
	mk_compose up -d --no-deps api
	mk_compose up -d --no-deps --wait api
	mk_compose up -d --no-deps web
	mk_compose up -d --no-deps --wait web
	mk_compose up -d --no-deps lifecycle-worker
	mk_compose up -d --no-deps outbox-worker
	if [[ "$DBOS_WAS_RUNNING" -eq 1 ]]; then
		mk_compose --profile dbos up -d --no-deps dbos-worker dbos-control
	fi
	mk_compose up -d --no-deps caddy
}

restore_runtime_pins_on_failure() {
	local rc=$?
	local web api migrator outbox worker dbos_version
	trap - EXIT
	if [[ "$rc" -ne 0 && "$DID_SWITCH" -eq 1 && -f "$PREV_ENV" ]]; then
		web="$(env_file_get "$PREV_ENV" UNORAG_WEB_IMAGE || true)"
		api="$(env_file_get "$PREV_ENV" UNORAG_API_IMAGE || true)"
		migrator="$(env_file_get "$PREV_ENV" UNORAG_WEB_MIGRATOR_IMAGE || true)"
		outbox="$(env_file_get "$PREV_ENV" UNORAG_OUTBOX_IMAGE || true)"
		worker="$(env_file_get "$PREV_ENV" UNORAG_DBOS_WORKER_IMAGE || true)"
		dbos_version="$(env_file_get "$PREV_ENV" UNORAG_DBOS_APPLICATION_VERSION || true)"
		if [[ -n "$web" && -n "$api" && -n "$migrator" && -n "$outbox" && -n "$worker" && -n "$dbos_version" ]]; then
			set_runtime_release_keys "$web" "$api" "$migrator" "$outbox" "$worker" "$dbos_version"
			warn "restored previous runtime release pins after failed upgrade"
		fi
	fi
	exit "$rc"
}

trap restore_runtime_pins_on_failure EXIT

# --- resolve target images ---
if [[ -n "$MANIFEST" ]]; then
	[[ -f "$MANIFEST" ]] || die "manifest not found: $MANIFEST"
	WEB_IMAGE="$(env_file_get "$MANIFEST" UNORAG_WEB_IMAGE || true)"
	API_IMAGE="$(env_file_get "$MANIFEST" UNORAG_API_IMAGE || true)"
	MIGRATOR_IMAGE="$(env_file_get "$MANIFEST" UNORAG_WEB_MIGRATOR_IMAGE || true)"
	OUTBOX_IMAGE="$(env_file_get "$MANIFEST" UNORAG_OUTBOX_IMAGE || true)"
	WORKER_IMAGE="$(env_file_get "$MANIFEST" UNORAG_DBOS_WORKER_IMAGE || true)"
	DBOS_APPLICATION_VERSION="$(env_file_get "$MANIFEST" UNORAG_DBOS_APPLICATION_VERSION || true)"
elif [[ "$FROM_RUNTIME" -eq 1 ]]; then
	WEB_IMAGE="$(env_file_get "$RUNTIME_ENV" UNORAG_WEB_IMAGE || true)"
	API_IMAGE="$(env_file_get "$RUNTIME_ENV" UNORAG_API_IMAGE || true)"
	MIGRATOR_IMAGE="$(env_file_get "$RUNTIME_ENV" UNORAG_WEB_MIGRATOR_IMAGE || true)"
	OUTBOX_IMAGE="$(env_file_get "$RUNTIME_ENV" UNORAG_OUTBOX_IMAGE || true)"
	WORKER_IMAGE="$(env_file_get "$RUNTIME_ENV" UNORAG_DBOS_WORKER_IMAGE || true)"
	DBOS_APPLICATION_VERSION="$(env_file_get "$RUNTIME_ENV" UNORAG_DBOS_APPLICATION_VERSION || true)"
elif [[ -n "$WEB_IMAGE" || -n "$API_IMAGE" || -n "$MIGRATOR_IMAGE" || -n "$OUTBOX_IMAGE" || -n "$WORKER_IMAGE" ]]; then
	[[ -n "$WEB_IMAGE" && -n "$API_IMAGE" && -n "$MIGRATOR_IMAGE" ]] || \
		die "when using --web/--api/--migrator, web+api+migrator are required (--outbox optional)"
else
	die "specify --manifest PATH, or --web/--api/--migrator, or --from-runtime"
fi

# Legacy 3-image manifests: outbox used to share the migrator pin.
[[ -n "$OUTBOX_IMAGE" ]] || OUTBOX_IMAGE="$MIGRATOR_IMAGE"
if [[ -z "$WORKER_IMAGE" ]]; then
	WORKER_IMAGE="$(env_file_get "$RUNTIME_ENV" UNORAG_DBOS_WORKER_IMAGE || true)"
fi
[[ -n "$WORKER_IMAGE" ]] || WORKER_IMAGE="unorag-web-worker:local"
if [[ -z "$DBOS_APPLICATION_VERSION" ]]; then
	DBOS_APPLICATION_VERSION="$(env_file_get "$RUNTIME_ENV" UNORAG_DBOS_APPLICATION_VERSION || true)"
fi
[[ -n "$DBOS_APPLICATION_VERSION" ]] || DBOS_APPLICATION_VERSION="lifecycle-v2"
[[ "$DBOS_APPLICATION_VERSION" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || \
	die "invalid UNORAG_DBOS_APPLICATION_VERSION=${DBOS_APPLICATION_VERSION}"

assert_pinned_image UNORAG_WEB_IMAGE "$WEB_IMAGE"
assert_pinned_image UNORAG_API_IMAGE "$API_IMAGE"
assert_pinned_image UNORAG_WEB_MIGRATOR_IMAGE "$MIGRATOR_IMAGE"
assert_pinned_image UNORAG_OUTBOX_IMAGE "$OUTBOX_IMAGE"
assert_pinned_image UNORAG_DBOS_WORKER_IMAGE "$WORKER_IMAGE"

{
	echo "# target pins $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo "UNORAG_WEB_IMAGE=${WEB_IMAGE}"
	echo "UNORAG_API_IMAGE=${API_IMAGE}"
	echo "UNORAG_WEB_MIGRATOR_IMAGE=${MIGRATOR_IMAGE}"
	echo "UNORAG_OUTBOX_IMAGE=${OUTBOX_IMAGE}"
	echo "UNORAG_DBOS_WORKER_IMAGE=${WORKER_IMAGE}"
	echo "UNORAG_DBOS_APPLICATION_VERSION=${DBOS_APPLICATION_VERSION}"
} >"$NEW_ENV"
chmod 600 "$NEW_ENV" 2>/dev/null || true

HTTP_PORT="$(mk_config_get HTTP_PORT || echo 80)"
BASE_URL="$(mk_config_get UNORAG_BASE_URL || true)"
BASE_URL="${BASE_URL%/}"
if [[ -z "$BASE_URL" ]]; then
	BASE_URL="http://localhost:${HTTP_PORT}"
fi

log "pre-upgrade backup recommended: ./scripts/backup.sh <dir>"
log "target web=${WEB_IMAGE}"
log "target api=${API_IMAGE}"
log "target migrator=${MIGRATOR_IMAGE}"
log "target outbox=${OUTBOX_IMAGE}"
log "target dbos-worker=${WORKER_IMAGE}"
log "target dbos-version=${DBOS_APPLICATION_VERSION}"

save_previous_images
if [[ -n "$(mk_compose --profile dbos ps -q dbos-worker 2>/dev/null || true)" ]]; then
	DBOS_WAS_RUNNING=1
fi
set_runtime_release_keys "$WEB_IMAGE" "$API_IMAGE" "$MIGRATOR_IMAGE" "$OUTBOX_IMAGE" "$WORKER_IMAGE" "$DBOS_APPLICATION_VERSION"
DID_SWITCH=1

if [[ "$ALLOW_BUILD" -eq 1 ]]; then
	warn "BREAK-GLASS --allow-build: pull preferred, then compose build"
	mk_compose pull web api lifecycle-worker outbox-worker migrate-web || true
	mk_compose build web api migrate-web outbox-worker
	mk_compose --profile dbos build dbos-worker
else
	log "pulling release images (no local build)"
	# Prefer explicit service pulls; local-only tags (e.g. legacy migrator) must not
	# fail the upgrade when Docker Hub is unreachable.
	if ! mk_compose pull web api lifecycle-worker; then
		die "failed to pull web/api images from registry"
	fi
	if ! mk_compose pull outbox-worker migrate-web; then
		warn "outbox/migrator pull failed (ok if pins are local-only tags); continuing"
	fi
	if ! mk_compose --profile dbos pull dbos-worker; then
		warn "DBOS worker pull failed (ok only while the dbos profile remains disabled)"
		if [[ "$DBOS_WAS_RUNNING" -eq 1 ]]; then
			die "DBOS worker is running, so its release image must be pullable"
		fi
	fi
fi

log "migrations (additive; run before switching traffic)"
log "NOTE: migration failure will NOT auto-rollback the database"
mk_compose up -d postgres
mk_compose up -d --wait postgres
if ! mk_compose --profile migrate run --rm migrate-web; then
	warn "migrate-web failed — DB left as-is (no down-migrate)"
	warn "restoring previous image pins in runtime.env; apps not rolled to new images"
	rollback_apps
	die "migration failed; restore from backup if schema is partial/corrupt"
fi
if ! mk_compose --profile migrate run --rm migrate-rag; then
	warn "migrate-rag failed — DB left as-is (no down-migrate)"
	warn "restoring previous image pins; apps not rolled to new images"
	rollback_apps
	die "migration failed; restore from backup if schema is partial/corrupt"
fi
if ! mk_compose --profile migrate run --rm configure-db-roles; then
	warn "runtime role/login configuration failed — apps not rolled to new images"
	rollback_apps
	die "least-privilege database configuration failed"
fi

log "draining lifecycle-worker (SIGTERM; finishes current step, no new claims)"
mk_compose stop lifecycle-worker
if [[ "$DBOS_WAS_RUNNING" -eq 1 ]]; then
	log "draining DBOS control/executor"
	mk_compose --profile dbos stop dbos-control dbos-worker
fi

log "rolling api → web → lifecycle-worker → outbox-worker → caddy"
if ! mk_compose up -d --no-deps api \
	|| ! mk_compose up -d --no-deps --wait api \
	|| ! mk_compose up -d --no-deps web \
	|| ! mk_compose up -d --no-deps --wait web \
	|| ! mk_compose up -d --no-deps lifecycle-worker \
	|| ! mk_compose up -d --no-deps outbox-worker \
	|| ! mk_compose up -d --no-deps caddy; then
	warn "service roll failed — attempting app rollback to previous pins"
	rollback_apps
	die "upgrade roll failed; previous images redeployed (DB not reverted)"
fi
	if [[ "$DBOS_WAS_RUNNING" -eq 1 ]]; then
		if ! mk_compose --profile dbos up -d --no-deps --wait dbos-worker dbos-control; then
		warn "DBOS service roll failed — attempting app rollback"
		rollback_apps
		die "DBOS upgrade roll failed; previous images redeployed"
	fi
fi

log "post-upgrade probes"
health_ok=0
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
	if curl -sf "${BASE_URL}/api/rag/health" | tee /tmp/unorag-upgrade-health.json; then
		echo
		health_ok=1
		break
	fi
	echo
	warn "health probe attempt ${_attempt}/10 failed; retrying in 3s"
	sleep 3
done
if [[ "$health_ok" -ne 1 ]]; then
	warn "health probe failed — attempting app rollback to previous pins"
	rollback_apps
	die "health failed after upgrade; previous images redeployed (DB not reverted)"
fi

if [[ "$SKIP_SMOKE" -eq 0 && -x "$SMOKE_SCRIPT" ]]; then
	log "running pilot-smoke.sh"
	if UNORAG_BASE_URL="$BASE_URL" "$SMOKE_SCRIPT"; then
		:
	else
		smoke_rc=$?
		if [[ "$smoke_rc" -eq 2 ]]; then
			warn "pilot-smoke SKIP (exit 2) — upgrade continues; investigate credentials/stack"
		else
			warn "pilot-smoke FAIL — attempting app rollback to previous pins"
			rollback_apps
			die "pilot-smoke failed; previous images redeployed (DB not reverted)"
		fi
	fi
elif [[ "$SKIP_SMOKE" -eq 1 ]]; then
	log "skipping pilot-smoke (--skip-smoke)"
else
	warn "pilot-smoke.sh not found/executable — skip smoke"
fi

log "upgrade complete — previous pins in $PREV_ENV; verify ask/upload and run: ./scripts/compose-env.sh is sourced, then mk_compose --profile ops run --rm inspect-lifecycle"
if [[ "$DID_SWITCH" -eq 1 ]]; then
	true
fi
