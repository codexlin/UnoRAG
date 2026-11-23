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
RUNTIME_ADVANCED_ENV="$(cd "${ROOT}/../config" && pwd)/runtime.advanced.env"
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
QDRANT_IDF_TARGET=""
PREVIOUS_QDRANT_COLLECTION=""
COLLECTION_SWITCHED=0

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
  --qdrant-idf-target COLLECTION
                 Drain writers, verify a cold backup, and copy points to a new
                 IDF collection before starting the target release.
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
	mk_release_write_runtime_pins "$RUNTIME_ADVANCED_ENV" "$@"
}

capture_previous() {
	mkdir -p "$STATE_DIR"
	chmod 700 "$STATE_DIR"
	{
		echo "UNORAG_WEB_IMAGE=$(mk_release_env_get "$RUNTIME_ADVANCED_ENV" UNORAG_WEB_IMAGE)"
		echo "UNORAG_WEB_MIGRATOR_IMAGE=$(mk_release_env_get "$RUNTIME_ADVANCED_ENV" UNORAG_WEB_MIGRATOR_IMAGE)"
		echo "UNORAG_WEB_OPS_IMAGE=$(mk_release_env_get "$RUNTIME_ADVANCED_ENV" UNORAG_WEB_OPS_IMAGE)"
		echo "UNORAG_DBOS_WORKER_IMAGE=$(mk_release_env_get "$RUNTIME_ADVANCED_ENV" UNORAG_DBOS_WORKER_IMAGE)"
		echo "UNORAG_DBOS_APPLICATION_VERSION=$(mk_release_env_get "$RUNTIME_ADVANCED_ENV" UNORAG_DBOS_APPLICATION_VERSION)"
		echo "UNORAG_IMAGE_PLATFORM=$(mk_release_env_get "$RUNTIME_ADVANCED_ENV" UNORAG_IMAGE_PLATFORM)"
		if [[ -n "$QDRANT_IDF_TARGET" ]]; then
			echo "QDRANT_COLLECTION=$PREVIOUS_QDRANT_COLLECTION"
		fi
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
	runtime_compose stop caddy web || return 1

	# Keep the matching control process and worker alive while all application
	# jobs and durable workflows drain. Once empty, stop the producer first,
	# then the executor, and verify the boundary a final time.
	run_drain_check "$version" all "$DBOS_DRAIN_TIMEOUT_SECONDS" || return 1
	mk_compose stop dbos-control || return 1
	run_drain_check "$version" app 0 || return 1
	run_drain_check "$version" dbos "$DBOS_DRAIN_TIMEOUT_SECONDS" || return 1
	mk_compose stop dbos-worker || return 1
	run_drain_check "$version" all 0
}

write_qdrant_collection() {
	local collection="$1" tmp
	tmp="$(mktemp "${RUNTIME_ADVANCED_ENV}.XXXXXXXX")" || return 1
	if awk -F= -v name="$collection" '
		$1 == "QDRANT_COLLECTION" { next }
		{ print }
		END { print "QDRANT_COLLECTION=" name }
	' "$RUNTIME_ADVANCED_ENV" >"$tmp" && mv -f "$tmp" "$RUNTIME_ADVANCED_ENV"; then
		return 0
	fi
	rm -f "$tmp"
	return 1
}

validate_idf_compose_config() {
	local collection="$1"
	shift
	runtime_compose --profile ops --profile migrate config --format json | python3 -c '
import json
import sys

def fail(message):
    sys.exit("error: " + message)

config = json.load(sys.stdin)
collection, project, *release = sys.argv[1:]
services = config["services"]
if config["name"] != project:
    fail("IDF cutover must use the Compose project selected by backup.sh")
for name in ("web", "dbos-worker", "dbos-control"):
    service = services[name]
    env = service["environment"]
    if env.get("QDRANT_URL", "").rstrip("/") != "http://qdrant:6333":
        fail(f"IDF cutover requires {name} to use the bundled Qdrant service")
    if env.get("QDRANT_COLLECTION") != collection:
        fail(f"{name} has an unexpected QDRANT_COLLECTION")
    if service.get("ports") or service.get("network_mode") == "host":
        fail(f"IDF cutover requires {name} to be private behind Compose ingress")

web_env = services["web"]["environment"]
worker_env = services["dbos-worker"]["environment"]
for key, default in (("EMBEDDING_DIM", "1024"), ("QDRANT_DISTANCE", "Cosine")):
    if web_env.get(key, default).strip().lower() != worker_env.get(key, default).strip().lower():
        fail(f"Web and Worker must agree on {key} during IDF cutover")

if release:
    web, migrator, ops, worker, version = release
    expected = {"web": web, "migrate-web": migrator, "inspect-lifecycle": ops,
                "backfill-acl-projections": ops, "dbos-worker": worker, "dbos-control": worker}
    for name, image in expected.items():
        if services[name].get("image") != image:
            fail(f"{name} must use its verified release image")
    for name in ("web", "dbos-worker", "dbos-control"):
        if services[name]["environment"].get("UNORAG_DBOS_APPLICATION_VERSION") != version:
            fail(f"{name} must use the target DBOS application version")
' "$collection" "$(mk_config_get COMPOSE_PROJECT_NAME || echo unorag)" "$@"
}

validate_idf_backup_storage() {
	local project container volume
	project="$(mk_config_get COMPOSE_PROJECT_NAME || echo unorag)"
	container="$(mk_compose ps --status running -q qdrant)"
	[[ -n "$container" ]] || die "IDF cutover requires a running Compose Qdrant service"
	volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/qdrant/storage"}}{{.Name}}{{end}}{{end}}' "$container")"
	[[ "$volume" == "${project}_qdrant_data" ]] ||
		die "IDF cutover requires the Qdrant volume archived by backup.sh"
}

backup_before_qdrant_cutover() {
	local backup
	mkdir -p -m 700 "${ROOT}/backups"
	backup="$(mktemp -d "${ROOT}/backups/pre-idf-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")"
	"${ROOT}/scripts/backup.sh" "$backup"
	(
		cd "$backup"
		if command -v sha256sum >/dev/null 2>&1; then
			sha256sum -c CHECKSUMS.sha256
		else
			shasum -a 256 -c CHECKSUMS.sha256
		fi
	)
}

backfill_qdrant_after_drain() {
	validate_idf_compose_config "$PREVIOUS_QDRANT_COLLECTION" \
		"$WEB_IMAGE" "$MIGRATOR_IMAGE" "$OPS_IMAGE" "$WORKER_IMAGE" "$DBOS_VERSION"
	# Use the target worker's dependencies, but do not run its executor yet.
	runtime_compose run --rm --no-deps -T --pull never \
		--entrypoint /repo/node_modules/.bin/tsx dbos-worker \
		/repo/scripts/qdrant-backfill-sparse.ts --execute \
		--from "$PREVIOUS_QDRANT_COLLECTION" --to "$QDRANT_IDF_TARGET"
	COLLECTION_SWITCHED=1
	write_qdrant_collection "$QDRANT_IDF_TARGET"
	validate_idf_compose_config "$QDRANT_IDF_TARGET" \
		"$WEB_IMAGE" "$MIGRATOR_IMAGE" "$OPS_IMAGE" "$WORKER_IMAGE" "$DBOS_VERSION"
}

verify_target_web() {
	runtime_compose exec -T web node -e '
		fetch("http://127.0.0.1:3000/api/rag/health/ready", {signal: AbortSignal.timeout(15000)})
			.then(async (response) => {
				const data = await response.json();
				if (!response.ok || !data.ask_ready || !data.qdrant_ok || !data.metadata_ok ||
					data.release?.dbos_application_version !== process.argv[1] ||
					process.env.QDRANT_COLLECTION !== process.argv[2]) {
					throw new Error("target release did not become ready before IDF cutover");
				}
			}).catch((error) => { console.error(error.message); process.exitCode = 1; });
	' "$DBOS_VERSION" "$QDRANT_IDF_TARGET"
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
	if [[ "$COLLECTION_SWITCHED" -eq 1 ]]; then
		write_qdrant_collection "$PREVIOUS_QDRANT_COLLECTION" || return 1
	fi
	write_runtime_pins "$web" "$migrator" "$ops" "$worker" "$version" "$platform" || return 1
	if [[ -n "$QDRANT_IDF_TARGET" ]]; then
		mk_compose up -d --no-deps --wait qdrant || return 1
		runtime_compose up -d --no-deps --wait dbos-worker dbos-control web || return 1
		runtime_compose up -d --no-deps caddy
		return $?
	fi
	runtime_compose up -d --no-deps dbos-worker dbos-control web caddy || true
}

on_exit() {
	local rc=$?
	if [[ $rc -ne 0 && $SWITCHED -eq 1 ]]; then
		warn "upgrade failed; restoring previous application image pins"
		rollback_images || warn "automatic rollback could not be completed safely"
	elif [[ $rc -ne 0 && $COLLECTION_SWITCHED -eq 1 ]]; then
		warn "target writers may have run; target pins and collection were retained for recovery"
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
		--qdrant-idf-target)
			[[ $# -ge 2 && "$2" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$ ]] ||
				die "--qdrant-idf-target requires a valid collection name"
			QDRANT_IDF_TARGET="$2"; shift 2 ;;
		--with-ops|--with-observability) WITH_OBSERVABILITY=1; OBSERVABILITY_MODE=enabled; shift ;;
		--without-observability) WITH_OBSERVABILITY=0; WITH_LANGFUSE=0; OBSERVABILITY_MODE=disabled; shift ;;
		--with-langfuse) WITH_LANGFUSE=1; WITH_OBSERVABILITY=1; OBSERVABILITY_MODE=enabled; shift ;;
		--without-langfuse) WITH_LANGFUSE=0; WITH_OBSERVABILITY=1; OBSERVABILITY_MODE=enabled; shift ;;
		-h|--help) usage; exit 0 ;;
		*) die "unknown argument: $1" ;;
	esac
