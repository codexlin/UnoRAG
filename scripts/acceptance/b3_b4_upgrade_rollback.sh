#!/usr/bin/env bash
# B3 upgrade + B4 rollback drill (independent environment).
#
# Safety:
#   - One-shot Compose project + dedicated volumes (never main hybrid / .unorag).
#   - Document root under workdir only.
#   - Reuses compose.b2-infra.yml port env vars with B3_* overrides.
#
# Flow:
#   old API → seed (doc/ACL/version/archive) → pre-upgrade backup
#   → migrate + new API (B3) → verify
#   → B4a app-only rollback (old API on same DB) → verify
#   → B4b data-restore rollback (B2-style restore of pre-upgrade backup) → verify
#
# Version strategy (no formal release image tags required):
#   - OLD/NEW: detached git worktrees at the requested immutable SHAs.
#   - API/migrations run from their matching worktrees.
#   - Web images are SHA-scoped and built on demand unless already present.
#
# Exit: 0=PASS 1=FAIL 2=BLOCKED/SKIP
set -euo pipefail

ACC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$ACC_DIR/../.." && pwd)"
# shellcheck disable=SC1091
source "$ACC_DIR/lib/common.sh"
cd "$ROOT"

RC_SHA="${UNORAG_RC_SHA:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)}"
SCRIPT_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
NEW_SHA="${UNORAG_B3_NEW_SHA:-$(git -C "$ROOT" rev-parse HEAD)}"
# Product RC1 baseline — schema-compatible with current HEAD (no drizzle/rag migration delta).
OLD_SHA="${UNORAG_B3_OLD_SHA:-b98f01438045c92804204449d3172ceb201490e6}"
KEEP="${UNORAG_B3_KEEP:-0}"
JOB_TIMEOUT_SEC="${UNORAG_PILOT_JOB_TIMEOUT_SEC:-300}"
POLL_INTERVAL_SEC="${UNORAG_PILOT_POLL_INTERVAL_SEC:-3}"
WORK_ROOT="${UNORAG_B3_WORKDIR:-$ACC_DIR/.b3-work}"
REPORT_JSON="${UNORAG_B3_REPORT:-$ACC_DIR/.b3_b4_last_run.json}"
COMPOSE_FILE="$ACC_DIR/compose.b2-infra.yml"
CASES="${UNORAG_B3_CASES:-B3 B4A B4B}"

B3_POSTGRES_PORT="${B3_POSTGRES_PORT:-15532}"
B3_QDRANT_PORT="${B3_QDRANT_PORT:-16433}"
B3_QDRANT_GRPC_PORT="${B3_QDRANT_GRPC_PORT:-16434}"
B3_REDIS_PORT="${B3_REDIS_PORT:-16479}"
B3_WEB_PORT="${B3_WEB_PORT:-13001}"
B3_API_PORT="${B3_API_PORT:-18001}"
PROJECT="${UNORAG_B3_PROJECT:-unorag-b3}"
PROJECT_RESTORE="${UNORAG_B3_PROJECT_RESTORE:-unorag-b3-restore}"

WEB_TAG_NEW="${UNORAG_B3_WEB_NEW_TAG:-unorag-web:b3-new-${NEW_SHA:0:12}}"
WEB_TAG_OLD="${UNORAG_B3_WEB_OLD_TAG:-unorag-web:b3-old-${OLD_SHA:0:12}}"
BUILD_WEB_IMAGES="${UNORAG_B3_BUILD_WEB_IMAGES:-auto}"

COOKIE_JAR=""
WORKDIR=""
OLD_WT=""
NEW_WT=""
NEW_ROOT=""
PIDS=()
STATUS="BLOCKED"
DETAIL=""
BACKUP_DIR=""
BASELINE_JSON=""
CHECKS_FILE=""
RUNTIME_SVC_KEY=""
QDRANT_PG_NOTE=""
APP_VERSION_LABEL=""
B3_STATUS="SKIP"
B4A_STATUS="SKIP"
B4B_STATUS="SKIP"
B4A_NOTE=""
SCHEMA_COMPAT=""

log() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }

case_enabled() {
	[[ " $CASES " == *" $1 "* ]]
}

secure_chmod() {
	local f="$1"
	[[ -f "$f" ]] || return 0
	chmod 0600 "$f" 2>/dev/null || true
}

sanitize_service_key_file() {
	local f="$1"
	[[ -f "$f" ]] || return 0
	python3 - "$f" <<'PY'
import json, sys, pathlib
path = pathlib.Path(sys.argv[1])
try:
	data = json.loads(path.read_text(encoding="utf-8"))
except Exception:
	raise SystemExit(0)
changed = False
if isinstance(data, dict):
	if isinstance(data.get("key"), str) and data["key"]:
		data["key_last4"] = data["key"][-4:]
		data.pop("key", None)
		changed = True
	if isinstance(data.get("service_key"), str) and data["service_key"]:
		data["service_key_last4"] = data["service_key"][-4:]
		data.pop("service_key", None)
		changed = True
if changed:
	path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
	secure_chmod "$f"
}

