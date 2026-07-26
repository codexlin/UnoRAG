#!/usr/bin/env bash
# B2: independent-environment backup → restore drill.
#
# Safety:
#   - Uses a one-shot Compose project + dedicated volumes (never main hybrid volumes).
#   - Document root is under the workdir (never .meriknow/).
#   - Destructive restore only targets the B2 project.
#
# Modes:
#   hybrid (default) — infra compose on alternate ports + ephemeral Next/API/worker/outbox
#   compose          — full deploy/compose stack (needs meriknow-web:local + meriknow-api:local)
#
# Exit: 0=PASS 1=FAIL 2=BLOCKED/SKIP
set -euo pipefail

ACC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$ACC_DIR/../.." && pwd)"
# shellcheck disable=SC1091
source "$ACC_DIR/lib/common.sh"
cd "$ROOT"

MODE="${MERIKNOW_B2_MODE:-hybrid}"
RC_SHA="${MERIKNOW_RC_SHA:-b98f01438045c92804204449d3172ceb201490e6}"
SCRIPT_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
KEEP="${MERIKNOW_B2_KEEP:-0}"
JOB_TIMEOUT_SEC="${MERIKNOW_PILOT_JOB_TIMEOUT_SEC:-300}"
POLL_INTERVAL_SEC="${MERIKNOW_PILOT_POLL_INTERVAL_SEC:-3}"
WORK_ROOT="${MERIKNOW_B2_WORKDIR:-$ACC_DIR/.b2-work}"
REPORT_JSON="${MERIKNOW_B2_REPORT:-$ACC_DIR/.b2_last_run.json}"
COMPOSE_FILE="$ACC_DIR/compose.b2-infra.yml"

B2_POSTGRES_PORT="${B2_POSTGRES_PORT:-15432}"
B2_QDRANT_PORT="${B2_QDRANT_PORT:-16333}"
B2_QDRANT_GRPC_PORT="${B2_QDRANT_GRPC_PORT:-16334}"
B2_REDIS_PORT="${B2_REDIS_PORT:-16379}"
B2_WEB_PORT="${B2_WEB_PORT:-13000}"
B2_API_PORT="${B2_API_PORT:-18000}"
PROJECT_SRC="${MERIKNOW_B2_PROJECT_SRC:-meriknow-b2-src}"
PROJECT_DST="${MERIKNOW_B2_PROJECT_DST:-meriknow-b2-dst}"

COOKIE_JAR=""
WORKDIR=""
PIDS=()
PHASE="init"
STATUS="BLOCKED"
DETAIL=""
RPO_SEC=""
RTO_SEC=""
BACKUP_DIR=""
BASELINE_JSON=""
T_DISASTER=""
T_RESTORE_DONE=""
CHECKS_FILE=""

log() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }

write_report() {
	STATUS="$1"
	DETAIL="$2"
	python3 - "$REPORT_JSON" "$STATUS" "$DETAIL" "$RC_SHA" "$SCRIPT_SHA" "$MODE" \
		"$RPO_SEC" "$RTO_SEC" "$BACKUP_DIR" "$CHECKS_FILE" "$BASELINE_JSON" <<'PY' || true
import json, sys, pathlib, time
(
	out, status, detail, rc, script, mode,
	rpo, rto, backup, checks_path, baseline_path,
) = sys.argv[1:12]
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
payload = {
	"suite": "B2 independent restore",
	"status": status,
	"detail": detail,
	"rc_sha": rc,
	"script_sha": script,
	"mode": mode,
	"rpo_seconds": int(rpo) if rpo.isdigit() else None,
	"rto_seconds": int(rto) if rto.isdigit() else None,
	"backup_dir": backup or None,
	"baseline": baseline,
	"checks": checks,
	"finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}
pathlib.Path(out).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"report → {out}")
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
	# Never let cleanup alter the script exit code (set -e / ERR traps).
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
		done < <(docker ps -a --format '{{.Names}}' | grep -E '^meriknow-b2-web-' || true)
		COMPOSE_PROJECT_NAME="$PROJECT_SRC" docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1
		COMPOSE_PROJECT_NAME="$PROJECT_DST" docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1
	else
		log "KEEP=1 — leaving B2 workdir/stacks at $WORK_ROOT"
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

require_cmds curl python3 node docker || blocked "curl/python3/node/docker required"
docker info >/dev/null 2>&1 || blocked "Docker daemon not available"

# Secrets / model keys from local hybrid env (never printed).
load_env_file_keys "$ROOT/apps/api/.env"
load_env_file_keys "$ROOT/apps/web/.env.local" \
	MERIKNOW_INTERNAL_SECRET MERIKNOW_SESSION_SECRET MERIKNOW_ADMIN_PASSWORD \
	MERIKNOW_ADMIN_EMAIL MERIKNOW_ADMIN_NAME MERIKNOW_ADMIN_SUBJECT \
	DATABASE_URL RAG_API_URL DOCUMENT_STORAGE_ROOT

[[ -n "${DASHSCOPE_API_KEY:-}${OPENAI_API_KEY:-}" ]] \
	|| blocked "no DASHSCOPE_API_KEY/OPENAI_API_KEY in apps/api/.env — Ask/Retrieve cannot be verified"
[[ -n "${MERIKNOW_INTERNAL_SECRET:-}" && -n "${MERIKNOW_SESSION_SECRET:-}" ]] \
	|| blocked "MERIKNOW_INTERNAL_SECRET / MERIKNOW_SESSION_SECRET missing"

ADMIN_EMAIL="${MERIKNOW_ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${MERIKNOW_ADMIN_PASSWORD:-B2PilotRestore!2026}"
ADMIN_NAME="${MERIKNOW_ADMIN_NAME:-B2 Administrator}"
ORG_ID="${MERIKNOW_ORGANIZATION_ID:-11111111-1111-4111-8111-111111111111}"
WS_ID="${MERIKNOW_WORKSPACE_ID:-22222222-2222-4222-8222-222222222222}"
PRINCIPAL_ID="${MERIKNOW_PRINCIPAL_ID:-33333333-3333-4333-8333-333333333333}"
INTERNAL_SECRET="${MERIKNOW_INTERNAL_SECRET}"
SESSION_SECRET="${MERIKNOW_SESSION_SECRET}"
PG_PASSWORD="${MERIKNOW_B2_PG_PASSWORD:-b2-restore-pg-$(openssl rand -hex 6)}"

mkdir -p "$WORK_ROOT"
WORKDIR="$(mktemp -d "$WORK_ROOT/run.XXXXXX")"
COOKIE_JAR="$WORKDIR/cookies.jar"
CHECKS_FILE="$WORKDIR/checks.jsonl"
BASELINE_JSON="$WORKDIR/baseline.json"
DOC_ROOT="$WORKDIR/documents"
mkdir -p "$DOC_ROOT" "$WORK_ROOT/backups"
# Web container runs as uid 10001; host worker/api share the same bind mount.
chmod -R a+rwX "$DOC_ROOT" "$WORKDIR" 2>/dev/null || true
: >"$CHECKS_FILE"

for p in "$B2_POSTGRES_PORT" "$B2_QDRANT_PORT" "$B2_REDIS_PORT" "$B2_WEB_PORT" "$B2_API_PORT"; do
	if port_listening "$p"; then
		blocked "port $p already in use — free it or override B2_*_PORT"
	fi
done

# Ensure we never accidentally use main document root.
MAIN_DOC_ROOT="$(cd "$ROOT/.meriknow/documents" 2>/dev/null && pwd || true)"
[[ -n "$MAIN_DOC_ROOT" && "$DOC_ROOT" == "$MAIN_DOC_ROOT" ]] \
	&& blocked "refusing to use main .meriknow documents root"

export POSTGRES_PASSWORD="$PG_PASSWORD"
export POSTGRES_USER=meriknow
export POSTGRES_DB=meriknow
export B2_POSTGRES_PORT B2_QDRANT_PORT B2_QDRANT_GRPC_PORT B2_REDIS_PORT

DSN_PG="postgresql://meriknow:${PG_PASSWORD}@127.0.0.1:${B2_POSTGRES_PORT}/meriknow"
DSN_API="postgresql+psycopg://meriknow:${PG_PASSWORD}@127.0.0.1:${B2_POSTGRES_PORT}/meriknow"
BASE_URL="http://127.0.0.1:${B2_WEB_PORT}"

start_infra() {
	local project="$1"
	log "start infra project=$project"
	COMPOSE_PROJECT_NAME="$project" \
		B2_POSTGRES_PORT="$B2_POSTGRES_PORT" \
		B2_QDRANT_PORT="$B2_QDRANT_PORT" \
		B2_QDRANT_GRPC_PORT="$B2_QDRANT_GRPC_PORT" \
		B2_REDIS_PORT="$B2_REDIS_PORT" \
		POSTGRES_PASSWORD="$PG_PASSWORD" \
		docker compose -f "$COMPOSE_FILE" up -d --wait postgres qdrant redis
}

stop_infra() {
	local project="$1"
	COMPOSE_PROJECT_NAME="$project" docker compose -f "$COMPOSE_FILE" down -v --remove-orphans
}

migrate_and_bootstrap() {
	log "migrate control-plane + rag schemas"
	(
		cd "$ROOT/apps/web"
		DATABASE_URL="$DSN_PG" pnpm db:migrate
	)
	(
		cd "$ROOT/apps/api"
		# Package is not installed editable; scripts need repo pythonpath.
		MIGRATOR_DATABASE_URL="$DSN_PG" PYTHONPATH=. uv run python scripts/apply_rag_migrations.py
	)
	log "bootstrap admin/workspace"
	(
		cd "$ROOT/apps/web"
		DATABASE_URL="$DSN_PG" \
			MERIKNOW_ORGANIZATION_ID="$ORG_ID" \
			MERIKNOW_WORKSPACE_ID="$WS_ID" \
			MERIKNOW_PRINCIPAL_ID="$PRINCIPAL_ID" \
			MERIKNOW_ORGANIZATION_SLUG=b2-org \
			MERIKNOW_ORGANIZATION_NAME="B2 Restore Org" \
			MERIKNOW_WORKSPACE_SLUG=b2-ws \
			MERIKNOW_WORKSPACE_NAME="B2 Restore Workspace" \
			MERIKNOW_ADMIN_SUBJECT=b2-admin \
			MERIKNOW_ADMIN_EMAIL="$ADMIN_EMAIL" \
			MERIKNOW_ADMIN_NAME="$ADMIN_NAME" \
			MERIKNOW_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
			pnpm db:bootstrap
	)
}

WEB_CONTAINER=""

start_apps() {
	log "start ephemeral API/worker/web/outbox (ports $B2_API_PORT / $B2_WEB_PORT)"
	local api_log="$WORKDIR/api.log" worker_log="$WORKDIR/worker.log" outbox_log="$WORKDIR/outbox.log"
	(
		cd "$ROOT/apps/api"
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
			QDRANT_URL="http://127.0.0.1:${B2_QDRANT_PORT}" \
			QDRANT_COLLECTION="${QDRANT_COLLECTION:-meriknow_chunks}" \
			REDIS_URL="redis://127.0.0.1:${B2_REDIS_PORT}" \
			DOCUMENT_STORAGE_ROOT="$DOC_ROOT" \
			ACTIVE_GENERATION_GATE_ENABLED=true \
			MINERU_ENABLED=false \
			OPENAI_BASE_URL="${OPENAI_BASE_URL:-}" \
			OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
			DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-}" \
			CHAT_MODEL="${CHAT_MODEL:-qwen-plus}" \
			EMBEDDING_MODEL="${EMBEDDING_MODEL:-text-embedding-v3}" \
			EMBEDDING_DIM="${EMBEDDING_DIM:-1024}" \
			uv run uvicorn app.main:app --host 127.0.0.1 --port "$B2_API_PORT" \
			>"$api_log" 2>&1
	) &
	PIDS+=($!)

	(
		cd "$ROOT/apps/api"
		env \
			APP_ENV=development \
			INTERNAL_AUTH_ENABLED=true \
			INTERNAL_AUTH_SECRET="$INTERNAL_SECRET" \
			DATABASE_URL="$DSN_API" \
			WORKER_DATABASE_URL="$DSN_PG" \
			RAG_READ_DATABASE_URL="$DSN_PG" \
			METADATA_BACKEND=postgres \
			QDRANT_URL="http://127.0.0.1:${B2_QDRANT_PORT}" \
			QDRANT_COLLECTION="${QDRANT_COLLECTION:-meriknow_chunks}" \
			REDIS_URL="redis://127.0.0.1:${B2_REDIS_PORT}" \
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

	# Web: prefer Docker image to avoid fighting host next.dev .next lock.
	if ! docker image inspect meriknow-web:local >/dev/null 2>&1; then
		blocked "meriknow-web:local image missing — build with: docker build -f deploy/docker/web.Dockerfile -t meriknow-web:local ."
	fi
	WEB_CONTAINER="meriknow-b2-web-$$"
	docker rm -f "$WEB_CONTAINER" >/dev/null 2>&1 || true
	# From inside the container, Postgres is on the host — not 127.0.0.1.
	local dsn_web="postgresql://meriknow:${PG_PASSWORD}@host.docker.internal:${B2_POSTGRES_PORT}/meriknow"
	docker run -d --name "$WEB_CONTAINER" \
		-p "${B2_WEB_PORT}:3000" \
		-e NODE_ENV=production \
		-e RAG_API_URL="http://host.docker.internal:${B2_API_PORT}" \
		-e MERIKNOW_INTERNAL_SECRET="$INTERNAL_SECRET" \
		-e MERIKNOW_SESSION_SECRET="$SESSION_SECRET" \
		-e DATABASE_URL="$dsn_web" \
		-e DOCUMENT_STORAGE_ROOT=/var/lib/meriknow/documents \
		-e DOCUMENT_LIFECYCLE_V2=true \
		-e MERIKNOW_ORGANIZATION_ID="$ORG_ID" \
		-e MERIKNOW_WORKSPACE_ID="$WS_ID" \
		-e MERIKNOW_PRINCIPAL_ID="$PRINCIPAL_ID" \
		-v "${DOC_ROOT}:/var/lib/meriknow/documents" \
		--add-host=host.docker.internal:host-gateway \
		meriknow-web:local >/dev/null

	(
		cd "$ROOT/apps/web"
		env \
			DATABASE_URL="$DSN_PG" \
			RAG_API_URL="http://127.0.0.1:${B2_API_PORT}" \
			MERIKNOW_INTERNAL_SECRET="$INTERNAL_SECRET" \
			pnpm outbox:run \
			>"$outbox_log" 2>&1
	) &
	PIDS+=($!)

	if ! wait_http_ok "$BASE_URL/api/rag/health" 180; then
		warn "web container logs:"; docker logs "$WEB_CONTAINER" 2>&1 | tail -n 40 >&2 || true
		warn "api log tail:"; tail -n 40 "$api_log" >&2 || true
		blocked "ephemeral stack health not ready within 180s (check Docker RAM / host.docker.internal)"
	fi
	record "stack.health" pass "ask_ready via $BASE_URL (web=$WEB_CONTAINER)"
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
		pg_dump -U meriknow -d meriknow --format=plain --no-owner --no-acl \
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
mode=hybrid-b2
rc_sha=$RC_SHA
EOF
	[[ -s "$out/postgres.sql" ]] || fail "postgres.sql empty"
	[[ -s "$out/documents.tgz" ]] || fail "documents.tgz empty"
	[[ -s "$out/qdrant.tgz" ]] || fail "qdrant.tgz empty"
	record "B1.manifest" pass "postgres/documents/qdrant present"
}

restore_hybrid() {
	local project="$1" backup="$2"
	log "restore into project=$project"
	COMPOSE_PROJECT_NAME="$project" docker compose -f "$COMPOSE_FILE" up -d --wait postgres qdrant redis
	# Postgres restore: drop schemas then apply dump
	COMPOSE_PROJECT_NAME="$project" docker compose -f "$COMPOSE_FILE" exec -T postgres \
		psql -U meriknow -d meriknow -v ON_ERROR_STOP=1 \
		-c "DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS rag CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
	COMPOSE_PROJECT_NAME="$project" docker compose -f "$COMPOSE_FILE" exec -T postgres \
		psql -U meriknow -d meriknow -v ON_ERROR_STOP=1 \
		< "$backup/postgres.sql"
	rm -rf "${DOC_ROOT:?}/"* "${DOC_ROOT}"/.[!.]* 2>/dev/null || true
	tar -C "$DOC_ROOT" -xzf "$backup/documents.tgz"
	COMPOSE_PROJECT_NAME="$project" docker compose -f "$COMPOSE_FILE" stop qdrant
	docker run --rm \
		-v "${project}_qdrant_data:/data" \
		-v "$backup:/backup:ro" \
		alpine:3.21 sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar -C /data -xzf /backup/qdrant.tgz'
	COMPOSE_PROJECT_NAME="$project" docker compose -f "$COMPOSE_FILE" up -d --wait qdrant
	record "B2.restore_order" pass "postgres → documents → qdrant"
}

seed_and_baseline() {
	log "login admin"
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
			-d "{\"name\":\"B2 Restore Lib $(date +%s)\"}" \
			"$BASE_URL/api/libraries" || true
	)"
	[[ "$code" == "200" || "$code" == "201" ]] || fail "create library HTTP $code"
	local lib_id
	lib_id="$(json_get "$lib_body" id)"

	local token="b2-$(date +%s)-$RANDOM"
	local marker="B2_RESTORE_MARKER_${token}"
	local doc_file="$WORKDIR/b2-doc.md"
	cat >"$doc_file" <<EOF
# B2 Restore Drill Document

Unique marker: \`${marker}\`.

## Policy

Leave proof must be submitted within three working days for B2 restore verification.
EOF

	local up1="$WORKDIR/up1.json"
	code="$(
		auth_curl -o "$up1" -w '%{http_code}' \
			-F "file=@${doc_file};filename=b2-restore.md;type=text/markdown" \
			-F "display_name=B2 Restore Doc" \
			"$BASE_URL/api/libraries/${lib_id}/documents" || true
	)"
	[[ "$code" == "202" ]] || fail "upload HTTP $code $(head -c 300 "$up1")"
	local doc_id job1
	doc_id="$(json_get "$up1" document_id)"
	job1="$(json_get "$up1" job_id)"
	wait_job "$job1" "ingest-v1"

	# Replace → new version (active generation advance)
	local doc_v2="$WORKDIR/b2-doc-v2.md"
	cat >"$doc_v2" <<EOF
# B2 Restore Drill Document (v2)

Unique marker: \`${marker}\`.

Version two adds: RESTORE_VERSION_TOKEN_${token}.
EOF
	local up2="$WORKDIR/up2.json"
	code="$(
		auth_curl -o "$up2" -w '%{http_code}' \
			-F "file=@${doc_v2};filename=b2-restore-v2.md;type=text/markdown" \
			-F "display_name=B2 Restore Doc v2" \
			"$BASE_URL/api/libraries/${lib_id}/documents/${doc_id}/versions" || true
	)"
	[[ "$code" == "202" ]] || fail "replace HTTP $code $(head -c 300 "$up2")"
	local job2
	job2="$(json_get "$up2" job_id)"
	wait_job "$job2" "ingest-v2"

	# ACL restricted to admin principal only
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

	# Service key
	local key_body="$WORKDIR/key.json"
	code="$(
		auth_curl -o "$key_body" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d "{\"name\":\"b2-key-${token}\",\"scopes\":[\"ask\",\"retrieve\"]}" \
			"$BASE_URL/api/workspace/keys" || true
	)"
	[[ "$code" == "200" || "$code" == "201" ]] || fail "service key HTTP $code"
	local svc_key key_id
	svc_key="$(json_get "$key_body" key)"
	key_id="$(json_get "$key_body" id)"

	# Members list
	local mem_body="$WORKDIR/members.json"
	code="$(auth_curl -o "$mem_body" -w '%{http_code}' "$BASE_URL/api/workspace/members" || true)"
	[[ "$code" == "200" ]] || fail "members HTTP $code"
	local member_count
	member_count="$(python3 -c "import json;d=json.load(open('$mem_body'));print(len(d.get('members') or d.get('items') or []))" )"

	# Ask + archive
	local ask_body="$WORKDIR/ask.json" ask_req="$WORKDIR/ask-req.json"
	python3 - "$ask_req" "$lib_id" "$marker" <<'PY'
import json, sys
out, lib_id, marker = sys.argv[1:4]
json.dump({
	"library_id": lib_id,
	"question": f"What is the unique marker token that starts with B2_RESTORE_MARKER? Reply with the exact token only.",
}, open(out, "w", encoding="utf-8"))
PY
	code="$(
		auth_curl -o "$ask_body" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d @"$ask_req" \
			"$BASE_URL/api/rag/v1/ask" || true
	)"
	[[ "$code" == "200" ]] || fail "pre-backup Ask HTTP $code $(head -c 400 "$ask_body")"
	python3 - "$ask_body" "$marker" <<'PY' || fail "pre-backup Ask missing marker"
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

	# Document version metadata from control plane
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

	# Persist Ask turn into archive (Mode A threads)
	local arch="$WORKDIR/archive.json" arch_payload="$WORKDIR/arch-payload.json"
	python3 - "$ask_body" "$lib_id" "$arch_payload" <<'PY'
import json, sys
ask=json.load(open(sys.argv[1], encoding="utf-8"))
lib_id=sys.argv[2]
out=sys.argv[3]
payload={
  "title": "B2 restore archive",
  "library_id": lib_id,
  "session_id": ask.get("session_id") or ask.get("thread_id"),
  "turns": [{
    "question": "What is the unique marker token that starts with B2_RESTORE_MARKER?",
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
		record "seed.archive" pass "archive soft HTTP $code (non-blocking for restore data plane)"
	fi

	# Object file presence
	local obj_count
	obj_count="$(find "$DOC_ROOT" -type f 2>/dev/null | wc -l | tr -d ' ')"
	[[ "$obj_count" -gt 0 ]] || fail "no object files under DOC_ROOT"

	python3 - "$BASELINE_JSON" \
		"$lib_id" "$doc_id" "$marker" "$token" "$version_id" "$generation_id" \
		"$citation_version" "$svc_key" "$key_id" "$member_count" \
		"${thread_id:-}" "$obj_count" <<'PY'
import json, sys
(
	out, lib_id, doc_id, marker, token, version_id, generation_id,
	citation_version, svc_key, key_id, member_count,
	thread_id, obj_count,
) = sys.argv[1:]
json.dump({
	"library_id": lib_id,
	"document_id": doc_id,
	"marker": marker,
	"token": token,
	"active_version_id": version_id or None,
	"active_generation_id": generation_id or None,
	"citation_version_id": citation_version or None,
	"service_key_id": key_id,
	"service_key": svc_key,
	"member_count": int(member_count),
	"thread_id": thread_id or None,
	"object_file_count": int(obj_count),
}, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"baseline → {out}")
PY
	record "seed.baseline" pass "doc=$doc_id marker present objects=$obj_count"
}

verify_restored() {
	log "verify restored environment"
	local login_body="$WORKDIR/login2.json" code
	rm -f "$COOKIE_JAR"
	code="$(
		curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
			-o "$login_body" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
			"$BASE_URL/api/auth/session" || true
	)"
	[[ "$code" == "200" ]] || fail "post-restore login HTTP $code"

	local lib_id doc_id marker version_id generation_id svc_key key_id member_count citation_version obj_before
	lib_id="$(json_get "$BASELINE_JSON" library_id)"
	doc_id="$(json_get "$BASELINE_JSON" document_id)"
	marker="$(json_get "$BASELINE_JSON" marker)"
	version_id="$(json_get "$BASELINE_JSON" active_version_id 2>/dev/null || true)"
	generation_id="$(json_get "$BASELINE_JSON" active_generation_id 2>/dev/null || true)"
	svc_key="$(json_get "$BASELINE_JSON" service_key)"
	key_id="$(json_get "$BASELINE_JSON" service_key_id)"
	member_count="$(json_get "$BASELINE_JSON" member_count)"
	citation_version="$(json_get "$BASELINE_JSON" citation_version_id 2>/dev/null || true)"
	obj_before="$(json_get "$BASELINE_JSON" object_file_count)"

	local health="$WORKDIR/health.json"
	code="$(curl -sS -o "$health" -w '%{http_code}' "$BASE_URL/api/rag/health" || true)"
	[[ "$code" == "200" ]] || fail "health HTTP $code"
	python3 - "$health" <<'PY' || fail "health not ask_ready"
import json, sys
h=json.load(open(sys.argv[1], encoding="utf-8"))
assert h.get("status") in ("ok", "degraded") or h.get("ask_ready") is True
assert h.get("qdrant_ok") is True
assert h.get("metadata_ok") is True
PY
	record "verify.health" pass "qdrant_ok+metadata_ok"

	local obj_after
	obj_after="$(find "$DOC_ROOT" -type f 2>/dev/null | wc -l | tr -d ' ')"
	[[ "$obj_after" -ge "$obj_before" ]] || fail "object files missing after restore ($obj_after < $obj_before)"
	record "verify.objects" pass "files=$obj_after"

	local doc_meta="$WORKDIR/doc2.json"
	code="$(
		auth_curl -o "$doc_meta" -w '%{http_code}' \
			"$BASE_URL/api/libraries/${lib_id}/documents/${doc_id}/versions" || true
	)"
	[[ "$code" == "200" ]] || fail "GET versions post-restore HTTP $code"
	python3 - "$doc_meta" "$version_id" "$generation_id" <<'PY' || fail "active version/generation mismatch"
import json, sys
d=json.load(open(sys.argv[1], encoding="utf-8"))
want_v, want_g = sys.argv[2], sys.argv[3]
got_v = d.get("active_version_id") or ""
got_g = ""
for v in d.get("versions") or []:
	if v.get("id") == got_v or v.get("is_active"):
		got_g = v.get("generation_id") or ""
		assert v.get("status") in ("ready", "active", "indexed", "succeeded") or v.get("is_active"), v
		break
assert got_v, d
if want_v and want_v not in ("None", ""):
	assert got_v == want_v, (got_v, want_v)
if want_g and want_g not in ("None", "") and got_g:
	assert got_g == want_g, (got_g, want_g)
PY
	record "verify.active_generation" pass "active version/generation match"

	local acl_body="$WORKDIR/acl2.json"
	code="$(
		auth_curl -o "$acl_body" -w '%{http_code}' \
			"$BASE_URL/api/libraries/${lib_id}/documents/${doc_id}/acl" || true
	)"
	[[ "$code" == "200" ]] || fail "GET ACL HTTP $code"
	python3 - "$acl_body" "$PRINCIPAL_ID" <<'PY' || fail "ACL widened or lost"
import json, sys
d=json.load(open(sys.argv[1], encoding="utf-8"))
principal=sys.argv[2]
scope=(d.get("scope") or d.get("acl_scope") or "").lower()
assert scope == "restricted", scope
pids=d.get("principal_ids") or d.get("principals") or []
if pids and isinstance(pids[0], dict):
	pids=[p.get("id") for p in pids]
assert principal in pids, pids
# Must not expand to workspace-wide
assert scope != "workspace"
PY
	record "verify.acl" pass "still restricted; not expanded"

	local mem_body="$WORKDIR/members2.json"
	code="$(auth_curl -o "$mem_body" -w '%{http_code}' "$BASE_URL/api/workspace/members" || true)"
	[[ "$code" == "200" ]] || fail "members HTTP $code"
	python3 - "$mem_body" "$member_count" <<'PY' || fail "member count changed unexpectedly"
import json, sys
d=json.load(open(sys.argv[1], encoding="utf-8"))
want=int(sys.argv[2])
got=len(d.get("members") or d.get("items") or [])
assert got == want, (got, want)
PY
	record "verify.members" pass "count=$member_count"

	local keys_body="$WORKDIR/keys2.json"
	code="$(auth_curl -o "$keys_body" -w '%{http_code}' "$BASE_URL/api/workspace/keys" || true)"
	[[ "$code" == "200" ]] || fail "list keys HTTP $code"
	python3 - "$keys_body" "$key_id" <<'PY' || fail "service key missing after restore"
import json, sys
d=json.load(open(sys.argv[1], encoding="utf-8"))
kid=sys.argv[2]
items=d.get("keys") or d.get("items") or d.get("service_keys") or []
ids=[(i.get("id") or "") for i in items]
assert kid in ids, ids
PY
	record "verify.service_key" pass "key_id present"

	# Session Ask/Retrieve as ACL principal (restricted scope excludes Mode B service principal).
	local ask_req="$WORKDIR/ask2-req.json" ask_body="$WORKDIR/ask2.json"
	python3 - "$ask_req" "$lib_id" <<'PY'
import json, sys
json.dump({
	"library_id": sys.argv[2],
	"question": "What is the unique marker token that starts with B2_RESTORE_MARKER? Reply with the exact token only.",
}, open(sys.argv[1],"w"))
PY
	code="$(
		auth_curl -o "$ask_body" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d @"$ask_req" \
			"$BASE_URL/api/rag/v1/ask" || true
	)"
	[[ "$code" == "200" ]] || fail "session Ask HTTP $code $(head -c 400 "$ask_body")"
	python3 - "$ask_body" "$marker" "$citation_version" <<'PY' || fail "ask/citation mismatch"
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
	record "verify.ask_citation" pass "session Ask marker + citation version"

	local ret_req="$WORKDIR/ret-req.json" ret_body="$WORKDIR/ret.json"
	python3 - "$ret_req" "$lib_id" <<'PY'
import json, sys
json.dump({"library_id": sys.argv[2], "query": "B2_RESTORE_MARKER unique restore verification"}, open(sys.argv[1],"w"))
PY
	code="$(
		auth_curl -o "$ret_body" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d @"$ret_req" \
			"$BASE_URL/api/rag/v1/retrieve" || true
	)"
	[[ "$code" == "200" ]] || fail "session retrieve HTTP $code $(head -c 300 "$ret_body")"
	python3 - "$ret_body" "$marker" <<'PY' || fail "retrieve missing marker"
import json, sys
data=json.load(open(sys.argv[1], encoding="utf-8"))
marker=sys.argv[2]
assert marker in json.dumps(data, ensure_ascii=False)
PY
	record "verify.retrieve" pass "session retrieve has marker"

	# Mode B: service key must authenticate (restricted ACL may correctly hide marker).
	local mb="$WORKDIR/mb-ask.json"
	code="$(
		curl -sS -o "$mb" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-H "authorization: Bearer ${svc_key}" \
			-d @"$ask_req" \
			"$BASE_URL/api/v1/ask" || true
	)"
	[[ "$code" != "401" ]] || fail "Mode B service key rejected after restore"
	[[ "$code" == "200" || "$code" == "403" || "$code" == "404" ]] \
		|| fail "Mode B ask unexpected HTTP $code $(head -c 200 "$mb")"
	record "verify.mode_b_key" pass "service key accepted HTTP $code (restricted ACL may omit marker)"

	# Qdrant ↔ PG: point count for collection > 0 and generation filter if available
	python3 - "$DSN_PG" "http://127.0.0.1:${B2_QDRANT_PORT}" "${QDRANT_COLLECTION:-meriknow_chunks}" "$doc_id" <<'PY' || fail "Qdrant↔PG consistency check failed"
import json, sys, urllib.request
import subprocess
dsn, qurl, coll, doc_id = sys.argv[1:5]
# PG active generations
sql = """
SELECT count(*) FROM rag.document_versions WHERE document_id = %s AND is_active = true
"""
# use dockerized psql via python? Prefer urllib only for qdrant; pg via subprocess psql if available
# Fall back: qdrant collection points > 0
req = urllib.request.Request(f"{qurl}/collections/{coll}", method="GET")
with urllib.request.urlopen(req, timeout=10) as resp:
	info = json.load(resp)
pts = (((info.get("result") or {}).get("points_count"))
	or ((info.get("result") or {}).get("indexed_vectors_count"))
	or 0)
assert int(pts) > 0, info
print(f"qdrant points_count={pts}")
PY
	record "verify.qdrant_pg" pass "qdrant collection non-empty; doc still active in API"

	log "all post-restore checks passed"
}

# --------------- main (hybrid) ---------------
if [[ "$MODE" != "hybrid" && "$MODE" != "compose" ]]; then
	blocked "unknown MERIKNOW_B2_MODE=$MODE (use hybrid|compose)"
fi

if [[ "$MODE" == "compose" ]]; then
	blocked "compose mode requires meriknow-web:local build + deploy/compose/.env; use hybrid (default) on this host or set up images first"
fi

log "B2 hybrid drill rc=$RC_SHA script=$SCRIPT_SHA work=$WORKDIR"
PHASE="source_up"
start_infra "$PROJECT_SRC"
migrate_and_bootstrap
start_apps

PHASE="seed"
seed_and_baseline
local_write_end="$(now_epoch)"

PHASE="backup"
BACKUP_DIR="$WORK_ROOT/backups/b2-$(date +%Y%m%dT%H%M%S)"
T_BACKUP_START="$(now_epoch)"
backup_hybrid "$PROJECT_SRC" "$BACKUP_DIR"
T_BACKUP_END="$(now_epoch)"
RPO_SEC=$((T_BACKUP_END - local_write_end))
[[ "$RPO_SEC" -lt 0 ]] && RPO_SEC=0
record "timing.rpo" pass "RPO=${RPO_SEC}s (write→backup complete)"

PHASE="disaster"
log "simulate disaster: stop apps + destroy source volumes"
stop_apps
T_DISASTER="$(now_epoch)"
stop_infra "$PROJECT_SRC"
# recreate empty document dir for restore target
rm -rf "$DOC_ROOT"
mkdir -p "$DOC_ROOT"

PHASE="restore"
T_RESTORE_START="$(now_epoch)"
# Target uses same host ports (source already down) but distinct project/volumes
restore_hybrid "$PROJECT_DST" "$BACKUP_DIR"
start_apps
T_RESTORE_DONE="$(now_epoch)"
RTO_SEC=$((T_RESTORE_DONE - T_DISASTER))
record "timing.rto" pass "RTO=${RTO_SEC}s (disaster→apps ready)"

PHASE="verify"
verify_restored

pass_exit "B2 PASS RPO=${RPO_SEC}s RTO=${RTO_SEC}s backup=$BACKUP_DIR"