done

"${ROOT}/scripts/init-config.sh"
mk_require_runtime_config
mk_validate_dbos_config
[[ -f "$RUNTIME_ENV" && -f "$RUNTIME_ADVANCED_ENV" ]] || die "missing runtime configuration"

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
	UNORAG_VERIFY_IMAGE_SIGNATURES="$(mk_release_env_get "$MANIFEST" UNORAG_VERIFY_IMAGE_SIGNATURES)"
	UNORAG_COSIGN_CERTIFICATE_IDENTITY_REGEXP="$(mk_release_env_get "$MANIFEST" UNORAG_COSIGN_CERTIFICATE_IDENTITY_REGEXP)"
	UNORAG_COSIGN_OIDC_ISSUER="$(mk_release_env_get "$MANIFEST" UNORAG_COSIGN_OIDC_ISSUER)"
	UNORAG_COSIGN_NEW_BUNDLE_FORMAT="$(mk_release_env_get "$MANIFEST" UNORAG_COSIGN_NEW_BUNDLE_FORMAT)"
	UNORAG_COSIGN_REGISTRY_REFERRERS_MODE="$(mk_release_env_get "$MANIFEST" UNORAG_COSIGN_REGISTRY_REFERRERS_MODE)"
	export UNORAG_VERIFY_IMAGE_SIGNATURES UNORAG_COSIGN_CERTIFICATE_IDENTITY_REGEXP UNORAG_COSIGN_OIDC_ISSUER
	export UNORAG_COSIGN_NEW_BUNDLE_FORMAT UNORAG_COSIGN_REGISTRY_REFERRERS_MODE