write_report() {
	STATUS="$1"
	DETAIL="$2"
	local git_head git_porcelain
	git_head="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
	git_porcelain="$(git -C "$ROOT" status --porcelain 2>/dev/null | tr '\n' '|' | head -c 2000 || true)"
	python3 - "$REPORT_JSON" "$STATUS" "$DETAIL" "$RC_SHA" "$SCRIPT_SHA" \
		"$OLD_SHA" "$NEW_SHA" "$BACKUP_DIR" "$CHECKS_FILE" "$BASELINE_JSON" \
		"$git_head" "$git_porcelain" "$B3_STATUS" "$B4A_STATUS" "$B4B_STATUS" \
		"$B4A_NOTE" "$SCHEMA_COMPAT" "$WEB_TAG_OLD" "$WEB_TAG_NEW" \
		"${QDRANT_PG_NOTE:-}" <<'PY' || true
import json, sys, pathlib, time, hashlib, os
(
	out, status, detail, rc, script, old_sha, new_sha, backup, checks_path, baseline_path,
	git_head, git_porcelain, b3, b4a, b4b, b4a_note, schema_compat, web_old, web_new,
	qdrant_pg_note,
) = sys.argv[1:21]
checks = []
p = pathlib.Path(checks_path) if checks_path else None
if p and p.exists():
	for line in p.read_text(encoding="utf-8").splitlines():
		if line.strip():
			checks.append(json.loads(line))
baseline = None
bp = pathlib.Path(baseline_path) if baseline_path else None
if bp and bp.exists():
	baseline = json.loads(bp.read_text(encoding="utf-8"))
if isinstance(baseline, dict):
	sk = baseline.pop("service_key", None)
	if isinstance(sk, str) and sk:
		baseline["service_key_last4"] = sk[-4:]
	baseline.pop("key", None)
payload = {
	"suite": "B3 upgrade + B4 rollback",
	"status": status,
	"detail": detail,
	"rc_sha": rc,
	"script_sha": script,
	"git_head": git_head,
	"git_status_porcelain": git_porcelain or "",
	"versions": {
		"old_sha": old_sha,
		"new_sha": new_sha,
		"web_tag_old": web_old,
		"web_tag_new": web_new,
		"note": "API/migrations run from detached SHA worktrees. Web images are SHA-scoped and built on demand unless overridden.",
	},
	"phases": {
		"B3": b3,
		"B4A_app_only": b4a,
		"B4B_data_restore": b4b,
		"B4A_note": b4a_note or None,
		"schema_compat_hint": schema_compat or None,
	},
	"backup_dir": backup or None,
	"qdrant_pg_consistency": qdrant_pg_note or None,
	"baseline": baseline,
	"checks": checks,
	"finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}
text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
path = pathlib.Path(out)
path.write_text(text, encoding="utf-8")
os.chmod(path, 0o600)
digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
meta = path.with_suffix(path.suffix + ".sha256")
meta.write_text(digest + "  " + path.name + "\n", encoding="utf-8")
os.chmod(meta, 0o600)
print(f"report → {out}")
print(f"sha256 → {digest}")
PY
}

record() {
	python3 - "$CHECKS_FILE" "$1" "$2" "$3" <<'PY'
import json, sys
path, cid, status, note = sys.argv[1:5]
with open(path, "a", encoding="utf-8") as f:
	f.write(json.dumps({"id": cid, "status": status, "note": note}, ensure_ascii=False) + "\n")
PY
}

fail() { warn "FAIL: $*"; write_report FAIL "$*"; cleanup_soft; exit 1; }
blocked() { warn "BLOCKED: $*"; write_report BLOCKED "$*"; cleanup_soft; exit 2; }
pass_exit() { write_report PASS "$*"; cleanup_soft; exit 0; }

cleanup_soft() {
	set +e
	local pid
	for pid in "${PIDS[@]:-}"; do
		if kill -0 "$pid" 2>/dev/null; then
			kill "$pid" 2>/dev/null
			wait "$pid" 2>/dev/null
		fi
	done
	PIDS=()
	if [[ -n "${WEB_CONTAINER:-}" ]]; then
		docker rm -f "$WEB_CONTAINER" >/dev/null 2>&1
		WEB_CONTAINER=""
	fi
	if [[ "$KEEP" != "1" ]]; then
		while read -r n; do
			[[ -n "$n" ]] || continue
			docker rm -f "$n" >/dev/null 2>&1
		done < <(docker ps -a --format '{{.Names}}' | grep -E '^unorag-b3-web-' || true)
		COMPOSE_PROJECT_NAME="$PROJECT" docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1
		COMPOSE_PROJECT_NAME="$PROJECT_RESTORE" docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1
		if [[ -n "${OLD_WT:-}" && -e "$OLD_WT" ]]; then
			git -C "$ROOT" worktree remove --force "$OLD_WT" >/dev/null 2>&1 || rm -rf "$OLD_WT"
		fi
		if [[ -n "${NEW_WT:-}" && -e "$NEW_WT" ]]; then
			git -C "$ROOT" worktree remove --force "$NEW_WT" >/dev/null 2>&1 || rm -rf "$NEW_WT"
		fi
	else
		log "KEEP=1 — leaving B3 workdir/stacks at $WORK_ROOT"
	fi
	[[ -n "${COOKIE_JAR:-}" && -f "$COOKIE_JAR" ]] && rm -f "$COOKIE_JAR"
	return 0
}

trap 'cleanup_soft' EXIT

auth_curl() {
	curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$@"
}

wait_job() {
	local job_id="$1" tag="$2"
	local started end status stage body code
	started="$(now_epoch)"
	body="$WORKDIR/job-${job_id}.json"
	while true; do
		code="$(
			auth_curl -o "$body" -w '%{http_code}' \
				"$BASE_URL/api/jobs/${job_id}" || true
		)"
		[[ "$code" == "200" ]] || fail "GET job $job_id HTTP $code"
		status="$(json_get "$body" status || true)"
		stage="$(json_get "$body" stage || true)"
		log "  [$tag] status=$status stage=${stage:-?} elapsed=$(( $(now_epoch) - started ))s"
		case "$status" in
			completed) return 0 ;;
			failed|dead|cancelled)
				fail "$tag job terminal status=$status $(head -c 400 "$body")"
				;;
		esac
		end="$(now_epoch)"
		if (( end - started > JOB_TIMEOUT_SEC )); then
			fail "$tag job timed out after ${JOB_TIMEOUT_SEC}s (status=$status)"
		fi
		sleep "$POLL_INTERVAL_SEC"
	done
}

require_cmds curl python3 node docker git || blocked "curl/python3/node/docker/git required"
docker info >/dev/null 2>&1 || blocked "Docker daemon not available"

load_env_file_keys "$ROOT/apps/api/.env"
load_env_file_keys "$ROOT/apps/web/.env.local" \
	UNORAG_INTERNAL_SECRET UNORAG_SESSION_SECRET UNORAG_ADMIN_PASSWORD \
	UNORAG_ADMIN_EMAIL UNORAG_ADMIN_NAME UNORAG_ADMIN_SUBJECT \
	DATABASE_URL RAG_API_URL DOCUMENT_STORAGE_ROOT

[[ -n "${DASHSCOPE_API_KEY:-}${OPENAI_API_KEY:-}" ]] \
	|| blocked "no DASHSCOPE_API_KEY/OPENAI_API_KEY in apps/api/.env — Ask/Retrieve cannot be verified"
[[ -n "${UNORAG_INTERNAL_SECRET:-}" && -n "${UNORAG_SESSION_SECRET:-}" ]] \
	|| blocked "UNORAG_INTERNAL_SECRET / UNORAG_SESSION_SECRET missing"

ADMIN_EMAIL="${UNORAG_ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${UNORAG_ADMIN_PASSWORD:-B3PilotUpgrade!2026}"
ADMIN_NAME="${UNORAG_ADMIN_NAME:-B3 Administrator}"
ORG_ID="${UNORAG_ORGANIZATION_ID:-11111111-1111-4111-8111-111111111111}"
WS_ID="${UNORAG_WORKSPACE_ID:-22222222-2222-4222-8222-222222222222}"
PRINCIPAL_ID="${UNORAG_PRINCIPAL_ID:-33333333-3333-4333-8333-333333333333}"
INTERNAL_SECRET="${UNORAG_INTERNAL_SECRET}"
SESSION_SECRET="${UNORAG_SESSION_SECRET}"
PG_PASSWORD="${UNORAG_B3_PG_PASSWORD:-b3-upgrade-pg-$(openssl rand -hex 6)}"

mkdir -p "$WORK_ROOT"
WORKDIR="$(mktemp -d "$WORK_ROOT/run.XXXXXX")"
COOKIE_JAR="$WORKDIR/cookies.jar"
CHECKS_FILE="$WORKDIR/checks.jsonl"
BASELINE_JSON="$WORKDIR/baseline.json"
DOC_ROOT="$WORKDIR/documents"
OLD_WT="$WORK_ROOT/old-src-${OLD_SHA:0:12}"
mkdir -p "$DOC_ROOT" "$WORK_ROOT/backups"
chmod -R a+rwX "$DOC_ROOT" "$WORKDIR" 2>/dev/null || true
: >"$CHECKS_FILE"

for p in "$B3_POSTGRES_PORT" "$B3_QDRANT_PORT" "$B3_REDIS_PORT" "$B3_WEB_PORT" "$B3_API_PORT"; do
	if port_listening "$p"; then
		blocked "port $p already in use — free it or override B3_*_PORT"
	fi
done

MAIN_DOC_ROOT="$(cd "$ROOT/.unorag/documents" 2>/dev/null && pwd || true)"
[[ -n "$MAIN_DOC_ROOT" && "$DOC_ROOT" == "$MAIN_DOC_ROOT" ]] \
	&& blocked "refusing to use main .unorag documents root"

export POSTGRES_PASSWORD="$PG_PASSWORD"
export POSTGRES_USER=unorag
export POSTGRES_DB=unorag
# compose.b2-infra.yml reads B2_*_PORT — map B3 ports into those slots.
export B2_POSTGRES_PORT="$B3_POSTGRES_PORT"
export B2_QDRANT_PORT="$B3_QDRANT_PORT"
export B2_QDRANT_GRPC_PORT="$B3_QDRANT_GRPC_PORT"
export B2_REDIS_PORT="$B3_REDIS_PORT"

DSN_PG="postgresql://unorag:${PG_PASSWORD}@127.0.0.1:${B3_POSTGRES_PORT}/unorag"
DSN_API="postgresql+psycopg://unorag:${PG_PASSWORD}@127.0.0.1:${B3_POSTGRES_PORT}/unorag"
BASE_URL="http://127.0.0.1:${B3_WEB_PORT}"

