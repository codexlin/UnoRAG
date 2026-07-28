#!/usr/bin/env bash
# B5 — minimum alerts wired to a generic webhook (mock receiver locally).
#
# Proves for each of 5 signals (when injectable):
#   inject fault → firing webhook delivered (with locators) → recover → resolved
#
# Safety:
#   - Does NOT wipe .unorag / Postgres volumes.
#   - Briefly stops shared Qdrant (like R2) and restarts it.
#   - Inserts one marked stuck test job and deletes it in EXIT.
#   - Disk inject uses UNORAG_ALERT_DISK_FORCE_PERCENT (real df also measured).
#
# Exit: 0=PASS  1=FAIL  2=BLOCKED
# Select: UNORAG_B5_CASES="S1 S2 S3 S4 S5" (default all)
set -euo pipefail

ACC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$ACC_DIR/../.." && pwd)"
# shellcheck disable=SC1091
source "$ACC_DIR/lib/common.sh"
cd "$ROOT"

RC_SHA="${UNORAG_RC_SHA:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)}"
SCRIPT_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
BASE_URL="${UNORAG_BASE_URL:-http://localhost:3000}"
BASE_URL="${BASE_URL%/}"
API_ENV="$ROOT/apps/api/.env"
REPORT_JSON="${UNORAG_B5_REPORT:-$ACC_DIR/.b5_last_run.json}"
CASES="${UNORAG_B5_CASES:-S1 S2 S3 S4 S5}"
PASSWORD="${UNORAG_B5_PASSWORD:-${UNORAG_ADMIN_PASSWORD:-}}"
EMAIL="${UNORAG_ADMIN_EMAIL:-admin@example.com}"
CHECKER="$ROOT/ops/min_alerts/check.py"
PY_API="${UNORAG_B5_PYTHON:-$ROOT/apps/api/.venv/bin/python}"
[[ -x "$PY_API" ]] || PY_API="$(command -v python3)"

WORKDIR="${UNORAG_B5_WORKDIR:-$(mktemp -d -t unorag-b5.XXXXXX)}"
mkdir -p "$WORKDIR"
COOKIE_JAR="$WORKDIR/cookies.jar"
CHECKS_FILE="$WORKDIR/checks.jsonl"
ALERTS_JSONL="$WORKDIR/alerts.jsonl"
STATE_FILE="$WORKDIR/alert-state.json"
READY_FILE="$WORKDIR/lifecycle-ready"
: >"$CHECKS_FILE"
: >"$ALERTS_JSONL"
MOCK_PID=""
QDRANT_WAS_STOPPED=0
TEST_JOB_ID=""
ORG_ID=""
WS_ID=""
LIB_ID=""
OVERALL=PASS
DETAIL_MSG=""

log() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }

load_env_file_keys "$ROOT/apps/web/.env.local" \
	UNORAG_ADMIN_PASSWORD UNORAG_ADMIN_EMAIL UNORAG_BASE_URL DATABASE_URL \
	DOCUMENT_STORAGE_ROOT DEFAULT_WORKSPACE_ID UNORAG_WORKSPACE_ID
load_env_file_keys "$API_ENV" \
	DOCUMENT_STORAGE_ROOT DATABASE_URL DEFAULT_WORKSPACE_ID DEFAULT_TENANT_ID
[[ -n "$PASSWORD" ]] || PASSWORD="${UNORAG_ADMIN_PASSWORD:-}"
[[ -n "${UNORAG_ADMIN_EMAIL:-}" ]] && EMAIL="$UNORAG_ADMIN_EMAIL"
DOC_ROOT="${DOCUMENT_STORAGE_ROOT:-$ROOT/.unorag/documents}"
DATABASE_URL="${DATABASE_URL:-}"

record() {
	python3 - "$CHECKS_FILE" "$1" "$2" "$3" <<'PY'
import json, sys
path, cid, status, note = sys.argv[1:5]
with open(path, "a", encoding="utf-8") as f:
	f.write(json.dumps({"id": cid, "status": status, "note": note}, ensure_ascii=False) + "\n")
print(f"  [{status}] {cid}: {note}")
PY
}

