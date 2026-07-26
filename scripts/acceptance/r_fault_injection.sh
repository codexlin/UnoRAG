#!/usr/bin/env bash
# R1–R4 fault injection against the running hybrid stack (or MERIKNOW_BASE_URL).
#
# Safety:
#   - Does NOT wipe .meriknow / Postgres volumes.
#   - R2 briefly stops the shared Qdrant container then starts it again.
#   - R3/R4 temporarily patch apps/api/.env and restore on EXIT (uvicorn --reload).
#
# Exit: 0=all selected PASS  1=FAIL  2=BLOCKED
# Select: MERIKNOW_R_CASES="R1 R2 R3 R4" (default all)
set -euo pipefail

ACC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$ACC_DIR/../.." && pwd)"
# shellcheck disable=SC1091
source "$ACC_DIR/lib/common.sh"
cd "$ROOT"

RC_SHA="${MERIKNOW_RC_SHA:-b98f01438045c92804204449d3172ceb201490e6}"
SCRIPT_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
BASE_URL="${MERIKNOW_BASE_URL:-http://localhost:3000}"
BASE_URL="${BASE_URL%/}"
API_ENV="$ROOT/apps/api/.env"
REPORT_JSON="${MERIKNOW_R_REPORT:-$ACC_DIR/.r_fault_last_run.json}"
CASES="${MERIKNOW_R_CASES:-R1 R2 R3 R4}"
JOB_TIMEOUT_SEC="${MERIKNOW_PILOT_JOB_TIMEOUT_SEC:-300}"
POLL_INTERVAL_SEC="${MERIKNOW_PILOT_POLL_INTERVAL_SEC:-3}"
PASSWORD="${MERIKNOW_R_PASSWORD:-${MERIKNOW_ADMIN_PASSWORD:-}}"
EMAIL="${MERIKNOW_ADMIN_EMAIL:-admin@example.com}"

WORKDIR="$(mktemp -d -t meriknow-r-fault.XXXXXX)"
COOKIE_JAR="$WORKDIR/cookies.jar"
CHECKS_FILE="$WORKDIR/checks.jsonl"
: >"$CHECKS_FILE"
API_ENV_BACKUP=""
QDRANT_WAS_STOPPED=0
OVERALL=PASS
DETAIL_MSG=""

log() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }

load_env_file_keys "$ROOT/apps/web/.env.local" \
	MERIKNOW_ADMIN_PASSWORD MERIKNOW_ADMIN_EMAIL MERIKNOW_BASE_URL DATABASE_URL
load_env_file_keys "$API_ENV" \
	ASK_MODE OPENAI_BASE_URL MINERU_ENABLED MINERU_URL MINERU_MODE
[[ -n "$PASSWORD" ]] || PASSWORD="${MERIKNOW_ADMIN_PASSWORD:-}"
[[ -n "${MERIKNOW_ADMIN_EMAIL:-}" ]] && EMAIL="$MERIKNOW_ADMIN_EMAIL"

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
	python3 - "$REPORT_JSON" "$1" "$2" "$RC_SHA" "$SCRIPT_SHA" "$BASE_URL" "$CHECKS_FILE" <<'PY' || true
import json, sys, pathlib, time
out, status, detail, rc, script, base, checks_path = sys.argv[1:8]
checks=[]
for line in pathlib.Path(checks_path).read_text(encoding="utf-8").splitlines():
	if line.strip():
		checks.append(json.loads(line))