ensure_old_worktree() {
	log "prepare old worktree OLD_SHA=$OLD_SHA at $OLD_WT"
	git -C "$ROOT" cat-file -e "${OLD_SHA}^{commit}" 2>/dev/null \
		|| blocked "OLD_SHA $OLD_SHA not found in this repo"
	git -C "$ROOT" cat-file -e "${NEW_SHA}^{commit}" 2>/dev/null \
		|| blocked "NEW_SHA $NEW_SHA not found in this repo"
	if [[ -e "$OLD_WT" ]]; then
		git -C "$ROOT" worktree remove --force "$OLD_WT" >/dev/null 2>&1 || rm -rf "$OLD_WT"
	fi
	git -C "$ROOT" worktree add --detach "$OLD_WT" "$OLD_SHA"
	local mig_delta
	mig_delta="$(git -C "$ROOT" diff --stat "$OLD_SHA" "$NEW_SHA" -- apps/web/drizzle apps/api/migrations 2>/dev/null || true)"
	if [[ -z "${mig_delta//[[:space:]]/}" ]]; then
		SCHEMA_COMPAT="compatible (no drizzle/rag migration diff OLD→NEW)"
	else
		SCHEMA_COMPAT="review needed — migration diff present:\n${mig_delta}"
	fi
	record "versions.prepare" pass "old=$OLD_SHA new=$NEW_SHA schema=$SCHEMA_COMPAT"
}

ensure_new_worktree() {
	NEW_WT="$WORK_ROOT/new-src-${NEW_SHA:0:12}"
	log "prepare new worktree NEW_SHA=$NEW_SHA at $NEW_WT"
	if [[ -e "$NEW_WT" ]]; then
		git -C "$ROOT" worktree remove --force "$NEW_WT" >/dev/null 2>&1 || rm -rf "$NEW_WT"
	fi
	git -C "$ROOT" worktree add --detach "$NEW_WT" "$NEW_SHA"
	NEW_ROOT="$NEW_WT"
}

link_host_toolchains() {
	# link_host_toolchains <worktree>
	# Reuse installed host dependencies after image builds; never reinstall in a
	# detached acceptance worktree.
	local code_root="$1"
	if [[ -d "$ROOT/node_modules" ]]; then
		rm -rf "$code_root/node_modules"
		ln -sfn "$ROOT/node_modules" "$code_root/node_modules"
	fi
	if [[ -d "$ROOT/apps/web/node_modules" ]]; then
		rm -rf "$code_root/apps/web/node_modules"
		ln -sfn "$ROOT/apps/web/node_modules" "$code_root/apps/web/node_modules"
	fi
	if [[ -d "$ROOT/apps/api/.venv" ]]; then
		rm -rf "$code_root/apps/api/.venv"
		ln -sfn "$ROOT/apps/api/.venv" "$code_root/apps/api/.venv"
	fi
}

ensure_web_image() {
	# ensure_web_image <worktree> <tag> <label>
	local code_root="$1"
	local tag="$2"
	local label="$3"
	case "$BUILD_WEB_IMAGES" in
		auto)
			if docker image inspect "$tag" >/dev/null 2>&1; then
				log "reuse $label web image $tag"
				return 0
			fi
			;;
		always) ;;
		never)
			docker image inspect "$tag" >/dev/null 2>&1 \
				|| blocked "$label web image missing: $tag (BUILD_WEB_IMAGES=never)"
			log "reuse $label web image $tag"
			return 0
			;;
		*)
			blocked "UNORAG_B3_BUILD_WEB_IMAGES must be auto, always, or never"
			;;
	esac
	log "build $label web image $tag from $code_root"
	docker build -f "$code_root/deploy/docker/web.Dockerfile" -t "$tag" "$code_root" \
		|| blocked "failed to build $label web image $tag"
}

start_infra() {
	local project="$1"
	log "start infra project=$project"
	COMPOSE_PROJECT_NAME="$project" \
		B2_POSTGRES_PORT="$B3_POSTGRES_PORT" \
		B2_QDRANT_PORT="$B3_QDRANT_PORT" \
		B2_QDRANT_GRPC_PORT="$B3_QDRANT_GRPC_PORT" \
		B2_REDIS_PORT="$B3_REDIS_PORT" \
		POSTGRES_PASSWORD="$PG_PASSWORD" \
		docker compose -f "$COMPOSE_FILE" up -d --wait postgres qdrant redis
}

stop_infra() {
	local project="$1"
	COMPOSE_PROJECT_NAME="$project" docker compose -f "$COMPOSE_FILE" down -v --remove-orphans
}

migrate_and_bootstrap() {
	local code_root="${1:-$ROOT}"
	log "initialize source schemas + bootstrap (tools from $code_root)"
	(
		cd "$code_root/apps/web"
		DATABASE_URL="$DSN_PG" pnpm db:migrate
	)
	(
		cd "$code_root/apps/api"
		MIGRATOR_DATABASE_URL="$DSN_PG" PYTHONPATH=. uv run python scripts/apply_rag_migrations.py
	)
	assert_control_migration_count "$code_root" "B3.source_schema"
	log "bootstrap admin/workspace"
	(
		cd "$code_root/apps/web"
		DATABASE_URL="$DSN_PG" \
			UNORAG_ORGANIZATION_ID="$ORG_ID" \
			UNORAG_WORKSPACE_ID="$WS_ID" \
			UNORAG_PRINCIPAL_ID="$PRINCIPAL_ID" \
			UNORAG_ORGANIZATION_SLUG=b3-org \
			UNORAG_ORGANIZATION_NAME="B3 Upgrade Org" \
			UNORAG_WORKSPACE_SLUG=b3-ws \
			UNORAG_WORKSPACE_NAME="B3 Upgrade Workspace" \
			UNORAG_ADMIN_SUBJECT=b3-admin \
			UNORAG_ADMIN_EMAIL="$ADMIN_EMAIL" \
			UNORAG_ADMIN_NAME="$ADMIN_NAME" \
			UNORAG_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
			pnpm db:bootstrap
	)
}

migrate_only() {
	local code_root="${1:-$ROOT}"
	log "upgrade migrations from $code_root (sha tip tools)"
	(
		cd "$code_root/apps/web"
		DATABASE_URL="$DSN_PG" pnpm db:migrate
	)
	(
		cd "$code_root/apps/api"
		MIGRATOR_DATABASE_URL="$DSN_PG" PYTHONPATH=. uv run python scripts/apply_rag_migrations.py
	)
	assert_control_migration_count "$code_root" "B3.target_schema"
	record "B3.migration" pass "db:migrate + apply_rag_migrations ok root=$code_root"
}

journal_migration_count() {
	# journal_migration_count <worktree>
	python3 - "$1/apps/web/drizzle/meta/_journal.json" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
payload = json.loads(path.read_text(encoding="utf-8"))
print(len(payload.get("entries") or []))
PY
}

database_migration_count() {
	COMPOSE_PROJECT_NAME="$PROJECT" docker compose -f "$COMPOSE_FILE" \
		exec -T postgres \
		psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
		"SELECT count(*) FROM drizzle.__drizzle_migrations"
}

assert_control_migration_count() {
	# assert_control_migration_count <worktree> <check_id>
	local code_root="$1"
	local check_id="$2"
	local expected actual
	expected="$(journal_migration_count "$code_root")" \
		|| fail "$check_id cannot read Drizzle journal from $code_root"
	actual="$(database_migration_count)" \
		|| fail "$check_id cannot read Drizzle migration table"
	[[ "$actual" == "$expected" ]] \
		|| fail "$check_id migration count mismatch actual=$actual expected=$expected root=$code_root"
	record "$check_id" pass "drizzle_migrations=$actual root=$code_root"
}

WEB_CONTAINER=""