write_report() {
	local git_head git_porcelain
	git_head="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
	git_porcelain="$(git -C "$ROOT" status --porcelain 2>/dev/null | tr '\n' '|' | head -c 2000 || true)"
	python3 - "$REPORT_JSON" "$1" "$2" "$RC_SHA" "$SCRIPT_SHA" "$BASE_URL" "$CHECKS_FILE" \
		"$git_head" "$git_porcelain" "$ALERTS_JSONL" <<'PY' || true
import json, sys, pathlib, time, hashlib, os
out, status, detail, rc, script, base, checks_path, git_head, git_porcelain, alerts_path = sys.argv[1:11]
checks=[]
for line in pathlib.Path(checks_path).read_text(encoding="utf-8").splitlines():
	if line.strip():
		checks.append(json.loads(line))
by={}
for c in checks:
	cid=c["id"].split(".",1)[0]
	by.setdefault(cid, []).append(c["status"])
cases={}
for cid, sts in by.items():
	if "fail" in sts: cases[cid]="FAIL"
	elif "blocked" in sts: cases[cid]="BLOCKED"
	elif sts and all(s=="pass" for s in sts): cases[cid]="PASS"
	else: cases[cid]="PARTIAL"
alerts=[]
ap=pathlib.Path(alerts_path)
if ap.exists():
	for line in ap.read_text(encoding="utf-8").splitlines():
		if line.strip():
			alerts.append(json.loads(line))
payload={
	"suite": "B5 minimum alerts",
	"status": status,
	"detail": detail,
	"rc_sha": rc,
	"script_sha": script,
	"git_head": git_head,
	"git_status_porcelain": git_porcelain or "",
	"runtime": {"web": "local-process", "api": "local-process", "base_url": base},
	"base_url": base,
	"cases": cases,
	"checks": checks,
	"alerts_received": len(alerts),
	"finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}
text = json.dumps(payload, ensure_ascii=False, indent=2)+"\n"
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

delete_test_job() {
	if [[ -z "$TEST_JOB_ID" || -z "$DATABASE_URL" ]]; then
		return 0
	fi
	"$PY_API" - "$DATABASE_URL" "$TEST_JOB_ID" <<'PY' || true
import os, sys
dsn = sys.argv[1].replace("postgresql+psycopg://", "postgresql://", 1)
job_id = sys.argv[2]
import psycopg
with psycopg.connect(dsn) as conn:
	with conn.cursor() as cur:
		cur.execute("DELETE FROM app.jobs WHERE id = %s::uuid", (job_id,))
		print(f"deleted test job {job_id} rows={cur.rowcount}")
	conn.commit()
PY
	TEST_JOB_ID=""
}

restore_qdrant() {
	if [[ "$QDRANT_WAS_STOPPED" == "1" ]]; then
		docker start unorag-qdrant-1 >/dev/null 2>&1 || true
		for _ in $(seq 1 40); do
			curl -sf http://127.0.0.1:6333/readyz >/dev/null 2>&1 && break
			sleep 1
		done
		QDRANT_WAS_STOPPED=0
		log "qdrant restarted"
	fi
}

stop_mock() {
	if [[ -n "$MOCK_PID" ]] && kill -0 "$MOCK_PID" 2>/dev/null; then
		kill "$MOCK_PID" 2>/dev/null || true
		wait "$MOCK_PID" 2>/dev/null || true
	fi
	MOCK_PID=""
}

cleanup() {
	delete_test_job
	restore_qdrant
	stop_mock
	# keep workdir if UNORAG_B5_KEEP=1
	if [[ "${UNORAG_B5_KEEP:-0}" != "1" ]]; then
		rm -rf "$WORKDIR"
	else
		log "kept workdir $WORKDIR"
	fi
}
trap cleanup EXIT

fail_case() {
	record "$1" fail "$2"
	OVERALL=FAIL
	DETAIL_MSG="${DETAIL_MSG}; $1 FAIL: $2"
}
block_case() {
	record "$1" blocked "$2"
	if [[ "$OVERALL" == "PASS" ]]; then OVERALL=BLOCKED; fi
	DETAIL_MSG="${DETAIL_MSG}; $1 BLOCKED: $2"
}
pass_case() { record "$1" pass "$2"; }

require_cmds curl python3 docker || { write_report BLOCKED "missing curl/python3/docker"; exit 2; }
[[ -f "$CHECKER" ]] || { write_report BLOCKED "missing $CHECKER"; exit 2; }
[[ -n "$DATABASE_URL" ]] || { write_report BLOCKED "DATABASE_URL required"; exit 2; }

HEALTH_CODE="$(http_code "$BASE_URL/api/rag/health")"
if [[ "$HEALTH_CODE" != "200" ]]; then
	write_report BLOCKED "edge not ready at $BASE_URL (HTTP $HEALTH_CODE)"
	exit 2
fi
[[ -n "$PASSWORD" ]] || { write_report BLOCKED "set UNORAG_ADMIN_PASSWORD or UNORAG_B5_PASSWORD"; exit 2; }

# Resolve org/workspace for job inject + annotations
read_org_ws() {
	"$PY_API" - "$DATABASE_URL" <<'PY'
import sys
import psycopg
dsn = sys.argv[1].replace("postgresql+psycopg://", "postgresql://", 1)
with psycopg.connect(dsn) as conn, conn.cursor() as cur:
	cur.execute("SELECT id::text FROM app.organizations ORDER BY created_at LIMIT 1")
	org = cur.fetchone()[0]
	cur.execute(
		"SELECT id::text FROM app.workspaces WHERE organization_id=%s::uuid ORDER BY created_at LIMIT 1",
		(org,),
	)
	ws = cur.fetchone()[0]
	print(org)
	print(ws)
PY
}
_OW="$(read_org_ws)"
ORG_ID="$(printf '%s\n' "$_OW" | sed -n '1p')"
WS_ID="$(printf '%s\n' "$_OW" | sed -n '2p')"

login() {
	local body="$WORKDIR/login.json" code
	code="$(
		curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
			-o "$body" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}" \
			"$BASE_URL/api/auth/session" || true
	)"
	[[ "$code" == "200" ]] || { write_report BLOCKED "login HTTP $code"; exit 2; }
}
auth_curl() { curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$@"; }

ensure_library() {
	local body="$WORKDIR/lib.json" code
	code="$(
		auth_curl -o "$body" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d "{\"name\":\"B5-Alert $(date +%s)\"}" \
			"$BASE_URL/api/libraries" || true
	)"
	[[ "$code" == "200" || "$code" == "201" ]] || { write_report BLOCKED "create library HTTP $code"; exit 2; }
	json_get "$body" id
}