# per-case rollup
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
payload={
	"suite": "R1-R4 fault injection",
	"status": status,
	"detail": detail,
	"rc_sha": rc,
	"script_sha": script,
	"base_url": base,
	"cases": cases,
	"checks": checks,
	"finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}
pathlib.Path(out).write_text(json.dumps(payload, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
print(f"report → {out}")
PY
}

restore_api_env() {
	if [[ -n "$API_ENV_BACKUP" && -f "$API_ENV_BACKUP" ]]; then
		cp "$API_ENV_BACKUP" "$API_ENV"
		log "restored apps/api/.env from backup"
		# give uvicorn --reload a moment
		sleep 3
	fi
}

restore_qdrant() {
	if [[ "$QDRANT_WAS_STOPPED" == "1" ]]; then
		docker start meriknow-qdrant-1 >/dev/null 2>&1 || true
		# wait ready
		for _ in $(seq 1 30); do
			if curl -sf http://127.0.0.1:6333/readyz >/dev/null 2>&1; then
				break
			fi
			sleep 1
		done
		QDRANT_WAS_STOPPED=0
		log "qdrant restarted"
	fi
}

cleanup() {
	restore_api_env
	restore_qdrant
	rm -rf "$WORKDIR"
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

HEALTH_CODE="$(http_code "$BASE_URL/api/rag/health")"
if [[ "$HEALTH_CODE" != "200" ]]; then
	write_report BLOCKED "edge not ready at $BASE_URL (HTTP $HEALTH_CODE)"
	exit 2
fi
[[ -n "$PASSWORD" ]] || { write_report BLOCKED "set MERIKNOW_ADMIN_PASSWORD or MERIKNOW_R_PASSWORD"; exit 2; }

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
			-d "{\"name\":\"R-Fault $(date +%s)\"}" \
			"$BASE_URL/api/libraries" || true
	)"
	[[ "$code" == "200" || "$code" == "201" ]] || { write_report BLOCKED "create library HTTP $code"; exit 2; }
	json_get "$body" id
}

wait_job_status() {
	# wait_job_status <job_id> <timeout> → prints final status
	local job_id="$1" timeout="${2:-$JOB_TIMEOUT_SEC}"
	local started body code status
	started="$(now_epoch)"
	body="$WORKDIR/job-$job_id.json"
	while true; do
		code="$(auth_curl -o "$body" -w '%{http_code}' "$BASE_URL/api/jobs/${job_id}" || true)"
		[[ "$code" == "200" ]] || { echo "http_$code"; return 1; }
		status="$(json_get "$body" status || echo unknown)"
		case "$status" in
			completed|failed|dead|cancelled) echo "$status"; return 0 ;;
		esac
		if (( $(now_epoch) - started > timeout )); then
			echo "timeout_$status"
			return 1
		fi
		sleep "$POLL_INTERVAL_SEC"
	done
}

find_lifecycle_pid() {
	# Match interpreter path (.../python3 -m app.lifecycle_worker). Avoid zsh/uv
	# wrappers whose args also contain the module string (macOS truncates comm).
	ps -ax -o pid=,args= 2>/dev/null | awk '
		$0 ~ /\/python[0-9.]* -m app\.lifecycle_worker/ { print $1; exit }
	'
}

ensure_lifecycle_worker() {
	local pid
	pid="$(find_lifecycle_pid)"
	if [[ -n "$pid" ]]; then
		return 0
	fi
	log "  starting lifecycle_worker"
	(
		cd "$ROOT/apps/api"
		export DOCUMENT_STORAGE_ROOT="${DOCUMENT_STORAGE_ROOT:-$ROOT/.meriknow/documents}"
		mkdir -p "$DOCUMENT_STORAGE_ROOT"
		nohup uv run python -m app.lifecycle_worker >"$WORKDIR/lifecycle-ensure.log" 2>&1 &
	)
	sleep 2
	pid="$(find_lifecycle_pid)"
	[[ -n "$pid" ]]
}