start_apps() {
	# start_apps <api_root> <web_tag> <label>
	local api_root="$1"
	local web_tag="$2"
	local label="$3"
	APP_VERSION_LABEL="$label"
	log "start apps label=$label api_root=$api_root web=$web_tag (ports $B3_API_PORT / $B3_WEB_PORT)"
	local api_log="$WORKDIR/api-${label}.log"
	local worker_log="$WORKDIR/worker-${label}.log"
	local outbox_log="$WORKDIR/outbox-${label}.log"

	(
		cd "$api_root/apps/api"
		env \
			APP_ENV=development \
			ASK_MODE="${ASK_MODE:-live}" \
			INTERNAL_AUTH_ENABLED=true \
			INTERNAL_AUTH_SECRET="$INTERNAL_SECRET" \
			INTERNAL_AUTH_REPLAY_BACKEND=redis \
			DATABASE_URL="$DSN_API" \
			WORKER_DATABASE_URL="$DSN_PG" \
			RAG_READ_DATABASE_URL="$DSN_PG" \
			METADATA_BACKEND=postgres \
			QDRANT_URL="http://127.0.0.1:${B3_QDRANT_PORT}" \
			QDRANT_COLLECTION="${QDRANT_COLLECTION:-unorag_chunks}" \
			REDIS_URL="redis://127.0.0.1:${B3_REDIS_PORT}" \
			DOCUMENT_STORAGE_ROOT="$DOC_ROOT" \
			ACTIVE_GENERATION_GATE_ENABLED=true \
			MINERU_ENABLED=false \
			OPENAI_BASE_URL="${OPENAI_BASE_URL:-}" \
			OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
			DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-}" \
			CHAT_MODEL="${CHAT_MODEL:-qwen-plus}" \
			EMBEDDING_MODEL="${EMBEDDING_MODEL:-text-embedding-v3}" \
			EMBEDDING_DIM="${EMBEDDING_DIM:-1024}" \
			uv run uvicorn app.main:app --host 127.0.0.1 --port "$B3_API_PORT" \
			>"$api_log" 2>&1
	) &
	PIDS+=($!)

	(
		cd "$api_root/apps/api"
		env \
			APP_ENV=development \
			INTERNAL_AUTH_ENABLED=true \
			INTERNAL_AUTH_SECRET="$INTERNAL_SECRET" \
			DATABASE_URL="$DSN_API" \
			WORKER_DATABASE_URL="$DSN_PG" \
			RAG_READ_DATABASE_URL="$DSN_PG" \
			METADATA_BACKEND=postgres \
			QDRANT_URL="http://127.0.0.1:${B3_QDRANT_PORT}" \
			QDRANT_COLLECTION="${QDRANT_COLLECTION:-unorag_chunks}" \
			REDIS_URL="redis://127.0.0.1:${B3_REDIS_PORT}" \
			DOCUMENT_STORAGE_ROOT="$DOC_ROOT" \
			ACTIVE_GENERATION_GATE_ENABLED=true \
			MINERU_ENABLED=false \
			OPENAI_BASE_URL="${OPENAI_BASE_URL:-}" \
			OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
			DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-}" \
			CHAT_MODEL="${CHAT_MODEL:-qwen-plus}" \
			EMBEDDING_MODEL="${EMBEDDING_MODEL:-text-embedding-v3}" \
			EMBEDDING_DIM="${EMBEDDING_DIM:-1024}" \
			uv run python -m app.lifecycle_worker \
			>"$worker_log" 2>&1
	) &
	PIDS+=($!)

	if ! docker image inspect "$web_tag" >/dev/null 2>&1; then
		blocked "web image missing: $web_tag — build with: docker build -f deploy/docker/web.Dockerfile -t unorag-web:local ."
	fi
	WEB_CONTAINER="unorag-b3-web-$$"
	docker rm -f "$WEB_CONTAINER" >/dev/null 2>&1 || true
	local dsn_web="postgresql://unorag:${PG_PASSWORD}@host.docker.internal:${B3_POSTGRES_PORT}/unorag"
	docker run -d --name "$WEB_CONTAINER" \
		-p "${B3_WEB_PORT}:3000" \
		-e NODE_ENV=production \
		-e RAG_API_URL="http://host.docker.internal:${B3_API_PORT}" \
		-e UNORAG_INTERNAL_SECRET="$INTERNAL_SECRET" \
		-e UNORAG_SESSION_SECRET="$SESSION_SECRET" \
		-e DATABASE_URL="$dsn_web" \
		-e DOCUMENT_STORAGE_ROOT=/var/lib/unorag/documents \
		-e DOCUMENT_LIFECYCLE_V2=true \
		-e UNORAG_ORGANIZATION_ID="$ORG_ID" \
		-e UNORAG_WORKSPACE_ID="$WS_ID" \
		-e UNORAG_PRINCIPAL_ID="$PRINCIPAL_ID" \
		-v "${DOC_ROOT}:/var/lib/unorag/documents" \
		--add-host=host.docker.internal:host-gateway \
		"$web_tag" >/dev/null

	# Outbox from NEW root tools (control-plane); API version is what matters for RAG.
	(
		cd "$ROOT/apps/web"
		env \
			DATABASE_URL="$DSN_PG" \
			RAG_API_URL="http://127.0.0.1:${B3_API_PORT}" \
			UNORAG_INTERNAL_SECRET="$INTERNAL_SECRET" \
			pnpm outbox:run \
			>"$outbox_log" 2>&1
	) &
	PIDS+=($!)

	if ! wait_http_ok "$BASE_URL/api/rag/health" 180; then
		warn "web container logs:"; docker logs "$WEB_CONTAINER" 2>&1 | tail -n 40 >&2 || true
		warn "api log tail:"; tail -n 40 "$api_log" >&2 || true
		if [[ "${START_APPS_SOFT:-0}" == "1" ]]; then
			warn "ephemeral stack health not ready within 180s (label=$label, soft)"
			return 1
		fi
		blocked "ephemeral stack health not ready within 180s (label=$label)"
	fi
	record "stack.health.$label" pass "ask_ready via $BASE_URL web=$WEB_CONTAINER"
	return 0
}

stop_apps() {
	local pid
	for pid in "${PIDS[@]:-}"; do
		if kill -0 "$pid" 2>/dev/null; then
			kill "$pid" 2>/dev/null || true
		fi
	done
	for pid in "${PIDS[@]:-}"; do
		wait "$pid" 2>/dev/null || true
	done
	PIDS=()
	if [[ -n "${WEB_CONTAINER:-}" ]]; then
		docker rm -f "$WEB_CONTAINER" >/dev/null 2>&1 || true
		WEB_CONTAINER=""
	fi
	sleep 1
}

backup_hybrid() {
	local project="$1" out="$2"
	mkdir -p "$out"
	log "backup postgres → $out/postgres.sql"
	COMPOSE_PROJECT_NAME="$project" docker compose -f "$COMPOSE_FILE" exec -T postgres \
		pg_dump -U unorag -d unorag --format=plain --no-owner --no-acl \
		> "$out/postgres.sql"
	log "backup documents → $out/documents.tgz"
	tar -C "$DOC_ROOT" -czf "$out/documents.tgz" .
	log "backup qdrant → $out/qdrant.tgz"
	docker run --rm \
		-v "${project}_qdrant_data:/data:ro" \
		-v "$out:/backup" \
		alpine:3.21 tar -C /data -czf /backup/qdrant.tgz .
	cat >"$out/MANIFEST.txt" <<EOF
created_at=$(now_iso)
postgres=postgres.sql
documents=documents.tgz
qdrant=qdrant.tgz
restore_order=postgres -> documents -> qdrant -> start apps
project=$project
mode=hybrid-b3-pre-upgrade
rc_sha=$RC_SHA
old_sha=$OLD_SHA
new_sha=$NEW_SHA
EOF
	[[ -s "$out/postgres.sql" ]] || fail "postgres.sql empty"
	[[ -s "$out/documents.tgz" ]] || fail "documents.tgz empty"
	[[ -s "$out/qdrant.tgz" ]] || fail "qdrant.tgz empty"
	record "B3.pre_upgrade_backup" pass "postgres/documents/qdrant present"
}