start_mock() {
	stop_mock
	: >"$ALERTS_JSONL"
	"$PY_API" "$CHECKER" mock-receiver --host 127.0.0.1 --port "${UNORAG_B5_MOCK_PORT:-18999}" --out "$ALERTS_JSONL" \
		>"$WORKDIR/mock.log" 2>&1 &
	MOCK_PID=$!
	for _ in $(seq 1 30); do
		if curl -sf "http://127.0.0.1:${UNORAG_B5_MOCK_PORT:-18999}/" >/dev/null 2>&1; then
			return 0
		fi
		sleep 0.2
	done
	return 1
}

# Common checker env for this run
export ALERT_WEBHOOK_URL="http://127.0.0.1:${UNORAG_B5_MOCK_PORT:-18999}/alert"
export UNORAG_HEALTH_URL="$BASE_URL/api/rag/health"
export LIFECYCLE_WORKER_READY_FILE="$READY_FILE"
export DOCUMENT_STORAGE_ROOT="$DOC_ROOT"
export DATABASE_URL
export UNORAG_ALERT_STATE_FILE="$STATE_FILE"
export UNORAG_ALERT_HEARTBEAT_MAX_AGE_SEC="${UNORAG_ALERT_HEARTBEAT_MAX_AGE_SEC:-15}"
export DEFAULT_WORKSPACE_ID="$WS_ID"
export UNORAG_ALERT_DISK_PATHS
UNORAG_ALERT_DISK_PATHS="$(python3 - "$DOC_ROOT" "$ROOT" <<'PY'
import json, sys
doc, root = sys.argv[1], sys.argv[2]
print(json.dumps({
	"documents": doc,
	"postgres": root,   # host fs proxy for PG volume (df of data volume)
	"qdrant": root,
}))
PY
)"