# ---------- R1 ----------
run_r1() {
	log "R1: lifecycle worker SIGTERM — job not lost"
	local inject="kill -TERM <lifecycle_python_pid>"
	local expect="job stays queued/leased; after worker restart completes or safe-retries"
	local lib_id doc_file up body job_id pid status new_pid
	ensure_lifecycle_worker || { block_case "R1" "cannot start lifecycle_worker"; return; }
	lib_id="$(ensure_library)"
	doc_file="$WORKDIR/r1.md"
	cat >"$doc_file" <<EOF
# R1 Worker Drain

Marker: R1_WORKER_${RANDOM}_$(date +%s)
EOF
	pid="$(find_lifecycle_pid)"
	if [[ -z "$pid" ]]; then
		block_case "R1" "no lifecycle_worker process (start: uv run python -m app.lifecycle_worker)"
		return
	fi
	local comm
	comm="$(ps -p "$pid" -o comm= 2>/dev/null || echo unknown)"
	log "  inject: SIGTERM pid=$pid comm=$comm"
	# Kill the python worker and any uv parent in the same process group carefully.
	kill -TERM "$pid" 2>/dev/null || true
	# Also stop sibling uv wrappers that share the module cmdline but aren't python.
	pgrep -f 'uv run python -m app.lifecycle_worker' | while read -r p; do
		kill -TERM "$p" 2>/dev/null || true
	done
	for _ in $(seq 1 40); do
		[[ -z "$(find_lifecycle_pid)" ]] && break
		sleep 0.5
	done
	if [[ -n "$(find_lifecycle_pid)" ]]; then
		fail_case "R1" "worker still alive after SIGTERM (pid=$(find_lifecycle_pid))"
		return
	fi
	pass_case "R1.inject" "SIGTERM delivered; worker exited (was pid=$pid)"

	up="$WORKDIR/r1-up.json"
	local code
	code="$(
		auth_curl -o "$up" -w '%{http_code}' \
			-F "file=@${doc_file};filename=r1.md;type=text/markdown" \
			-F "display_name=R1 Drain Doc" \
			"$BASE_URL/api/libraries/${lib_id}/documents" || true
	)"
	[[ "$code" == "202" ]] || { fail_case "R1" "upload while worker down HTTP $code"; return; }
	job_id="$(json_get "$up" job_id)"
	pass_case "R1.enqueue" "job_id=$job_id accepted while worker down"

	# brief observe: should not complete without worker
	sleep 4
	body="$WORKDIR/r1-job.json"
	auth_curl -o "$body" "$BASE_URL/api/jobs/${job_id}" >/dev/null || true
	status="$(json_get "$body" status || echo unknown)"
	if [[ "$status" == "completed" ]]; then
		fail_case "R1" "job completed with no worker — unexpected (another worker alive?)"
		return
	fi
	pass_case "R1.queued" "status=$status while worker down (not silently completed)"

	log "  recover: restart lifecycle_worker"
	ensure_lifecycle_worker || { fail_case "R1" "worker failed to restart"; return; }
	new_pid="$(find_lifecycle_pid)"
	pass_case "R1.recover_start" "worker pid=$new_pid"

	status="$(wait_job_status "$job_id" "$JOB_TIMEOUT_SEC" || true)"
	if [[ "$status" == "completed" ]]; then
		pass_case "R1.recover" "job_id=$job_id completed after restart; inject=$inject"
		pass_case "R1" "PASS expect=[$expect] actual=[job resumed→completed] job_id=$job_id"
	elif [[ "$status" == "failed" || "$status" == "dead" ]]; then
		local retry="$WORKDIR/r1-retry.json"
		code="$(
			auth_curl -o "$retry" -w '%{http_code}' -X POST \
				"$BASE_URL/api/jobs/${job_id}/retry" || true
		)"
		if [[ "$code" == "200" || "$code" == "202" ]]; then
			local j2
			j2="$(json_get "$retry" job_id 2>/dev/null || echo "$job_id")"
			status="$(wait_job_status "$j2" "$JOB_TIMEOUT_SEC" || true)"
			if [[ "$status" == "completed" ]]; then
				pass_case "R1" "PASS safe-retry after terminal→completed job=$j2"
				return
			fi
		fi
		fail_case "R1" "job ended status=$status without successful retry; body=$(head -c 200 "$body")"
	else
		fail_case "R1" "job did not complete after restart (status=$status) job_id=$job_id"
	fi
}

# ---------- R2 ----------
run_r2() {
	log "R2: pause Qdrant — API must fail/degrade, not fabricate answers"
	local inject="docker stop meriknow-qdrant-1"
	local expect="health/ask shows qdrant failure or explicit error; no fake citations"
	local lib_id ask_req ask_body health code

	if ! docker ps --format '{{.Names}}' | grep -qx 'meriknow-qdrant-1'; then
		block_case "R2" "container meriknow-qdrant-1 not running"
		return
	fi

	lib_id="$(ensure_library)"
	# Ensure at least one ready doc for ask path — upload small md first (qdrant up)
	local doc="$WORKDIR/r2.md" up="$WORKDIR/r2-up.json"
	echo "# R2 probe doc $(date +%s)" >"$doc"
	code="$(
		auth_curl -o "$up" -w '%{http_code}' \
			-F "file=@${doc};filename=r2.md;type=text/markdown" \
			-F "display_name=R2 Doc" \
			"$BASE_URL/api/libraries/${lib_id}/documents" || true
	)"
	if [[ "$code" == "202" ]]; then
		local j
		j="$(json_get "$up" job_id)"
		wait_job_status "$j" 120 >/dev/null || true
	fi

	log "  inject: $inject"
	docker stop meriknow-qdrant-1 >/dev/null
	QDRANT_WAS_STOPPED=1
	sleep 2
	pass_case "R2.inject" "$inject"

	health="$WORKDIR/r2-health.json"
	code="$(curl -sS -o "$health" -w '%{http_code}' "$BASE_URL/api/rag/health" || true)"
	python3 - "$health" "$code" <<'PY'