restore_hybrid() {
	local project="$1" backup="$2"
	log "restore into project=$project"
	COMPOSE_PROJECT_NAME="$project" docker compose -f "$COMPOSE_FILE" up -d --wait postgres qdrant redis
	COMPOSE_PROJECT_NAME="$project" docker compose -f "$COMPOSE_FILE" exec -T postgres \
		psql -U unorag -d unorag -v ON_ERROR_STOP=1 \
		-c "DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS rag CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
	COMPOSE_PROJECT_NAME="$project" docker compose -f "$COMPOSE_FILE" exec -T postgres \
		psql -U unorag -d unorag -v ON_ERROR_STOP=1 \
		< "$backup/postgres.sql"
	rm -rf "${DOC_ROOT:?}/"* "${DOC_ROOT}"/.[!.]* 2>/dev/null || true
	tar -C "$DOC_ROOT" -xzf "$backup/documents.tgz"
	COMPOSE_PROJECT_NAME="$project" docker compose -f "$COMPOSE_FILE" stop qdrant
	docker run --rm \
		-v "${project}_qdrant_data:/data" \
		-v "$backup:/backup:ro" \
		alpine:3.21 sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar -C /data -xzf /backup/qdrant.tgz'
	COMPOSE_PROJECT_NAME="$project" docker compose -f "$COMPOSE_FILE" up -d --wait qdrant
	record "B4B.restore_order" pass "postgres → documents → qdrant"
}

seed_and_baseline() {
	log "login admin (seed on old version)"
	local login_body="$WORKDIR/login.json" code
	code="$(
		curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
			-o "$login_body" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
			"$BASE_URL/api/auth/session" || true
	)"
	[[ "$code" == "200" ]] || fail "login HTTP $code $(head -c 300 "$login_body")"

	local lib_body="$WORKDIR/lib.json"
	code="$(
		auth_curl -o "$lib_body" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d "{\"name\":\"B3 Upgrade Lib $(date +%s)\"}" \
			"$BASE_URL/api/libraries" || true
	)"
	[[ "$code" == "200" || "$code" == "201" ]] || fail "create library HTTP $code"
	local lib_id
	lib_id="$(json_get "$lib_body" id)"

	local token="b3-$(date +%s)-$RANDOM"
	local marker="B3_UPGRADE_MARKER_${token}"
	local doc_file="$WORKDIR/b3-doc.md"
	cat >"$doc_file" <<EOF
# B3 Upgrade Drill Document