elif [[ $FROM_RUNTIME -eq 1 ]]; then
	WEB_IMAGE="$(mk_release_env_get "$RUNTIME_ADVANCED_ENV" UNORAG_WEB_IMAGE)"
	MIGRATOR_IMAGE="$(mk_release_env_get "$RUNTIME_ADVANCED_ENV" UNORAG_WEB_MIGRATOR_IMAGE)"
	OPS_IMAGE="$(mk_release_env_get "$RUNTIME_ADVANCED_ENV" UNORAG_WEB_OPS_IMAGE)"
	WORKER_IMAGE="$(mk_release_env_get "$RUNTIME_ADVANCED_ENV" UNORAG_DBOS_WORKER_IMAGE)"
	DBOS_VERSION="$(mk_release_env_get "$RUNTIME_ADVANCED_ENV" UNORAG_DBOS_APPLICATION_VERSION)"
	IMAGE_PLATFORM="$(mk_release_resolve_platform "$RUNTIME_ADVANCED_ENV")"
fi

CURRENT_DBOS_VERSION="$(mk_release_env_get "$RUNTIME_ADVANCED_ENV" UNORAG_DBOS_APPLICATION_VERSION)"
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
if [[ $ALLOW_BUILD -eq 0 ]]; then
	mk_release_verify_images \
		UNORAG_WEB_IMAGE "$WEB_IMAGE" \
		UNORAG_WEB_MIGRATOR_IMAGE "$MIGRATOR_IMAGE" \
		UNORAG_WEB_OPS_IMAGE "$OPS_IMAGE" \
		UNORAG_DBOS_WORKER_IMAGE "$WORKER_IMAGE"