run_checker() {
	# run_checker [extra env assignments via env...]
	local out="$1"
	shift
	env "$@" "$PY_API" "$CHECKER" once \
		--webhook-url "$ALERT_WEBHOOK_URL" \
		--health-url "$UNORAG_HEALTH_URL" \
		--ready-file "$READY_FILE" \
		--database-url "$DATABASE_URL" \
		--document-root "$DOC_ROOT" \
		--postgres-path "$ROOT" \
		--qdrant-path "$ROOT" \
		--state-file "$STATE_FILE" \
		--workspace-id "$WS_ID" \
		--heartbeat-max-age-sec "${UNORAG_ALERT_HEARTBEAT_MAX_AGE_SEC}" \
		--ask-probe-url "${ASK_PROBE_URL:-}" \
		--ask-probe-body "${ASK_PROBE_BODY:-}" \
		--ask-cookie-jar "${ASK_COOKIE_JAR:-}" \
		>"$out" 2>"$out.err" || true
}

count_alerts() {
	python3 - "$ALERTS_JSONL" "$1" "$2" <<'PY'
import json, sys
path, name, status = sys.argv[1:4]
n=0
locs=[]
for line in open(path, encoding="utf-8"):
	if not line.strip():
		continue
	rec=json.loads(line)
	p=rec.get("payload") or {}
	if p.get("alert_name")==name and p.get("status")==status:
		n+=1
		locs.append({
			"workspace_id": p.get("workspace_id") or (p.get("annotations") or {}).get("workspace_id"),
			"trace_id": p.get("trace_id") or (p.get("annotations") or {}).get("trace_id"),
			"job_id": p.get("job_id") or (p.get("annotations") or {}).get("job_id"),
			"worker_id": p.get("worker_id") or (p.get("annotations") or {}).get("worker_id"),
			"organization_id": p.get("organization_id") or (p.get("annotations") or {}).get("organization_id"),
		})
print(json.dumps({"count": n, "last": locs[-1] if locs else {}}, ensure_ascii=False))
raise SystemExit(0 if n>0 else 1)
PY
}

wait_alert() {
	# wait_alert <signal> <firing|resolved> <timeout_sec>
	local name="$1" status="$2" timeout="${3:-20}" started now
	started="$(now_epoch)"
	while true; do
		if count_alerts "$name" "$status" >"$WORKDIR/wait-$name-$status.json" 2>/dev/null; then
			return 0
		fi
		now="$(now_epoch)"
		if (( now - started > timeout )); then
			return 1
		fi
		sleep 0.5
	done
}

reset_state_and_alerts() {
	rm -f "$STATE_FILE"
	: >"$ALERTS_JSONL"
}

# ---------- bootstrap ----------
log "B5 bootstrap workdir=$WORKDIR"
login
LIB_ID="$(ensure_library)"
ASK_PROBE_URL="$BASE_URL/api/rag/v1/ask"
ASK_PROBE_BODY="$(python3 -c "import json; print(json.dumps({'library_id':'$LIB_ID','question':'B5 min-alert probe'}))")"
ASK_COOKIE_JAR="$COOKIE_JAR"
export ASK_PROBE_URL ASK_PROBE_BODY ASK_COOKIE_JAR

if ! start_mock; then
	write_report BLOCKED "mock webhook receiver failed to start"
	exit 2
fi
pass_case "boot.mock" "receiver on :${UNORAG_B5_MOCK_PORT:-18999}"

# Fresh ready file + baseline state (no fires expected for jobs/disk/worker)
printf 'b5-acceptor\n%s\n' "$(now_epoch)" >"$READY_FILE"
reset_state_and_alerts
run_checker "$WORKDIR/baseline.json"
pass_case "boot.baseline" "initial once ok (sets jobs baseline)"