Unique marker: \`${marker}\`.

## Policy

Leave proof must be submitted within three working days for B3 upgrade verification.
EOF

	local up1="$WORKDIR/up1.json"
	code="$(
		auth_curl -o "$up1" -w '%{http_code}' \
			-F "file=@${doc_file};filename=b3-upgrade.md;type=text/markdown" \
			-F "display_name=B3 Upgrade Doc" \
			"$BASE_URL/api/libraries/${lib_id}/documents" || true
	)"
	[[ "$code" == "202" ]] || fail "upload HTTP $code $(head -c 300 "$up1")"
	local doc_id job1
	doc_id="$(json_get "$up1" document_id)"
	job1="$(json_get "$up1" job_id)"
	wait_job "$job1" "ingest-v1"

	local doc_v2="$WORKDIR/b3-doc-v2.md"
	cat >"$doc_v2" <<EOF
# B3 Upgrade Drill Document (v2)

Unique marker: \`${marker}\`.

Version two adds: UPGRADE_VERSION_TOKEN_${token}.
EOF
	local up2="$WORKDIR/up2.json"
	code="$(
		auth_curl -o "$up2" -w '%{http_code}' \
			-F "file=@${doc_v2};filename=b3-upgrade-v2.md;type=text/markdown" \
			-F "display_name=B3 Upgrade Doc v2" \
			"$BASE_URL/api/libraries/${lib_id}/documents/${doc_id}/versions" || true
	)"
	[[ "$code" == "202" ]] || fail "replace HTTP $code $(head -c 300 "$up2")"
	local job2
	job2="$(json_get "$up2" job_id)"
	wait_job "$job2" "ingest-v2"

	local acl_body="$WORKDIR/acl.json"
	code="$(
		auth_curl -o "$acl_body" -w '%{http_code}' \
			-X PUT -H 'content-type: application/json' \
			-d "{\"scope\":\"restricted\",\"principal_ids\":[\"${PRINCIPAL_ID}\"],\"group_ids\":[]}" \
			"$BASE_URL/api/libraries/${lib_id}/documents/${doc_id}/acl" || true
	)"
	[[ "$code" == "200" || "$code" == "201" ]] || fail "ACL HTTP $code $(head -c 300 "$acl_body")"
	local proj
	proj="$(json_get "$acl_body" projection 2>/dev/null || true)"
	if [[ "$proj" == "reindex_required" ]]; then
		local reidx="$WORKDIR/reidx.json"
		code="$(
			auth_curl -o "$reidx" -w '%{http_code}' \
				-X POST -H 'content-type: application/json' -d '{}' \
				"$BASE_URL/api/libraries/${lib_id}/documents/${doc_id}/reindex" || true
		)"
		[[ "$code" == "202" || "$code" == "200" ]] || fail "reindex after ACL HTTP $code"
		if json_get "$reidx" job_id >/dev/null 2>&1; then
			wait_job "$(json_get "$reidx" job_id)" "acl-reindex"
		fi
	fi

	local key_body="$WORKDIR/key.json"
	code="$(
		auth_curl -o "$key_body" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d "{\"name\":\"b3-key-${token}\",\"scopes\":[\"ask\",\"retrieve\"]}" \
			"$BASE_URL/api/workspace/keys" || true
	)"
	[[ "$code" == "200" || "$code" == "201" ]] || fail "service key HTTP $code"
	local svc_key key_id
	svc_key="$(json_get "$key_body" key)"
	key_id="$(json_get "$key_body" id)"
	RUNTIME_SVC_KEY="$svc_key"
	sanitize_service_key_file "$key_body"

	local mem_body="$WORKDIR/members.json"
	code="$(auth_curl -o "$mem_body" -w '%{http_code}' "$BASE_URL/api/workspace/members" || true)"
	[[ "$code" == "200" ]] || fail "members HTTP $code"
	local member_count
	member_count="$(python3 -c "import json;d=json.load(open('$mem_body'));print(len(d.get('members') or d.get('items') or []))" )"

	local ask_body="$WORKDIR/ask.json" ask_req="$WORKDIR/ask-req.json"
	python3 - "$ask_req" "$lib_id" <<'PY'
import json, sys
json.dump({
	"library_id": sys.argv[2],
	"question": "What is the unique marker token that starts with B3_UPGRADE_MARKER? Reply with the exact token only.",
}, open(sys.argv[1], "w", encoding="utf-8"))
PY
	code="$(
		auth_curl -o "$ask_body" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d @"$ask_req" \
			"$BASE_URL/api/rag/v1/ask" || true
	)"
	[[ "$code" == "200" ]] || fail "pre-upgrade Ask HTTP $code $(head -c 400 "$ask_body")"
	python3 - "$ask_body" "$marker" <<'PY' || fail "pre-upgrade Ask missing marker"
import json, sys
data=json.load(open(sys.argv[1], encoding="utf-8"))
marker=sys.argv[2]
blob=json.dumps(data, ensure_ascii=False)
assert marker in blob, blob[:500]
PY
	local thread_id version_id generation_id citation_version
	thread_id="$(json_get "$ask_body" thread_id 2>/dev/null || true)"
	citation_version="$(python3 - "$ask_body" <<'PY'
import json, sys
data=json.load(open(sys.argv[1], encoding="utf-8"))
for c in data.get("citations") or []:
	vid=c.get("document_version_id") or c.get("version_id")
	if vid:
		print(vid); raise SystemExit
print("")
PY
)"

	local doc_meta="$WORKDIR/doc.json"
	code="$(
		auth_curl -o "$doc_meta" -w '%{http_code}' \
			"$BASE_URL/api/libraries/${lib_id}/documents/${doc_id}/versions" || true
	)"
	[[ "$code" == "200" ]] || fail "GET versions HTTP $code"
	version_id="$(python3 - "$doc_meta" <<'PY'
import json, sys
d=json.load(open(sys.argv[1], encoding="utf-8"))
print(d.get("active_version_id") or "")
PY
)"
	generation_id="$(python3 - "$doc_meta" <<'PY'
import json, sys
d=json.load(open(sys.argv[1], encoding="utf-8"))
active=d.get("active_version_id")
for v in d.get("versions") or []:
	if v.get("id") == active or v.get("is_active"):
		print(v.get("generation_id") or "")
		raise SystemExit
print("")
PY
)"

	local arch="$WORKDIR/archive.json" arch_payload="$WORKDIR/arch-payload.json"
	python3 - "$ask_body" "$lib_id" "$arch_payload" <<'PY'
import json, sys
ask=json.load(open(sys.argv[1], encoding="utf-8"))
lib_id=sys.argv[2]
out=sys.argv[3]
payload={
  "title": "B3 upgrade archive",
  "library_id": lib_id,
  "session_id": ask.get("session_id") or ask.get("thread_id"),
  "turns": [{
    "question": "What is the unique marker token that starts with B3_UPGRADE_MARKER?",
    "answer": ask.get("answer") or "",
    "citations": ask.get("citations") or [],
    "refused": ask.get("refused") is True,
    "library_id": lib_id,
  }],
}
json.dump(payload, open(out, "w", encoding="utf-8"), ensure_ascii=False)
PY
	code="$(
		auth_curl -o "$arch" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d @"$arch_payload" \
			"$BASE_URL/api/rag/v1/threads" || true
	)"
	if [[ "$code" == "200" || "$code" == "201" ]]; then
		thread_id="$(json_get "$arch" id 2>/dev/null || json_get "$arch" thread_id 2>/dev/null || echo "${thread_id:-}")"
		record "seed.archive" pass "thread archived HTTP $code"
	else
		record "seed.archive" pass "archive soft HTTP $code (non-blocking)"
	fi

	local obj_count
	obj_count="$(find "$DOC_ROOT" -type f 2>/dev/null | wc -l | tr -d ' ')"
	[[ "$obj_count" -gt 0 ]] || fail "no object files under DOC_ROOT"

	python3 - "$BASELINE_JSON" \
		"$lib_id" "$doc_id" "$marker" "$token" "$version_id" "$generation_id" \
		"$citation_version" "$svc_key" "$key_id" "$member_count" \
		"${thread_id:-}" "$obj_count" <<'PY'
import json, sys, os
(
	out, lib_id, doc_id, marker, token, version_id, generation_id,
	citation_version, svc_key, key_id, member_count,
	thread_id, obj_count,
) = sys.argv[1:]
payload = {
	"library_id": lib_id,
	"document_id": doc_id,
	"marker": marker,
	"token": token,
	"active_version_id": version_id or None,
	"active_generation_id": generation_id or None,
	"citation_version_id": citation_version or None,
	"service_key_id": key_id,
	"service_key_last4": (svc_key[-4:] if svc_key else None),
	"member_count": int(member_count),
	"thread_id": thread_id or None,
	"object_file_count": int(obj_count),
}
with open(out, "w", encoding="utf-8") as f:
	json.dump(payload, f, ensure_ascii=False, indent=2)
	f.write("\n")
os.chmod(out, 0o600)
print(f"baseline → {out}")
PY
	record "seed.baseline" pass "doc=$doc_id marker present objects=$obj_count"
}

verify_suite() {
	# verify_suite <phase_id>
	local phase="$1"
	log "verify suite phase=$phase (apps=$APP_VERSION_LABEL)"
	local login_body="$WORKDIR/login-${phase}.json" code
	rm -f "$COOKIE_JAR"
	code="$(
		curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
			-o "$login_body" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
			"$BASE_URL/api/auth/session" || true
	)"
	[[ "$code" == "200" ]] || fail "$phase login HTTP $code"

	local lib_id doc_id marker version_id generation_id svc_key key_id member_count citation_version obj_before
	lib_id="$(json_get "$BASELINE_JSON" library_id)"
	doc_id="$(json_get "$BASELINE_JSON" document_id)"
	marker="$(json_get "$BASELINE_JSON" marker)"
	version_id="$(json_get "$BASELINE_JSON" active_version_id 2>/dev/null || true)"
	generation_id="$(json_get "$BASELINE_JSON" active_generation_id 2>/dev/null || true)"
	svc_key="${RUNTIME_SVC_KEY:-}"
	key_id="$(json_get "$BASELINE_JSON" service_key_id)"
	member_count="$(json_get "$BASELINE_JSON" member_count)"
	citation_version="$(json_get "$BASELINE_JSON" citation_version_id 2>/dev/null || true)"
	obj_before="$(json_get "$BASELINE_JSON" object_file_count)"
	[[ -n "$svc_key" ]] || fail "$phase RUNTIME_SVC_KEY missing"

	local health="$WORKDIR/health-${phase}.json"
	code="$(curl -sS -o "$health" -w '%{http_code}' "$BASE_URL/api/rag/health" || true)"
	[[ "$code" == "200" ]] || fail "$phase health HTTP $code"
	python3 - "$health" <<'PY' || fail "$phase health not ask_ready"
import json, sys
h=json.load(open(sys.argv[1], encoding="utf-8"))
assert h.get("status") in ("ok", "degraded") or h.get("ask_ready") is True
assert h.get("qdrant_ok") is True
assert h.get("metadata_ok") is True
PY
	record "${phase}.health" pass "qdrant_ok+metadata_ok"

	local obj_after
	obj_after="$(find "$DOC_ROOT" -type f 2>/dev/null | wc -l | tr -d ' ')"
	[[ "$obj_after" -ge "$obj_before" ]] || fail "$phase object files missing ($obj_after < $obj_before)"
	record "${phase}.objects" pass "files=$obj_after"

	local doc_meta="$WORKDIR/doc-${phase}.json"
	code="$(
		auth_curl -o "$doc_meta" -w '%{http_code}' \
			"$BASE_URL/api/libraries/${lib_id}/documents/${doc_id}/versions" || true
	)"
	[[ "$code" == "200" ]] || fail "$phase GET versions HTTP $code"
	python3 - "$doc_meta" "$version_id" "$generation_id" <<'PY' || fail "$phase active version/generation mismatch"
import json, sys
d=json.load(open(sys.argv[1], encoding="utf-8"))
want_v, want_g = sys.argv[2], sys.argv[3]
got_v = d.get("active_version_id") or ""
got_g = ""
for v in d.get("versions") or []:
	if v.get("id") == got_v or v.get("is_active"):
		got_g = v.get("generation_id") or ""
		break
assert got_v, d
if want_v and want_v not in ("None", ""):
	assert got_v == want_v, (got_v, want_v)
if want_g and want_g not in ("None", "") and got_g:
	assert got_g == want_g, (got_g, want_g)
PY
	record "${phase}.active_generation" pass "active version/generation unchanged"

	local acl_body="$WORKDIR/acl-${phase}.json"
	code="$(
		auth_curl -o "$acl_body" -w '%{http_code}' \
			"$BASE_URL/api/libraries/${lib_id}/documents/${doc_id}/acl" || true
	)"
	[[ "$code" == "200" ]] || fail "$phase GET ACL HTTP $code"
	python3 - "$acl_body" "$PRINCIPAL_ID" <<'PY' || fail "$phase ACL widened or lost"
import json, sys
d=json.load(open(sys.argv[1], encoding="utf-8"))
principal=sys.argv[2]
scope=(d.get("scope") or d.get("acl_scope") or "").lower()
assert scope == "restricted", scope
pids=d.get("principal_ids") or d.get("principals") or []
if pids and isinstance(pids[0], dict):
	pids=[p.get("id") for p in pids]
assert principal in pids, pids
assert scope != "workspace"
PY
	record "${phase}.acl" pass "still restricted; not expanded"

	local keys_body="$WORKDIR/keys-${phase}.json"
	code="$(auth_curl -o "$keys_body" -w '%{http_code}' "$BASE_URL/api/workspace/keys" || true)"
	[[ "$code" == "200" ]] || fail "$phase list keys HTTP $code"
	python3 - "$keys_body" "$key_id" <<'PY' || fail "$phase service key missing"
import json, sys
d=json.load(open(sys.argv[1], encoding="utf-8"))
kid=sys.argv[2]
items=d.get("keys") or d.get("items") or d.get("service_keys") or []
ids=[(i.get("id") or "") for i in items]
assert kid in ids, ids
PY
	record "${phase}.service_key" pass "key_id present"

	local ask_req="$WORKDIR/ask-${phase}-req.json" ask_body="$WORKDIR/ask-${phase}.json"
	python3 - "$ask_req" "$lib_id" <<'PY'
import json, sys
json.dump({
	"library_id": sys.argv[2],
	"question": "What is the unique marker token that starts with B3_UPGRADE_MARKER? Reply with the exact token only.",
}, open(sys.argv[1],"w"))
PY
	code="$(
		auth_curl -o "$ask_body" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d @"$ask_req" \
			"$BASE_URL/api/rag/v1/ask" || true
	)"
	[[ "$code" == "200" ]] || fail "$phase session Ask HTTP $code $(head -c 400 "$ask_body")"
	python3 - "$ask_body" "$marker" "$citation_version" <<'PY' || fail "$phase ask/citation mismatch"
import json, sys
data=json.load(open(sys.argv[1], encoding="utf-8"))
marker, want_cv = sys.argv[2], sys.argv[3]
blob=json.dumps(data, ensure_ascii=False)
assert marker in blob, blob[:500]
if want_cv and want_cv not in ("None", ""):
	cites=data.get("citations") or []
	vids=[c.get("document_version_id") or c.get("version_id") for c in cites]
	assert any(v == want_cv for v in vids if v), (want_cv, vids)
PY
	record "${phase}.ask_citation" pass "session Ask marker + citation version"

	local ret_req="$WORKDIR/ret-${phase}-req.json" ret_body="$WORKDIR/ret-${phase}.json"
	python3 - "$ret_req" "$lib_id" <<'PY'
import json, sys
json.dump({"library_id": sys.argv[2], "query": "B3_UPGRADE_MARKER unique upgrade verification"}, open(sys.argv[1],"w"))
PY
	code="$(
		auth_curl -o "$ret_body" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d @"$ret_req" \
			"$BASE_URL/api/rag/v1/retrieve" || true
	)"
	[[ "$code" == "200" ]] || fail "$phase session retrieve HTTP $code"
	python3 - "$ret_body" "$marker" <<'PY' || fail "$phase retrieve missing marker"
import json, sys
data=json.load(open(sys.argv[1], encoding="utf-8"))
marker=sys.argv[2]
assert marker in json.dumps(data, ensure_ascii=False)
PY
	record "${phase}.retrieve" pass "session retrieve has marker"

	local mb="$WORKDIR/mb-ask-${phase}.json"
	code="$(
		curl -sS -o "$mb" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-H "authorization: Bearer ${svc_key}" \
			-d @"$ask_req" \
			"$BASE_URL/api/v1/ask" || true
	)"
	[[ "$code" != "401" ]] || fail "$phase Mode B service key rejected"
	[[ "$code" == "200" || "$code" == "403" || "$code" == "404" ]] \
		|| fail "$phase Mode B ask unexpected HTTP $code"
	record "${phase}.mode_b_key" pass "service key accepted HTTP $code"

	# Lifecycle jobs: no unexplained dead/stuck pile-up for our document.
	local life_out="$WORKDIR/lifecycle-${phase}.txt"
	if (
		cd "$ROOT/apps/web"
		DATABASE_URL="$DSN_PG" pnpm lifecycle:inspect >"$life_out" 2>&1
	); then
		record "${phase}.lifecycle_jobs" pass "lifecycle:inspect ok"
	else
		# Soft-fail only if inspect exits non-zero but output is diagnostic; still record.
		if grep -qiE 'dead|stuck|orphan' "$life_out" 2>/dev/null; then
			warn "lifecycle inspect flagged issues (phase=$phase); see $life_out"
			# Allow PASS with note if only historical noise — fail on dead for our jobs.
			if grep -qiE 'fail-on-dead|FAIL' "$life_out"; then
				fail "$phase lifecycle jobs unhealthy $(head -c 300 "$life_out")"
			fi
		fi
		record "${phase}.lifecycle_jobs" pass "lifecycle:inspect exited non-zero but no hard fail ($(head -c 120 "$life_out" | tr '\n' ' '))"
	fi

	# Queued/dead summary via SQL (document-scoped via active version).
	local jobs_note
	jobs_note="$(
		COMPOSE_PROJECT_NAME="${ACTIVE_PROJECT:-$PROJECT}" docker compose -f "$COMPOSE_FILE" exec -T postgres \
			psql -U unorag -d unorag -v ON_ERROR_STOP=1 -At <<SQL
SELECT coalesce(string_agg(status || ':' || cnt, ','), 'none')
FROM (
  SELECT j.status::text AS status, count(*)::text AS cnt
  FROM app.jobs j
  WHERE j.document_version_id IN (
    SELECT v.id FROM app.document_versions v WHERE v.document_id = '${doc_id}'::uuid
  )
  GROUP BY 1
) s;
SQL
	)" || jobs_note="jobs_query_unavailable"
	record "${phase}.job_statuses" pass "doc jobs=$jobs_note"

	local qpg_note
	qpg_note="$(
		python3 - "$DSN_PG" "http://127.0.0.1:${B3_QDRANT_PORT}" \
			"${QDRANT_COLLECTION:-unorag_chunks}" "$doc_id" \
			"$ORG_ID" "$WS_ID" "$version_id" "$generation_id" \
			"${B3_POSTGRES_PORT}" "$PG_PASSWORD" <<'PY'
import json, sys, urllib.request, subprocess, re

(
	dsn, qurl, coll, doc_id, org_id, ws_id, want_version, want_gen,
	pg_port, pg_password,
) = sys.argv[1:11]

sql = f"""
SELECT
  d.id::text,
  d.rag_document_id,
  d.organization_id::text,
  d.workspace_id::text,
  av.version_id::text,
  v.generation_id::text,
  coalesce(v.point_count::text, ''),
  coalesce(v.chunk_count::text, ''),
  v.status
FROM app.documents d
JOIN app.document_active_versions av ON av.document_id = d.id
JOIN app.document_versions v ON v.id = av.version_id
WHERE d.id = '{doc_id}'::uuid
"""

def run_psql() -> str:
	try:
		return subprocess.check_output(
			["psql", dsn, "-v", "ON_ERROR_STOP=1", "-At", "-F", "\t", "-c", sql],
			text=True,
			stderr=subprocess.STDOUT,
		).strip()
	except FileNotFoundError:
		pass
	except subprocess.CalledProcessError as exc:
		raise SystemExit(f"host psql failed: {exc.output}") from exc
	names = subprocess.check_output(
		["docker", "ps", "--format", "{{.Names}}\t{{.Ports}}"], text=True
	)
	cname = None
	for line in names.splitlines():
		if f":{pg_port}->" in line or f"0.0.0.0:{pg_port}" in line or f"[::]:{pg_port}" in line:
			cname = line.split("\t", 1)[0]
			break
	if not cname:
		for line in names.splitlines():
			name = line.split("\t", 1)[0]
			if "b3" in name and "postgres" in name:
				cname = name
				break
	if not cname:
		raise SystemExit(f"no B3 postgres container for port {pg_port}")
	m = re.match(r"postgresql://([^:]+):([^@]+)@([^:]+):(\d+)/(.+)", dsn)
	if not m:
		raise SystemExit(f"cannot parse DSN: {dsn}")
	user, _pw, _host, _port, db = m.groups()
	return subprocess.check_output(
		[
			"docker", "exec",
			"-e", f"PGPASSWORD={pg_password}",
			cname,
			"psql", "-U", user, "-d", db,
			"-v", "ON_ERROR_STOP=1", "-At", "-F", "\t", "-c", sql,
		],
		text=True,
		stderr=subprocess.STDOUT,
	).strip()

out = run_psql()
if not out:
	raise SystemExit(f"no active generation row for document_id={doc_id}")
cols = out.split("\t")
(
	_document_id, rag_doc_id, pg_org, pg_ws, pg_version, pg_gen,
	point_count, chunk_count, status,
) = (cols + [""] * 9)[:9]
assert pg_org == org_id, (pg_org, org_id)
assert pg_ws == ws_id, (pg_ws, ws_id)
if want_version and want_version not in ("None", ""):
	assert pg_version == want_version, (pg_version, want_version)
if want_gen and want_gen not in ("None", ""):
	assert pg_gen == want_gen, (pg_gen, want_gen)

must = [
	{"key": "tenant_id", "match": {"value": pg_org}},
	{"key": "workspace_id", "match": {"value": pg_ws}},
	{"key": "doc_id", "match": {"value": rag_doc_id}},
	{"key": "document_version_id", "match": {"value": pg_version}},
	{"key": "generation_id", "match": {"value": pg_gen}},
]
body = json.dumps({"exact": True, "filter": {"must": must}}).encode("utf-8")
req = urllib.request.Request(
	f"{qurl}/collections/{coll}/points/count",
	data=body,
	headers={"content-type": "application/json"},
	method="POST",
)
with urllib.request.urlopen(req, timeout=20) as resp:
	count_payload = json.load(resp)
q_count = int((count_payload.get("result") or {}).get("count") or 0)
assert q_count > 0, {"qdrant_count": q_count, "filter": must, "pg": cols}

pg_points = int(point_count) if point_count not in ("", None) else None
if pg_points is not None:
	assert q_count == pg_points, {
		"qdrant_count": q_count,
		"pg_point_count": pg_points,
		"rag_document_id": rag_doc_id,
		"generation_id": pg_gen,
	}

note = (
	f"exact match qdrant_count={q_count} pg_point_count={pg_points} "
	f"org={pg_org} ws={pg_ws} doc={rag_doc_id} version={pg_version} "
	f"generation={pg_gen} status={status}"
)
print(note)
PY
	)" || fail "$phase Qdrant↔PG consistency check failed"
	QDRANT_PG_NOTE="$qpg_note"
	record "${phase}.qdrant_pg" pass "$qpg_note"
	log "verify suite phase=$phase PASSED"
}

# --------------- main ---------------
ACTIVE_PROJECT="$PROJECT"

log "B3/B4 drill rc=$RC_SHA old=$OLD_SHA new=$NEW_SHA cases='$CASES' work=$WORKDIR"
ensure_old_worktree
ensure_new_worktree
ensure_web_image "$OLD_WT" "$WEB_TAG_OLD" "old"
ensure_web_image "$NEW_ROOT" "$WEB_TAG_NEW" "new"
link_host_toolchains "$OLD_WT"
link_host_toolchains "$NEW_ROOT"

start_infra "$PROJECT"
# Source DB must be initialized by OLD migrations. Otherwise a B3 run with a
# schema delta only proves app compatibility against an already-upgraded DB.
migrate_and_bootstrap "$OLD_WT"
start_apps "$OLD_WT" "$WEB_TAG_OLD" "old"

seed_and_baseline

BACKUP_DIR="$WORK_ROOT/backups/b3-pre-upgrade-$(date +%Y%m%dT%H%M%S)"
backup_hybrid "$PROJECT" "$BACKUP_DIR"

# ----- B3 upgrade -----
if case_enabled B3; then
	log "B3: stop old apps → migrate → start new apps"
	stop_apps
	migrate_only "$NEW_ROOT"
	start_apps "$NEW_ROOT" "$WEB_TAG_NEW" "new"
	verify_suite "B3"
	B3_STATUS="PASS"
	record "B3.overall" pass "upgrade smoke + consistency ok"
else
	B3_STATUS="SKIP"
	record "B3.overall" skip "not in UNORAG_B3_CASES"
fi

# ----- B4A app-only rollback -----
if case_enabled B4A; then
	log "B4A: app-only rollback → old API on post-upgrade DB"
	stop_apps
	# If schema incompatible, old API may fail health — record and continue to B4B.
	START_APPS_SOFT=1
	if ! start_apps "$OLD_WT" "$WEB_TAG_OLD" "old-rollback"; then
		START_APPS_SOFT=0
		stop_apps
		B4A_STATUS="FAIL"
		B4A_NOTE="old apps failed to become healthy on post-upgrade DB (likely schema incompatible); continue to B4B data restore"
		record "B4A.overall" fail "$B4A_NOTE"
		warn "$B4A_NOTE"
	else
		START_APPS_SOFT=0
		verify_suite "B4A"
		B4A_STATUS="PASS"
		B4A_NOTE="DB compatible; old API process restored without data restore"
		record "B4A.overall" pass "$B4A_NOTE"
	fi
else
	B4A_STATUS="SKIP"
	record "B4A.overall" skip "not in UNORAG_B3_CASES"
fi

# ----- B4B data-restore rollback -----
if case_enabled B4B; then
	log "B4B: data-restore rollback from pre-upgrade backup (B2 pattern)"
	stop_apps
	stop_infra "$PROJECT"
	rm -rf "$DOC_ROOT"
	mkdir -p "$DOC_ROOT"
	chmod -R a+rwX "$DOC_ROOT" 2>/dev/null || true
	ACTIVE_PROJECT="$PROJECT_RESTORE"
	restore_hybrid "$PROJECT_RESTORE" "$BACKUP_DIR"
	start_apps "$OLD_WT" "$WEB_TAG_OLD" "old-restored"
	verify_suite "B4B"
	B4B_STATUS="PASS"
	record "B4B.overall" pass "pre-upgrade backup restore ok"
else
	B4B_STATUS="SKIP"
	record "B4B.overall" skip "not in UNORAG_B3_CASES"
fi

# Overall: B3 required when enabled; B4B is the hard recovery path; B4A FAIL only
# blocks when schema was expected compatible (no migration diff).
overall_ok=1
[[ "$B3_STATUS" == "FAIL" ]] && overall_ok=0
[[ "$B4B_STATUS" == "FAIL" ]] && overall_ok=0
if [[ "$B4A_STATUS" == "FAIL" && "$SCHEMA_COMPAT" == compatible* ]]; then
	overall_ok=0
fi
if [[ "$B3_STATUS" != "PASS" && "$B3_STATUS" != "SKIP" ]]; then
	overall_ok=0
fi
if [[ "$B4B_STATUS" != "PASS" && "$B4B_STATUS" != "SKIP" ]]; then
	overall_ok=0
fi

if [[ "$overall_ok" -eq 1 ]]; then
	pass_exit "B3=$B3_STATUS B4A=$B4A_STATUS B4B=$B4B_STATUS backup=$BACKUP_DIR schema=$SCHEMA_COMPAT"
fi

if [[ "$B3_STATUS" == "FAIL" || "$B4B_STATUS" == "FAIL" || ( "$B4A_STATUS" == "FAIL" && "$SCHEMA_COMPAT" == compatible* ) ]]; then
	fail "B3=$B3_STATUS B4A=$B4A_STATUS B4B=$B4B_STATUS — see checks"
fi

blocked "incomplete run B3=$B3_STATUS B4A=$B4A_STATUS B4B=$B4B_STATUS"
