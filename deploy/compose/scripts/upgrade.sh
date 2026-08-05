#!/usr/bin/env bash
# Forward-only rolling upgrade for the TypeScript runtime.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "${ROOT}/scripts/compose-env.sh"
# shellcheck disable=SC1091
source "${ROOT}/scripts/release-env.sh"

RUNTIME_ENV="$(cd "${ROOT}/../config" && pwd)/runtime.env"
STATE_DIR="${ROOT}/.upgrade-state"
PREVIOUS_ENV="${STATE_DIR}/previous-images.env"
MANIFEST=""
WEB_IMAGE=""
MIGRATOR_IMAGE=""
OPS_IMAGE=""
WORKER_IMAGE=""
DBOS_VERSION=""
IMAGE_PLATFORM=""
CURRENT_DBOS_VERSION=""
DBOS_DRAIN_TIMEOUT_SECONDS=""
FROM_RUNTIME=0
ALLOW_BUILD=0
ALLOW_PLATFORM_EMULATION=0
SKIP_SMOKE=0
WITH_OBSERVABILITY=0
WITH_LANGFUSE=0
OBSERVABILITY_MODE=auto
SWITCHED=0
VERSION_CHANGED=0
TARGET_EXECUTION_STARTED=0

usage() {
	cat <<'EOF'
Usage:
  upgrade.sh --manifest /path/to/release.env
  upgrade.sh --web IMG --migrator IMG --ops IMG --worker IMG [--dbos-version VERSION]
  upgrade.sh --from-runtime

Options:
  --allow-build  Build local images when registry pull is unavailable.
  --allow-platform-emulation  Accept a host/image architecture mismatch for local validation only.
  --skip-smoke   Skip pilot-smoke.sh after health checks.
  --with-observability  Preserve/start the optional Ops Stack and validate it.
  --without-observability  Explicitly disconnect the application from Ops.
  --with-langfuse  Enable metadata-only Langfuse fan-out (implies Ops Stack).
  --without-langfuse  Keep Ops enabled but disable Langfuse fan-out.

Database migrations are forward-only. Application rollback restores image pins,
but never down-migrates data.
EOF
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }

existing_langfuse_enabled() {
	local collector_id
	collector_id="$(mk_compose_observability ps -q otel-collector 2>/dev/null || true)"
	[[ -n "$collector_id" ]] || return 1
	docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$collector_id" \
		2>/dev/null | grep -q '^LANGFUSE_OTLP_ENDPOINT='
}

runtime_compose() {
	if [[ "$WITH_LANGFUSE" -eq 1 ]]; then
		mk_compose_langfuse "$@"
	elif [[ "$WITH_OBSERVABILITY" -eq 1 ]]; then
		mk_compose_observability "$@"
	else
		mk_compose "$@"
	fi
}

write_runtime_pins() {
	mk_release_write_runtime_pins "$RUNTIME_ENV" "$@"
}

capture_previous() {
	mkdir -p "$STATE_DIR"
	chmod 700 "$STATE_DIR"
	{
		echo "UNORAG_WEB_IMAGE=$(mk_release_env_get "$RUNTIME_ENV" UNORAG_WEB_IMAGE)"
		echo "UNORAG_WEB_MIGRATOR_IMAGE=$(mk_release_env_get "$RUNTIME_ENV" UNORAG_WEB_MIGRATOR_IMAGE)"
		echo "UNORAG_WEB_OPS_IMAGE=$(mk_release_env_get "$RUNTIME_ENV" UNORAG_WEB_OPS_IMAGE)"
		echo "UNORAG_DBOS_WORKER_IMAGE=$(mk_release_env_get "$RUNTIME_ENV" UNORAG_DBOS_WORKER_IMAGE)"
		echo "UNORAG_DBOS_APPLICATION_VERSION=$(mk_release_env_get "$RUNTIME_ENV" UNORAG_DBOS_APPLICATION_VERSION)"
		echo "UNORAG_IMAGE_PLATFORM=$(mk_release_env_get "$RUNTIME_ENV" UNORAG_IMAGE_PLATFORM)"
	} >"$PREVIOUS_ENV"
	chmod 600 "$PREVIOUS_ENV"
}

run_drain_check() {
	local version="$1" scope="$2" timeout="$3"
	mk_compose --profile ops run --rm check-dbos-drain \
		--application-version "$version" \
		--scope "$scope" \
		--timeout-seconds "$timeout" \
		--poll-seconds 5
}