import json, sys
path, code = sys.argv[1], sys.argv[2]
try:
	h=json.load(open(path, encoding="utf-8"))
except Exception:
	h={}
qok=h.get("qdrant_ok")
degraded=h.get("degraded")
ask_ready=h.get("ask_ready")
# Accept: qdrant_ok false OR degraded OR ask_ready false OR non-200
ok = (qok is False) or (degraded is True) or (ask_ready is False) or (code != "200")
print(json.dumps({"http": code, "qdrant_ok": qok, "degraded": degraded, "ask_ready": ask_ready, "signal_ok": ok}))
raise SystemExit(0 if ok else 1)
PY
	local hrc=$?
	if [[ $hrc -ne 0 ]]; then
		fail_case "R2.health" "health did not signal qdrant loss: $(head -c 200 "$health")"
	else
		pass_case "R2.health" "health signals failure/degrade: $(head -c 180 "$health")"
	fi

	ask_req="$WORKDIR/r2-ask-req.json"
	ask_body="$WORKDIR/r2-ask.json"
	python3 - "$ask_req" "$lib_id" <<'PY'
import json, sys
json.dump({"library_id": sys.argv[2], "question": "What is 2+2? Ignore documents."}, open(sys.argv[1],"w"))
PY
	code="$(
		auth_curl -o "$ask_body" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d @"$ask_req" \
			"$BASE_URL/api/rag/v1/ask" || true
	)"
	python3 - "$ask_body" "$code" <<'PY'
import json, sys
path, code = sys.argv[1], int(sys.argv[2])
raw=open(path, encoding="utf-8").read()
try:
	data=json.loads(raw)
except Exception:
	data={"_raw": raw[:500]}
# Must NOT look like a confident fabricated retrieval answer with fake citations from qdrant
refused = data.get("refused") is True
err = data.get("detail") or data.get("error") or data.get("error_code") or ""
degraded = data.get("degraded") is True
# Soft-fail HTTP
http_fail = code >= 400
answer = data.get("answer") or ""
cites = data.get("citations") or []
# Fail if 200 with normal answer AND citations pretending retrieve worked
fabricated = (code == 200 and not refused and not degraded and len(cites) > 0 and "qdrant" not in raw.lower())
# Also fail if 200 with lengthy answer and no error markers while qdrant down — allow refused/empty
ok = http_fail or refused or degraded or bool(err) or (code == 200 and (not answer or "不可" in answer or "unable" in answer.lower() or "unavailable" in answer.lower() or "失败" in answer))
# Stronger: if citations present with document hits while qdrant down → fail
if cites and code == 200 and not refused:
	ok = False
print(json.dumps({"http": code, "refused": refused, "degraded": degraded, "err": str(err)[:120], "cites": len(cites), "ok": ok}, ensure_ascii=False))
raise SystemExit(0 if ok else 1)
PY
	if [[ $? -ne 0 ]]; then
		fail_case "R2.ask" "Ask fabricated or silent-success while Qdrant down HTTP=$code body=$(head -c 240 "$ask_body")"
	else
		pass_case "R2.ask" "explicit fail/refuse/degrade HTTP=$code (no fake citations)"
	fi

	log "  recover: docker start meriknow-qdrant-1"
	docker start meriknow-qdrant-1 >/dev/null
	QDRANT_WAS_STOPPED=0
	for _ in $(seq 1 40); do
		curl -sf http://127.0.0.1:6333/readyz >/dev/null 2>&1 && break
		sleep 1
	done
	sleep 2
	code="$(http_code "$BASE_URL/api/rag/health")"
	if [[ "$code" == "200" ]]; then
		pass_case "R2.recover" "qdrant+health restored"
		pass_case "R2" "PASS inject=[$inject] expect=[$expect]"
	else
		fail_case "R2.recover" "health HTTP $code after qdrant start"
	fi
}