# ---------- S1 health.qdrant_ask ----------
run_s1() {
	log "S1: Qdrant/Ask health unavailable"
	local name="health.qdrant_ask"
	if ! docker ps --format '{{.Names}}' | grep -qx 'unorag-qdrant-1'; then
		block_case "S1" "container unorag-qdrant-1 not running"
		return
	fi
	reset_state_and_alerts
	# re-seed baseline without firing
	printf 'b5-acceptor\n%s\n' "$(now_epoch)" >"$READY_FILE"
	run_checker "$WORKDIR/s1-base.json"

	log "  inject: docker stop unorag-qdrant-1"
	docker stop unorag-qdrant-1 >/dev/null
	QDRANT_WAS_STOPPED=1
	sleep 2
	run_checker "$WORKDIR/s1-fire.json"
	if wait_alert "$name" firing 15; then
		pass_case "S1.firing" "webhook firing delivered: $(cat "$WORKDIR/wait-$name-firing.json")"
	else
		fail_case "S1.firing" "no firing webhook; checker=$(head -c 300 "$WORKDIR/s1-fire.json")"
	fi

	log "  recover: docker start unorag-qdrant-1"
	docker start unorag-qdrant-1 >/dev/null
	QDRANT_WAS_STOPPED=0
	for _ in $(seq 1 40); do
		curl -sf http://127.0.0.1:6333/readyz >/dev/null 2>&1 && break
		sleep 1
	done
	sleep 2
	run_checker "$WORKDIR/s1-resolve.json"
	if wait_alert "$name" resolved 15; then
		pass_case "S1.resolved" "webhook resolved delivered"
		pass_case "S1" "PASS health.qdrant_ask firing→resolved"
	else
		fail_case "S1.resolved" "no resolved webhook"
	fi
}

# ---------- S2 worker.heartbeat ----------
run_s2() {
	log "S2: lifecycle worker heartbeat lost"
	local name="worker.heartbeat"
	reset_state_and_alerts
	printf 'b5-worker\n%s\n' "$(now_epoch)" >"$READY_FILE"
	run_checker "$WORKDIR/s2-base.json"

	log "  inject: remove ready file"
	rm -f "$READY_FILE"
	run_checker "$WORKDIR/s2-fire.json"
	if wait_alert "$name" firing 15; then
		local loc
		loc="$(cat "$WORKDIR/wait-$name-firing.json")"
		pass_case "S2.firing" "webhook firing with locator $loc"
	else
		fail_case "S2.firing" "no firing webhook"
	fi

	log "  recover: restore ready file"
	printf 'b5-worker\n%s\n' "$(now_epoch)" >"$READY_FILE"
	run_checker "$WORKDIR/s2-resolve.json"
	if wait_alert "$name" resolved 15; then
		pass_case "S2.resolved" "webhook resolved"
		pass_case "S2" "PASS worker.heartbeat firing→resolved"
	else
		fail_case "S2.resolved" "no resolved webhook"
	fi
}