quiesce_dbos_version() {
	local version="$1"
	log "entering maintenance mode for DBOS version ${version}"
	runtime_compose stop caddy web

	# Keep the matching control process and worker alive while all application
	# jobs and durable workflows drain. Once empty, stop the producer first,
	# then the executor, and verify the boundary a final time.
	run_drain_check "$version" all "$DBOS_DRAIN_TIMEOUT_SECONDS" || return 1
	mk_compose stop dbos-control
	run_drain_check "$version" app 0 || return 1
	run_drain_check "$version" dbos "$DBOS_DRAIN_TIMEOUT_SECONDS" || return 1
	mk_compose stop dbos-worker
	run_drain_check "$version" all 0
}

rollback_images() {
	[[ -f "$PREVIOUS_ENV" ]] || return 0
	local web migrator ops worker version platform
	if [[ $VERSION_CHANGED -eq 1 && $TARGET_EXECUTION_STARTED -eq 1 ]]; then
		warn "draining target DBOS version before automatic rollback"
		if ! quiesce_dbos_version "$DBOS_VERSION"; then
			warn "automatic rollback refused: target workflows are still active"
			warn "target image pins were retained and the edge remains in maintenance mode"
			return 1
		fi
	fi
	web="$(mk_release_env_get "$PREVIOUS_ENV" UNORAG_WEB_IMAGE)"
	migrator="$(mk_release_env_get "$PREVIOUS_ENV" UNORAG_WEB_MIGRATOR_IMAGE)"
	ops="$(mk_release_env_get "$PREVIOUS_ENV" UNORAG_WEB_OPS_IMAGE)"
	worker="$(mk_release_env_get "$PREVIOUS_ENV" UNORAG_DBOS_WORKER_IMAGE)"
	version="$(mk_release_env_get "$PREVIOUS_ENV" UNORAG_DBOS_APPLICATION_VERSION)"
	platform="$(mk_release_env_get "$PREVIOUS_ENV" UNORAG_IMAGE_PLATFORM)"
	write_runtime_pins "$web" "$migrator" "$ops" "$worker" "$version" "$platform"
	runtime_compose up -d --no-deps dbos-worker dbos-control web caddy || true
}

on_exit() {
	local rc=$?
	if [[ $rc -ne 0 && $SWITCHED -eq 1 ]]; then
		warn "upgrade failed; restoring previous application image pins"
		rollback_images || warn "automatic rollback could not be completed safely"
	fi
	exit "$rc"
}
trap on_exit EXIT

while [[ $# -gt 0 ]]; do
	case "$1" in
		--manifest) MANIFEST="${2:-}"; shift 2 ;;
		--web) WEB_IMAGE="${2:-}"; shift 2 ;;
		--migrator) MIGRATOR_IMAGE="${2:-}"; shift 2 ;;
		--ops) OPS_IMAGE="${2:-}"; shift 2 ;;
		--worker) WORKER_IMAGE="${2:-}"; shift 2 ;;
		--dbos-version) DBOS_VERSION="${2:-}"; shift 2 ;;
		--from-runtime) FROM_RUNTIME=1; shift ;;
		--allow-build) ALLOW_BUILD=1; shift ;;
		--allow-platform-emulation) ALLOW_PLATFORM_EMULATION=1; shift ;;
		--skip-smoke) SKIP_SMOKE=1; shift ;;
		--with-ops|--with-observability) WITH_OBSERVABILITY=1; OBSERVABILITY_MODE=enabled; shift ;;
		--without-observability) WITH_OBSERVABILITY=0; WITH_LANGFUSE=0; OBSERVABILITY_MODE=disabled; shift ;;
		--with-langfuse) WITH_LANGFUSE=1; WITH_OBSERVABILITY=1; OBSERVABILITY_MODE=enabled; shift ;;
		--without-langfuse) WITH_LANGFUSE=0; WITH_OBSERVABILITY=1; OBSERVABILITY_MODE=enabled; shift ;;
		-h|--help) usage; exit 0 ;;
		*) die "unknown argument: $1" ;;
	esac
done

mk_require_runtime_config
mk_validate_dbos_config
[[ -f "$RUNTIME_ENV" ]] || die "missing $RUNTIME_ENV"