fi
if [[ "$DBOS_VERSION" != "$CURRENT_DBOS_VERSION" ]]; then
	VERSION_CHANGED=1
fi
if [[ -n "$QDRANT_IDF_TARGET" ]]; then
	[[ -n "$MANIFEST" && $VERSION_CHANGED -eq 1 && $ALLOW_BUILD -eq 0 ]] ||
		die "IDF cutover requires a pinned release manifest and a new DBOS version"
	[[ "$(mk_release_env_get "$MANIFEST" UNORAG_VERIFY_IMAGE_SIGNATURES)" == true ]] ||
		die "IDF cutover requires verified image signatures"
	mk_release_assert_image UNORAG_WEB_IMAGE "$WEB_IMAGE" digest
	mk_release_assert_image UNORAG_WEB_MIGRATOR_IMAGE "$MIGRATOR_IMAGE" digest
	mk_release_assert_image UNORAG_WEB_OPS_IMAGE "$OPS_IMAGE" digest
	mk_release_assert_image UNORAG_DBOS_WORKER_IMAGE "$WORKER_IMAGE" digest
	[[ -z "$(mk_release_env_get "${_MK_CONFIG_DIR}/runtime.secret" QDRANT_COLLECTION)" &&
		-z "$(mk_release_env_get "${_MK_CONFIG_DIR}/bootstrap.env" QDRANT_COLLECTION)" ]] ||
		die "move QDRANT_COLLECTION out of runtime.secret/bootstrap.env before IDF cutover"
	PREVIOUS_QDRANT_COLLECTION="$(mk_config_get QDRANT_COLLECTION || echo unorag_chunks)"
	[[ "$PREVIOUS_QDRANT_COLLECTION" != "$QDRANT_IDF_TARGET" ]] ||
		die "IDF cutover requires an unused collection distinct from the current collection"
	validate_idf_compose_config "$PREVIOUS_QDRANT_COLLECTION"
	validate_idf_backup_storage
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
if [[ -n "$QDRANT_IDF_TARGET" ]]; then
	log "pre-pulling verified images before stopping ingress"
	for image in "$WEB_IMAGE" "$MIGRATOR_IMAGE" "$OPS_IMAGE" "$WORKER_IMAGE"; do
		docker pull --platform "$IMAGE_PLATFORM" "$image"
	done
	# The backup must record the old image pins and DBOS application version.
	SWITCHED=1
	quiesce_dbos_version "$CURRENT_DBOS_VERSION" ||
		die "could not stop and drain the current services; refusing IDF cutover"
	backup_before_qdrant_cutover
fi
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
elif [[ -z "$QDRANT_IDF_TARGET" ]]; then
	log "pulling four pinned release images"
	mk_compose pull web migrate-web bootstrap dbos-worker
fi

if [[ -n "$QDRANT_IDF_TARGET" ]]; then
	log "backfilling a separate IDF collection with all writers stopped"
	backfill_qdrant_after_drain
elif [[ $VERSION_CHANGED -eq 1 ]]; then
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

if [[ "$COLLECTION_SWITCHED" -eq 1 ]]; then
	log "verifying target Web while ingress and DBOS writers are stopped"
	runtime_compose up -d --no-deps --wait web
	verify_target_web
	# Target workers and ACL reconciliation can create writes before Caddy starts.
	# From here, the old collection may be stale even with ingress closed.
	SWITCHED=0
	log "starting target writers; automatic collection rollback is disabled after this point"
fi

log "rolling DBOS execution and control"
mk_compose stop dbos-control dbos-worker || true
TARGET_EXECUTION_STARTED=1
runtime_compose up -d --wait dbos-worker dbos-control

log "reconciling ACL projections"
mk_compose --profile ops run --rm backfill-acl-projections
mk_compose --profile ops run --rm inspect-lifecycle

log "rolling web and edge"
if [[ "$COLLECTION_SWITCHED" -eq 0 ]]; then
	runtime_compose up -d --no-deps --wait web
fi
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