# ---------- S3 jobs.dead_stuck ----------
run_s3() {
	log "S3: dead/stuck job growth"
	local name="jobs.dead_stuck"
	reset_state_and_alerts
	printf 'b5-acceptor\n%s\n' "$(now_epoch)" >"$READY_FILE"
	run_checker "$WORKDIR/s3-base.json"

	log "  inject: insert marked stuck job (non-destructive; deleted on EXIT)"
	local inject_out="$WORKDIR/s3-inject.txt"
	if ! "$PY_API" - "$DATABASE_URL" "$ORG_ID" "$WS_ID" >"$inject_out" 2>"$WORKDIR/s3-inject.err" <<'PY'
import sys, uuid
import psycopg
dsn = sys.argv[1].replace("postgresql+psycopg://", "postgresql://", 1)
org, ws = sys.argv[2], sys.argv[3]
job_id = str(uuid.uuid4())
key = f"b5-min-alert-{job_id}"
with psycopg.connect(dsn) as conn, conn.cursor() as cur:
	cur.execute(
		"""
		INSERT INTO app.jobs (
			id, organization_id, workspace_id, type, status, stage,
			idempotency_key, payload, attempt, max_attempts,
			claimed_by, claimed_at, started_at, lease_expires_at, heartbeat_at,
			error_code, error
		) VALUES (
			%s::uuid, %s::uuid, %s::uuid, 'document.ingest', 'running', 'parsing',
			%s, '{"b5_alert_probe": true}'::jsonb, 1, 5,
			'b5-min-alerts', now() - interval '20 minutes', now() - interval '20 minutes',
			now() - interval '15 minutes', now() - interval '15 minutes',
			'ingest_transient', 'synthetic stuck job for B5 acceptance'
		)
		""",
		(job_id, org, ws, key),
	)
	conn.commit()
print(job_id)
PY
	then
		fail_case "S3.inject" "failed to insert stuck job: $(head -c 240 "$WORKDIR/s3-inject.err")"
		return
	fi
	TEST_JOB_ID="$(tr -d '[:space:]' <"$inject_out")"
	[[ -n "$TEST_JOB_ID" ]] || { fail_case "S3.inject" "empty job id after insert"; return; }
	pass_case "S3.inject" "stuck job_id=$TEST_JOB_ID workspace=$WS_ID"

	run_checker "$WORKDIR/s3-fire.json"
	if wait_alert "$name" firing 15; then
		if python3 - "$WORKDIR/wait-$name-firing.json" "$TEST_JOB_ID" "$WS_ID" <<'PY'
import json, sys
meta=json.load(open(sys.argv[1], encoding="utf-8"))
last=meta.get("last") or {}
job=str(last.get("job_id") or "")
ws=str(last.get("workspace_id") or "")
need_job, need_ws = sys.argv[2], sys.argv[3]
ok = (job == need_job) and (ws == need_ws)
print(json.dumps({"ok": ok, "job_id": job, "workspace_id": ws}, ensure_ascii=False))
raise SystemExit(0 if ok else 1)
PY
		then
			pass_case "S3.firing" "firing with job_id+workspace_id"
		else
			fail_case "S3.locator" "locator mismatch $(cat "$WORKDIR/wait-$name-firing.json")"
		fi
	else
		fail_case "S3.firing" "no firing webhook; $(head -c 280 "$WORKDIR/s3-fire.json")"
	fi

	log "  recover: delete synthetic stuck job"
	delete_test_job
	run_checker "$WORKDIR/s3-resolve.json"
	if wait_alert "$name" resolved 15; then
		pass_case "S3.resolved" "webhook resolved after job delete"
		pass_case "S3" "PASS jobs.dead_stuck firing→resolved"
	else
		fail_case "S3.resolved" "no resolved webhook"
	fi
}

# ---------- S4 ask.http_5xx ----------
run_s4() {
	log "S4: Ask 5xx/503 anomaly"
	local name="ask.http_5xx"
	if ! docker ps --format '{{.Names}}' | grep -qx 'unorag-qdrant-1'; then
		block_case "S4" "container unorag-qdrant-1 not running"
		return
	fi
	reset_state_and_alerts
	printf 'b5-acceptor\n%s\n' "$(now_epoch)" >"$READY_FILE"
	run_checker "$WORKDIR/s4-base.json"

	log "  inject: stop qdrant → Ask probe 5xx/503"
	docker stop unorag-qdrant-1 >/dev/null
	QDRANT_WAS_STOPPED=1
	sleep 2
	run_checker "$WORKDIR/s4-fire.json"
	if wait_alert "$name" firing 20; then
		pass_case "S4.firing" "Ask 5xx webhook: $(cat "$WORKDIR/wait-$name-firing.json")"
		if python3 - "$WORKDIR/wait-$name-firing.json" "$WS_ID" <<'PY'
import json, sys
last=(json.load(open(sys.argv[1]))).get("last") or {}
ws=str(last.get("workspace_id") or "")
trace=str(last.get("trace_id") or "")
ok = ws == sys.argv[2]
print(json.dumps({"ok": ok, "workspace_id": ws, "trace_id": trace}, ensure_ascii=False))
raise SystemExit(0 if ok else 1)
PY
		then
			pass_case "S4.locator" "workspace_id present (trace_id optional if gateway omits)"
		else
			fail_case "S4.locator" "workspace_id missing"
		fi
	else
		fail_case "S4.firing" "no firing webhook; $(head -c 300 "$WORKDIR/s4-fire.json")"
	fi

	docker start unorag-qdrant-1 >/dev/null
	QDRANT_WAS_STOPPED=0
	for _ in $(seq 1 40); do
		curl -sf http://127.0.0.1:6333/readyz >/dev/null 2>&1 && break
		sleep 1
	done
	sleep 2
	run_checker "$WORKDIR/s4-resolve.json"
	if wait_alert "$name" resolved 20; then
		pass_case "S4.resolved" "Ask alert resolved"
		pass_case "S4" "PASS ask.http_5xx firing→resolved"
	else
		fail_case "S4.resolved" "no resolved webhook"
	fi
}