# ---------- R3 ----------
run_r3() {
	log "R3: model endpoint unavailable — clear error, index intact"
	local inject="OPENAI_BASE_URL=http://127.0.0.1:1 (dead)"
	local expect="Ask errors/refuses with trace; active docs unchanged"
	local lib_id orig_url doc up ask_req ask_body code doc_before doc_after

	[[ -f "$API_ENV" ]] || { block_case "R3" "apps/api/.env missing"; return; }
	ensure_lifecycle_worker || { block_case "R3" "lifecycle_worker not running"; return; }
	API_ENV_BACKUP="$WORKDIR/api.env.bak"
	cp "$API_ENV" "$API_ENV_BACKUP"
	orig_url="$(env_get_key "$API_ENV" OPENAI_BASE_URL 2>/dev/null || echo "")"

	lib_id="$(ensure_library)"
	doc="$WORKDIR/r3.md"
	cat >"$doc" <<EOF
# R3 Model Down

Marker: R3_MODEL_${RANDOM}_$(date +%s)
EOF
	up="$WORKDIR/r3-up.json"
	code="$(
		auth_curl -o "$up" -w '%{http_code}' \
			-F "file=@${doc};filename=r3.md;type=text/markdown" \
			-F "display_name=R3 Doc" \
			"$BASE_URL/api/libraries/${lib_id}/documents" || true
	)"
	[[ "$code" == "202" ]] || { fail_case "R3" "upload HTTP $code"; restore_api_env; return; }
	local job_id doc_id
	job_id="$(json_get "$up" job_id)"
	doc_id="$(json_get "$up" document_id)"
	local st
	st="$(wait_job_status "$job_id" "$JOB_TIMEOUT_SEC" || true)"
	[[ "$st" == "completed" ]] || { block_case "R3" "ingest not completed ($st) — cannot prove index intact"; restore_api_env; return; }

	doc_before="$WORKDIR/r3-doc-before.json"
	auth_curl -o "$doc_before" "$BASE_URL/api/libraries/${lib_id}/documents/${doc_id}/versions" >/dev/null

	log "  inject: $inject"
	env_set_key "$API_ENV" OPENAI_BASE_URL "http://127.0.0.1:1"
	# touch to encourage reload
	touch "$API_ENV"
	sleep 5
	pass_case "R3.inject" "$inject"

	ask_req="$WORKDIR/r3-ask-req.json"
	ask_body="$WORKDIR/r3-ask.json"
	python3 - "$ask_req" "$lib_id" <<'PY'
import json, sys
json.dump({"library_id": sys.argv[2], "question": "Summarize the R3_MODEL marker document."}, open(sys.argv[1],"w"))
PY
	code="$(
		auth_curl -o "$ask_body" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d @"$ask_req" \
			"$BASE_URL/api/rag/v1/ask" || true
	)"
	python3 - "$ask_body" "$code" <<'PY'
import json, sys
path, code = sys.argv[1], int(sys.argv[2])
raw=open(path, encoding="utf-8").read()
try:
	data=json.loads(raw)
except Exception:
	data={"_raw": raw[:500]}
trace = data.get("trace_id") or (data.get("debug") or {}).get("trace_id") or data.get("request_id")
refused = data.get("refused") is True
err = str(data.get("detail") or data.get("error") or data.get("error_code") or "")
answer = data.get("answer") or ""
http_fail = code >= 400
# Must be an explicit failure/refuse — not a normal fluent answer pretending success
ok = http_fail or refused or bool(err) or (code == 200 and (not answer or any(x in (answer+err+raw).lower() for x in ("error", "fail", "unavailable", "超时", "失败", "无法", "拒"))))
print(json.dumps({"http": code, "trace_id": trace, "refused": refused, "ok": ok, "err": err[:160]}, ensure_ascii=False))
raise SystemExit(0 if ok else 1)
PY
	if [[ $? -ne 0 ]]; then
		fail_case "R3.ask" "Ask did not clearly fail HTTP=$code body=$(head -c 240 "$ask_body")"
	else
		local trace
		trace="$(python3 -c "import json;d=json.load(open('$ask_body'));print(d.get('trace_id') or (d.get('debug') or {}).get('trace_id') or '')" 2>/dev/null || true)"
		pass_case "R3.ask" "explicit error/refuse HTTP=$code trace_id=${trace:-n/a}"
	fi

	doc_after="$WORKDIR/r3-doc-after.json"
	auth_curl -o "$doc_after" "$BASE_URL/api/libraries/${lib_id}/documents/${doc_id}/versions" >/dev/null
	python3 - "$doc_before" "$doc_after" <<'PY' || { fail_case "R3.index" "document metadata changed after model outage"; restore_api_env; return; }