if [[ "$OBSERVABILITY_MODE" == "auto" ]]; then
	GRAFANA_PW="$(mk_config_get GRAFANA_ADMIN_PASSWORD || true)"
	if [[ ${#GRAFANA_PW} -ge 16 ]] &&
		[[ -n "$(mk_compose_observability ps -aq grafana 2>/dev/null || true)" ]]; then
		WITH_OBSERVABILITY=1
		log "detected existing Ops Stack; preserving observability during upgrade"
		LANGFUSE_ENDPOINT="$(mk_config_get LANGFUSE_OTLP_ENDPOINT || true)"
		LANGFUSE_AUTH="$(mk_config_get LANGFUSE_OTLP_AUTHORIZATION || true)"
		if existing_langfuse_enabled &&
			[[ "$LANGFUSE_ENDPOINT" =~ ^https?://.+/api/public/otel/?$ ]] &&
			[[ "$LANGFUSE_AUTH" =~ ^Basic\ [A-Za-z0-9+/=]+$ ]]; then
			WITH_LANGFUSE=1
			log "detected active Langfuse fan-out; preserving it during upgrade"
		fi
	fi
fi

if [[ -n "$MANIFEST" ]]; then
	[[ -f "$MANIFEST" ]] || die "manifest not found: $MANIFEST"
	WEB_IMAGE="$(mk_release_env_get "$MANIFEST" UNORAG_WEB_IMAGE)"
	MIGRATOR_IMAGE="$(mk_release_env_get "$MANIFEST" UNORAG_WEB_MIGRATOR_IMAGE)"
	OPS_IMAGE="$(mk_release_env_get "$MANIFEST" UNORAG_WEB_OPS_IMAGE)"
	WORKER_IMAGE="$(mk_release_env_get "$MANIFEST" UNORAG_DBOS_WORKER_IMAGE)"
	DBOS_VERSION="$(mk_release_env_get "$MANIFEST" UNORAG_DBOS_APPLICATION_VERSION)"
	IMAGE_PLATFORM="$(mk_release_resolve_platform "$MANIFEST")"
elif [[ $FROM_RUNTIME -eq 1 ]]; then
	WEB_IMAGE="$(mk_release_env_get "$RUNTIME_ENV" UNORAG_WEB_IMAGE)"
	MIGRATOR_IMAGE="$(mk_release_env_get "$RUNTIME_ENV" UNORAG_WEB_MIGRATOR_IMAGE)"
	OPS_IMAGE="$(mk_release_env_get "$RUNTIME_ENV" UNORAG_WEB_OPS_IMAGE)"
	WORKER_IMAGE="$(mk_release_env_get "$RUNTIME_ENV" UNORAG_DBOS_WORKER_IMAGE)"
	DBOS_VERSION="$(mk_release_env_get "$RUNTIME_ENV" UNORAG_DBOS_APPLICATION_VERSION)"
	IMAGE_PLATFORM="$(mk_release_resolve_platform "$RUNTIME_ENV")"
fi

CURRENT_DBOS_VERSION="$(mk_release_env_get "$RUNTIME_ENV" UNORAG_DBOS_APPLICATION_VERSION)"
CURRENT_DBOS_VERSION="${CURRENT_DBOS_VERSION:-lifecycle-v2}"
DBOS_VERSION="${DBOS_VERSION:-$CURRENT_DBOS_VERSION}"
mk_release_assert_image UNORAG_WEB_IMAGE "$WEB_IMAGE"
mk_release_assert_image UNORAG_WEB_MIGRATOR_IMAGE "$MIGRATOR_IMAGE"
mk_release_assert_image UNORAG_WEB_OPS_IMAGE "$OPS_IMAGE"
mk_release_assert_image UNORAG_DBOS_WORKER_IMAGE "$WORKER_IMAGE"
mk_release_assert_dbos_version "$DBOS_VERSION"
if [[ -n "$IMAGE_PLATFORM" && $ALLOW_BUILD -eq 0 ]]; then
	mk_release_assert_host_platform "$IMAGE_PLATFORM" "$ALLOW_PLATFORM_EMULATION"
fi
if [[ "$DBOS_VERSION" != "$CURRENT_DBOS_VERSION" ]]; then
	VERSION_CHANGED=1
fi
DBOS_DRAIN_TIMEOUT_SECONDS="$(mk_config_get DBOS_UPGRADE_DRAIN_TIMEOUT_SECONDS || echo 1800)"
[[ "$DBOS_DRAIN_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || die "DBOS_UPGRADE_DRAIN_TIMEOUT_SECONDS must be a positive integer"

if [[ $WITH_OBSERVABILITY -eq 1 ]]; then
	GRAFANA_PW="$(mk_config_get GRAFANA_ADMIN_PASSWORD || true)"
	[[ ${#GRAFANA_PW} -ge 16 ]] || die "GRAFANA_ADMIN_PASSWORD must contain at least 16 characters"
fi

if [[ $WITH_LANGFUSE -eq 1 ]]; then
	LANGFUSE_ENDPOINT="$(mk_config_get LANGFUSE_OTLP_ENDPOINT || true)"
	LANGFUSE_AUTH="$(mk_config_get LANGFUSE_OTLP_AUTHORIZATION || true)"
	[[ "$LANGFUSE_ENDPOINT" =~ ^https?://.+/api/public/otel/?$ ]] || die "LANGFUSE_OTLP_ENDPOINT must end in /api/public/otel"
	[[ "$LANGFUSE_AUTH" =~ ^Basic\ [A-Za-z0-9+/=]+$ ]] || die "LANGFUSE_OTLP_AUTHORIZATION must be a Basic authorization value"
fi

capture_previous
write_runtime_pins "$WEB_IMAGE" "$MIGRATOR_IMAGE" "$OPS_IMAGE" "$WORKER_IMAGE" "$DBOS_VERSION" "$IMAGE_PLATFORM"
SWITCHED=1

if [[ $WITH_OBSERVABILITY -eq 1 ]]; then
	log "starting optional observability backends"
	if [[ $WITH_LANGFUSE -eq 1 ]]; then
		mk_compose_langfuse up -d tempo loki alertmanager otel-collector prometheus grafana
	else
		mk_compose_observability up -d tempo loki alertmanager otel-collector prometheus grafana
	fi
fi

if [[ $ALLOW_BUILD -eq 1 ]]; then
	warn "using break-glass local image builds"
	mk_compose build web migrate-web bootstrap inspect-lifecycle dbos-worker
else
	log "pulling four pinned release images"
	mk_compose pull web migrate-web bootstrap dbos-worker
fi

if [[ $VERSION_CHANGED -eq 1 ]]; then
	log "DBOS application version changes ${CURRENT_DBOS_VERSION} -> ${DBOS_VERSION}"
	if ! quiesce_dbos_version "$CURRENT_DBOS_VERSION"; then
		die "DBOS drain timed out; old services will be restored without switching versions"
	fi
else
	log "DBOS application version unchanged; using rolling execution restart"
fi

log "applying forward-only database migration"
mk_compose up -d --wait postgres
mk_compose --profile migrate run --rm migrate-web
mk_compose --profile migrate run --rm configure-db-roles

log "rolling DBOS execution and control"
mk_compose stop dbos-control dbos-worker || true
TARGET_EXECUTION_STARTED=1
runtime_compose up -d --wait dbos-worker dbos-control

log "reconciling ACL projections"
mk_compose --profile ops run --rm backfill-acl-projections
mk_compose --profile ops run --rm inspect-lifecycle

log "rolling web and edge"
runtime_compose up -d --no-deps --wait web
runtime_compose up -d --no-deps caddy

HTTP_PORT="$(mk_config_get HTTP_PORT || echo 80)"
BASE_URL="$(mk_config_get UNORAG_BASE_URL || echo "http://localhost:${HTTP_PORT}")"
BASE_URL="${BASE_URL%/}"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
	if curl -fsS "${BASE_URL}/api/rag/health/ready" >/dev/null; then
		break
	fi
	[[ $attempt -lt 10 ]] || die "health probe failed after upgrade"
	sleep 3
done

if [[ $SKIP_SMOKE -eq 0 && -x "${ROOT}/scripts/pilot-smoke.sh" ]]; then
	UNORAG_BASE_URL="$BASE_URL" "${ROOT}/scripts/pilot-smoke.sh"
fi

# Core release is accepted at this point. Optional Ops validation must not roll
# business images back after a successful forward-only migration.
SWITCHED=0
if [[ $WITH_OBSERVABILITY -eq 1 ]]; then
	"${ROOT}/scripts/observability-smoke.sh"
fi

trap - EXIT
log "upgrade complete; previous image pins are in $PREVIOUS_ENV"