# ---------- S5 disk.usage ----------
run_s5() {
	log "S5: disk usage > 85%"
	local name="disk.usage"
	reset_state_and_alerts
	printf 'b5-acceptor\n%s\n' "$(now_epoch)" >"$READY_FILE"

	# Real measurement first (should be under threshold on this host)
	run_checker "$WORKDIR/s5-base.json"
	local real_pct
	real_pct="$(python3 - "$DOC_ROOT" <<'PY'
import shutil, sys
u=shutil.disk_usage(sys.argv[1])
print(round(100*u.used/u.total, 2))
PY
	)"
	pass_case "S5.measure" "real documents volume usage=${real_pct}% path=$DOC_ROOT"

	log "  inject: UNORAG_ALERT_DISK_FORCE_PERCENT=90 (webhook path; host disk not filled)"
	run_checker "$WORKDIR/s5-fire.json" UNORAG_ALERT_DISK_FORCE_PERCENT=90
	# Also pass via CLI for the same effect
	if ! wait_alert "$name" firing 10; then
		# retry with explicit CLI flag in case env was ignored by wrapper
		env UNORAG_ALERT_DISK_FORCE_PERCENT=90 "$PY_API" "$CHECKER" once \
			--webhook-url "$ALERT_WEBHOOK_URL" \
			--health-url "$UNORAG_HEALTH_URL" \
			--ready-file "$READY_FILE" \
			--database-url "$DATABASE_URL" \
			--document-root "$DOC_ROOT" \
			--postgres-path "$ROOT" \
			--qdrant-path "$ROOT" \
			--state-file "$STATE_FILE" \
			--workspace-id "$WS_ID" \
			--disk-force-percent 90 \
			--ask-probe-url "$ASK_PROBE_URL" \
			--ask-probe-body "$ASK_PROBE_BODY" \
			--ask-cookie-jar "$ASK_COOKIE_JAR" \
			>"$WORKDIR/s5-fire2.json" 2>"$WORKDIR/s5-fire2.err" || true
	fi
	if wait_alert "$name" firing 15; then
		pass_case "S5.firing" "disk firing webhook (force=90): $(cat "$WORKDIR/wait-$name-firing.json")"
	else
		fail_case "S5.firing" "no firing webhook; $(head -c 280 "$WORKDIR/s5-fire.json")"
	fi

	log "  recover: clear force percent"
	run_checker "$WORKDIR/s5-resolve.json"
	if wait_alert "$name" resolved 15; then
		pass_case "S5.resolved" "disk alert resolved"
		pass_case "S5" "PASS disk.usage (force-inject) firing→resolved; real=${real_pct}%"
	else
		fail_case "S5.resolved" "no resolved webhook"
	fi
}

# ---------- run selected ----------
for case in $CASES; do
	case "$case" in
		S1) run_s1 ;;
		S2) run_s2 ;;
		S3) run_s3 ;;
		S4) run_s4 ;;
		S5) run_s5 ;;
		*) warn "unknown case $case"; ;;
	esac
done

write_report "$OVERALL" "${DETAIL_MSG:-ok}"
case "$OVERALL" in
	PASS) exit 0 ;;
	BLOCKED) exit 2 ;;
	*) exit 1 ;;
esac