import json, sys
a=json.load(open(sys.argv[1], encoding="utf-8"))
b=json.load(open(sys.argv[2], encoding="utf-8"))
assert a.get("active_version_id") == b.get("active_version_id"), (a.get("active_version_id"), b.get("active_version_id"))
def gen(d):
	av=d.get("active_version_id")
	for v in d.get("versions") or []:
		if v.get("id")==av or v.get("is_active"):
			return v.get("generation_id"), v.get("status"), v.get("point_count")
	return None, None, None
assert gen(a)==gen(b), (gen(a), gen(b))
print("index intact")
PY
	pass_case "R3.index" "active document metadata unchanged doc_id=$doc_id"

	restore_api_env
	API_ENV_BACKUP=""
	sleep 4
	pass_case "R3.recover" "OPENAI_BASE_URL restored"
	pass_case "R3" "PASS inject=[$inject] expect=[$expect] doc_id=$doc_id"
}

# ---------- R4 ----------
run_r4() {
	log "R4: MinerU unavailable — degrade or diagnosable dead job, no permanent queue stuck"
	local inject="MINERU_URL=http://127.0.0.1:1 (+ enabled)"
	local expect="degrade to PyMuPDF or dead/retry with mineru error; queue not wedged"
	local lib_id pdf up code job_id status body

	[[ -f "$API_ENV" ]] || { block_case "R4" "apps/api/.env missing"; return; }
	pdf="$ROOT/testdata/pdf/leave-scanned.pdf"
	[[ -f "$pdf" ]] || pdf="$ROOT/testdata/ab/scan-lowcontrast.pdf"
	[[ -f "$pdf" ]] || { block_case "R4" "no scanned PDF in testdata"; return; }

	API_ENV_BACKUP="$WORKDIR/api.env.bak"
	cp "$API_ENV" "$API_ENV_BACKUP"
	env_set_key "$API_ENV" MINERU_ENABLED "true"
	env_set_key "$API_ENV" MINERU_URL "http://127.0.0.1:1"
	env_set_key "$API_ENV" MINERU_MODE "auto"
	touch "$API_ENV"
	# restart worker to pick circuit/env (lifecycle_worker typically no reload)
	local wpid
	wpid="$(find_lifecycle_pid)"
	if [[ -n "$wpid" ]]; then
		kill -TERM "$wpid" 2>/dev/null || true
		sleep 2
	fi
	(
		cd "$ROOT/apps/api"
		export DOCUMENT_STORAGE_ROOT="${DOCUMENT_STORAGE_ROOT:-$ROOT/.meriknow/documents}"
		# Force env for worker process (more reliable than .env alone)
		MINERU_ENABLED=true MINERU_URL="http://127.0.0.1:1" MINERU_MODE=auto \
			nohup uv run python -m app.lifecycle_worker >"$WORKDIR/r4-worker.log" 2>&1 &
		echo $! >"$WORKDIR/r4-worker.pid"
	)
	sleep 3
	pass_case "R4.inject" "$inject (worker restarted)"

	lib_id="$(ensure_library)"
	up="$WORKDIR/r4-up.json"
	code="$(
		auth_curl -o "$up" -w '%{http_code}' \
			-F "file=@${pdf};filename=r4-scan.pdf;type=application/pdf" \
			-F "display_name=R4 MinerU Down" \
			"$BASE_URL/api/libraries/${lib_id}/documents" || true
	)"
	[[ "$code" == "202" ]] || { fail_case "R4" "upload HTTP $code"; restore_api_env; return; }
	job_id="$(json_get "$up" job_id)"
	pass_case "R4.enqueue" "job_id=$job_id"

	# Allow long parse window
	status="$(wait_job_status "$job_id" "${MERIKNOW_R4_TIMEOUT_SEC:-420}" || true)"
	body="$WORKDIR/job-$job_id.json"
	auth_curl -o "$body" "$BASE_URL/api/jobs/${job_id}" >/dev/null || true

	python3 - "$body" "$status" <<'PY'
import json, sys
data=json.load(open(sys.argv[1], encoding="utf-8"))
status=sys.argv[2]
blob=json.dumps(data, ensure_ascii=False).lower()
stage=str(data.get("stage") or "")
err=str(data.get("error") or data.get("error_code") or data.get("last_error") or "")
# Acceptable outcomes:
# 1) completed with degrade warnings (pymupdf fallback)
# 2) failed/dead with mineru/unreachable/circuit diagnostics
# 3) NOT forever queued/running without progress markers after timeout
ok = False
reason = ""
if status == "completed":
	ok = True
	reason = "completed (likely PyMuPDF degrade path)"
elif status in ("failed", "dead"):
	keys = ("mineru", "unreachable", "circuit", "timeout", "parse", "连接", "unavailable")
	ok = any(k in blob for k in keys) or bool(err) or bool(stage)
	reason = f"terminal={status} stage={stage} err={err[:120]}"
elif status.startswith("timeout_"):
	# stuck?
	ok = False
	reason = f"still non-terminal: {status}"
else:
	reason = f"unexpected status={status}"
print(json.dumps({"ok": ok, "status": status, "reason": reason, "stage": stage}, ensure_ascii=False))
raise SystemExit(0 if ok else 1)
PY
	if [[ $? -ne 0 ]]; then
		fail_case "R4.outcome" "job_id=$job_id status=$status body=$(head -c 280 "$body")"
	else
		pass_case "R4.outcome" "job_id=$job_id status=$status diagnosable/degraded"
	fi

	# Queue not permanently wedged: restore MinerU config, restart worker, tiny md must complete.
	restore_api_env
	API_ENV_BACKUP=""
	wpid="$(find_lifecycle_pid)"
	if [[ -n "$wpid" ]]; then
		kill -TERM "$wpid" 2>/dev/null || true
		pgrep -f 'uv run python -m app.lifecycle_worker' | while read -r p; do kill -TERM "$p" 2>/dev/null || true; done
		sleep 2
	fi
	# Clear any process-level MINERU override from prior nohup env by fresh start.
	unset MINERU_URL MINERU_ENABLED MINERU_MODE || true
	ensure_lifecycle_worker || { fail_case "R4.queue" "worker failed to restart after MinerU restore"; return; }
	sleep 2
	local md="$WORKDIR/r4-follow.md" up2="$WORKDIR/r4-up2.json" body2
	local follow_token="R4_FOLLOW_${RANDOM}_$(date +%s)"
	cat >"$md" <<EOF
# R4 Follow-up Document

Plain markdown probe after MinerU outage. Unique token: \`${follow_token}\`.

This document should parse with the local markdown path and must not permanently wedge the queue.
EOF
	code="$(
		auth_curl -o "$up2" -w '%{http_code}' \
			-F "file=@${md};filename=r4-follow.md;type=text/markdown" \
			-F "display_name=R4 Follow" \
			"$BASE_URL/api/libraries/${lib_id}/documents" || true
	)"
	if [[ "$code" == "202" ]]; then
		local j2 st2
		j2="$(json_get "$up2" job_id)"
		st2="$(wait_job_status "$j2" 180 || true)"
		body2="$WORKDIR/job-$j2.json"
		auth_curl -o "$body2" "$BASE_URL/api/jobs/${j2}" >/dev/null || true
		if [[ "$st2" == "completed" ]]; then
			pass_case "R4.queue" "follow-up md job completed — queue not wedged"
			pass_case "R4" "PASS inject=[$inject] expect=[$expect] mineru_job=$job_id"
		else
			fail_case "R4.queue" "follow-up job status=$st2 body=$(head -c 220 "$body2")"
		fi
	else
		fail_case "R4.queue" "follow-up upload HTTP $code"
	fi
}

# ---------- main ----------
log "R-fault suite rc=$RC_SHA script=$SCRIPT_SHA base=$BASE_URL cases=$CASES"
login

for case in $CASES; do
	# Best-effort restore between cases so one injection does not poison the next.
	restore_api_env
	restore_qdrant
	ensure_lifecycle_worker || warn "lifecycle_worker not running before $case"
	case "$case" in
		R1) run_r1 ;;
		R2) run_r2 ;;
		R3) run_r3 ;;
		R4) run_r4 ;;
		*) warn "unknown case $case — skip" ;;
	esac
done

write_report "$OVERALL" "${DETAIL_MSG:-ok}"
case "$OVERALL" in
	PASS) exit 0 ;;
	FAIL) exit 1 ;;
	*) exit 2 ;;
esac
