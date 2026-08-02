#!/usr/bin/env bash
# S1/S2 multi-org / multi-workspace isolation acceptance.
# Topology: OrgA{A1,A2} + OrgB{B1}; markers + service keys + restricted ACL.
#
# Exit codes (aligned with pilot-smoke / pilot-preflight):
#   0 = PASS
#   1 = FAIL (leak or unexpected product error)
#   2 = SKIP/BLOCKED (stack, DB, embedding/LLM unavailable)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ACC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Optionally load KEY=VALUE lines without `source` (values may contain spaces).
# Never print secret values. Node bootstrap also loads .env.local via loadEnvFile.
load_env_keys() {
	local envfile="$1"
	[[ -f "$envfile" ]] || return 0
	while IFS= read -r line || [[ -n "$line" ]]; do
		[[ "$line" =~ ^[[:space:]]*# ]] && continue
		[[ "$line" =~ ^[[:space:]]*$ ]] && continue
		if [[ "$line" =~ ^(UNORAG_BASE_URL|UNORAG_ISOLATION_PASSWORD|UNORAG_PILOT_JOB_TIMEOUT_SEC|UNORAG_PILOT_POLL_INTERVAL_SEC|UNORAG_ISOLATION_KEEP)= ]]; then
			local key="${line%%=*}"
			local val="${line#*=}"
			val="${val%\"}"
			val="${val#\"}"
			val="${val%\'}"
			val="${val#\'}"
			export "$key=$val"
		fi
	done <"$envfile"
}
for envfile in "$ROOT/.env.local" "$ROOT/deploy/compose/.env" "$ROOT/.env"; do
	load_env_keys "$envfile"
done

BASE_URL="${UNORAG_BASE_URL:-http://localhost:3000}"
BASE_URL="${BASE_URL%/}"
PASSWORD="${UNORAG_ISOLATION_PASSWORD:-IsolationPilot!2026}"
JOB_TIMEOUT_SEC="${UNORAG_PILOT_JOB_TIMEOUT_SEC:-300}"
POLL_INTERVAL_SEC="${UNORAG_PILOT_POLL_INTERVAL_SEC:-3}"
KEEP_TOPOLOGY="${UNORAG_ISOLATION_KEEP:-0}"
RC_SHA="${UNORAG_RC_SHA:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)}"
REPORT_JSON="${UNORAG_ISOLATION_REPORT:-$ACC_DIR/.s1_s2_last_run.json}"
TOPOLOGY_JSON="${UNORAG_ISOLATION_TOPOLOGY:-$ACC_DIR/.isolation-topology.json}"

COOKIE_DIR="$(mktemp -d -t unorag-iso-cookies.XXXXXX)"
WORKDIR="$(mktemp -d -t unorag-iso-work.XXXXXX)"
RESULT_FILE="$WORKDIR/results.jsonl"
trap 'rm -rf "$COOKIE_DIR" "$WORKDIR"' EXIT

log() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }
fail() { warn "FAIL: $*"; write_report FAIL "$*"; exit 1; }
skip() { warn "BLOCKED/SKIP: $*"; write_report BLOCKED "$*"; exit 2; }

write_report() {
	local status="$1"
	local detail="$2"
	python3 - "$REPORT_JSON" "$status" "$detail" "$RC_SHA" "$BASE_URL" "$RESULT_FILE" <<'PY' || true
import json, sys, pathlib, time
out, status, detail, rc, base, results_path = sys.argv[1:7]
checks = []
p = pathlib.Path(results_path)
if p.exists():
	for line in p.read_text(encoding="utf-8").splitlines():
		line = line.strip()
		if line:
			checks.append(json.loads(line))
payload = {
	"suite": "S1/S2 isolation",
	"status": status,
	"detail": detail,
	"rc_sha": rc,
	"base_url": base,
	"finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
	"checks": checks,
}
pathlib.Path(out).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"report → {out}")
PY
}

record() {
	# record <id> <pass|fail> <note>
	python3 - "$RESULT_FILE" "$1" "$2" "$3" <<'PY'
import json, sys
path, cid, status, note = sys.argv[1:5]
with open(path, "a", encoding="utf-8") as f:
	f.write(json.dumps({"id": cid, "status": status, "note": note}, ensure_ascii=False) + "\n")
PY
}

json_get() {
	local file="$1"
	local expr="$2"
	python3 - "$file" "$expr" <<'PY'
import json, sys
path, expr = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
	obj = json.load(f)
cur = obj
for part in expr.split("."):
	if cur is None:
		break
	if isinstance(cur, dict):
		cur = cur.get(part)
	else:
		cur = None
		break
if cur is None:
	sys.exit(2)
print(cur)
PY
}

http_code() {
	local code
	code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$@" || true)"
	printf '%s' "$code"
}

require_cmds() {
	command -v curl >/dev/null 2>&1 || skip "curl is required"
	command -v python3 >/dev/null 2>&1 || skip "python3 is required"
	command -v node >/dev/null 2>&1 || skip "node is required for topology bootstrap"
}

login() {
	# login <label> <email> <workspace_id> → sets COOKIE_JAR_$label via nameref file
	local label="$1" email="$2" workspace_id="$3"
	local jar="$COOKIE_DIR/${label}.jar"
	local body="$WORKDIR/login-${label}.json"
	local code
	code="$(
		curl -sS -c "$jar" -b "$jar" \
			-o "$body" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d "{\"email\":\"${email}\",\"password\":\"${PASSWORD}\",\"workspace_id\":\"${workspace_id}\"}" \
			"$BASE_URL/api/auth/session" || true
	)"
	[[ "$code" == "200" ]] || fail "login $label HTTP $code $(head -c 300 "$body" 2>/dev/null || true)"
	eval "COOKIE_${label}=\"$jar\""
}

auth_curl() {
	local label="$1"
	shift
	local jar_var="COOKIE_${label}"
	local jar="${!jar_var}"
	curl -sS -c "$jar" -b "$jar" "$@"
}

wait_job() {
	local label="$1" job_id="$2" tag="$3"
	local started end status stage body code
	started="$(date +%s)"
	body="$WORKDIR/job-${job_id}.json"
	while true; do
		code="$(
			auth_curl "$label" -o "$body" -w '%{http_code}' \
				"$BASE_URL/api/jobs/${job_id}" || true
		)"
		[[ "$code" == "200" ]] || fail "GET job $job_id HTTP $code"
		status="$(json_get "$body" status || true)"
		stage="$(json_get "$body" stage || true)"
		log "  [$tag] status=$status stage=${stage:-?} elapsed=$(( $(date +%s) - started ))s"
		case "$status" in
			completed) return 0 ;;
			failed|dead|cancelled)
				fail "$tag job terminal status=$status $(head -c 500 "$body")"
				;;
		esac
		end="$(date +%s)"
		if (( end - started > JOB_TIMEOUT_SEC )); then
			fail "$tag job timed out after ${JOB_TIMEOUT_SEC}s (status=$status)"
		fi
		sleep "$POLL_INTERVAL_SEC"
	done
}

create_library() {
	local label="$1" name="$2" out="$3"
	local code
	code="$(
		auth_curl "$label" -o "$out" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d "{\"name\":\"${name}\"}" \
			"$BASE_URL/api/libraries" || true
	)"
	[[ "$code" == "200" || "$code" == "201" ]] \
		|| fail "create library ($label) HTTP $code $(head -c 300 "$out")"
}

upload_marker_doc() {
	local label="$1" lib_id="$2" marker="$3" out="$4"
	local file="$WORKDIR/${label}-marker.md"
	cat >"$file" <<EOF
# Isolation Marker Document (${label})

Unique isolation marker: \`${marker}\`.

This sentence exists only for S1/S2 cross-tenant / cross-workspace probes.
EOF
	local code
	code="$(
		auth_curl "$label" -o "$out" -w '%{http_code}' \
			-F "file=@${file};filename=${label}-marker.md;type=text/markdown" \
			-F "display_name=ISO ${label} Marker" \
			"$BASE_URL/api/libraries/${lib_id}/documents" || true
	)"
	[[ "$code" == "202" ]] || fail "upload ($label) HTTP $code $(head -c 400 "$out")"
}

create_service_key() {
	local label="$1" name="$2" out="$3"
	local code
	code="$(
		auth_curl "$label" -o "$out" -w '%{http_code}' \
			-H 'content-type: application/json' \
			-d "{\"name\":\"${name}\",\"scopes\":[\"ask\",\"retrieve\"]}" \
			"$BASE_URL/api/workspace/keys" || true
	)"
	[[ "$code" == "200" || "$code" == "201" ]] \
		|| fail "create service key ($label) HTTP $code $(head -c 300 "$out")"
}

# Neutral question — NEVER embed the foreign marker (model echo would false-positive).
ISOLATION_QUESTION='What unique isolation marker string appears in the documents? Reply with the exact marker token only.'
ISOLATION_RETRIEVE_QUERY='unique isolation marker string ISO_MARKER documents'

write_json_body() {
	# write_json_body <out> <kind:ask|retrieve> <library_id>
	local out="$1" kind="$2" lib_id="$3"
	python3 - "$out" "$kind" "$lib_id" "$ISOLATION_QUESTION" "$ISOLATION_RETRIEVE_QUERY" <<'PY'
import json, sys
out, kind, lib_id, question, query = sys.argv[1:6]
payload = {"library_id": lib_id}
if kind == "ask":
	payload["question"] = question
else:
	payload["query"] = query
with open(out, "w", encoding="utf-8") as f:
	json.dump(payload, f, ensure_ascii=False)
PY
}

# Returns 0 if marker appears in answer/citations/hits; 1 if clean miss; 3 if HTTP soft-fail.
# Checks answer + citations/hits only (not the whole envelope) to avoid echo false positives.
probe_no_marker() {
	local mode="$1" # session_ask | svc_ask | svc_retrieve
	local label_or_keyfile="$2"
	local lib_id="$3"
	local marker="$4"
	local out="$5"
	local code req="$WORKDIR/probe-req-$$.json"
	case "$mode" in
		session_ask)
			write_json_body "$req" ask "$lib_id"
			code="$(
				auth_curl "$label_or_keyfile" -o "$out" -w '%{http_code}' \
					-H 'content-type: application/json' \
					-d @"$req" \
					"$BASE_URL/api/rag/v1/ask" || true
			)"
			;;
		svc_ask)
			local key
			key="$(json_get "$label_or_keyfile" key)"
			write_json_body "$req" ask "$lib_id"
			code="$(
				curl -sS -o "$out" -w '%{http_code}' \
					-H 'content-type: application/json' \
					-H "authorization: Bearer ${key}" \
					-d @"$req" \
					"$BASE_URL/api/v1/ask" || true
			)"
			;;
		svc_retrieve)
			local key2
			key2="$(json_get "$label_or_keyfile" key)"
			write_json_body "$req" retrieve "$lib_id"
			code="$(
				curl -sS -o "$out" -w '%{http_code}' \
					-H 'content-type: application/json' \
					-H "authorization: Bearer ${key2}" \
					-d @"$req" \
					"$BASE_URL/api/v1/retrieve" || true
			)"
			;;
		*)
			fail "unknown probe mode $mode"
			;;
	esac
	if [[ "$code" == "503" || "$code" == "502" ]]; then
		return 3
	fi
	# Cross-library ID with foreign key may be 403/404 — that is isolation success.
	if [[ "$code" == "403" || "$code" == "404" ]]; then
		return 1
	fi
	[[ "$code" == "200" ]] || return 3
	python3 - "$out" "$marker" <<'PY'
import json, sys
path, marker = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
	data = json.load(f)
chunks = []
if isinstance(data.get("answer"), str):
	chunks.append(data["answer"])
for key in ("citations", "hits", "results", "items"):
	val = data.get(key)
	if isinstance(val, list):
		chunks.append(json.dumps(val, ensure_ascii=False))
nested = data.get("data")
if isinstance(nested, dict):
	for key in ("citations", "hits", "results", "items"):
		val = nested.get(key)
		if isinstance(val, list):
			chunks.append(json.dumps(val, ensure_ascii=False))
blob = "\n".join(chunks)
if marker in blob:
	sys.exit(0)
sys.exit(1)
PY
}

probe_has_marker() {
	local mode="$1" label_or_keyfile="$2" lib_id="$3" marker="$4" out="$5"
	set +e
	probe_no_marker "$mode" "$label_or_keyfile" "$lib_id" "$marker" "$out"
	local rc=$?
	set -e
	[[ $rc -eq 0 ]]
}

assert_no_leak() {
	local check_id="$1" mode="$2" actor="$3" lib_id="$4" marker="$5" out="$6"
	set +e
	probe_no_marker "$mode" "$actor" "$lib_id" "$marker" "$out"
	local rc=$?
	set -e
	if [[ $rc -eq 3 ]]; then
		skip "probe $check_id soft-failed (model/stack); body=$(head -c 200 "$out" 2>/dev/null || true)"
	fi
	if [[ $rc -eq 0 ]]; then
		record "$check_id" fail "marker leaked"
		fail "$check_id leaked marker via $mode"
	fi
	record "$check_id" pass "no marker (rc=$rc)"
	log "PASS $check_id"
}

# --- main ---
require_cmds

log "RC sha=$RC_SHA base=$BASE_URL"
HEALTH_CODE="$(http_code "$BASE_URL/api/rag/health")"
if [[ "$HEALTH_CODE" == "000" || -z "$HEALTH_CODE" ]]; then
	skip "edge/web not reachable at $BASE_URL (start Next+API+worker+Postgres+Qdrant)"
fi
if [[ "$HEALTH_CODE" != "200" ]]; then
	skip "health HTTP $HEALTH_CODE (want 200)"
fi

log "bootstrap isolation topology"
set +e
node "$ACC_DIR/bootstrap_isolation_topology.mjs" --out "$TOPOLOGY_JSON"
BOOT_RC=$?
set -e
if [[ $BOOT_RC -eq 2 ]]; then
	skip "topology bootstrap skipped (DATABASE_URL / pg)"
fi
[[ $BOOT_RC -eq 0 ]] || fail "topology bootstrap failed (exit $BOOT_RC)"

WS_A1="$(python3 -c "import json;print(json.load(open('$TOPOLOGY_JSON'))['workspaces']['A1']['id'])")"
WS_A2="$(python3 -c "import json;print(json.load(open('$TOPOLOGY_JSON'))['workspaces']['A2']['id'])")"
WS_B1="$(python3 -c "import json;print(json.load(open('$TOPOLOGY_JSON'))['workspaces']['B1']['id'])")"
USER_A1="$(python3 -c "import json;u=json.load(open('$TOPOLOGY_JSON'))['users'];print(next(x['id'] for x in u if x['email'].startswith('iso-a1-owner')))")"
USER_A1_VIEWER="$(python3 -c "import json;u=json.load(open('$TOPOLOGY_JSON'))['users'];print(next(x['id'] for x in u if x['email'].startswith('iso-a1-viewer')))")"

TOKEN="iso-$(date +%s)-$RANDOM"
MARKER_A1="ISO_MARKER_A1_${TOKEN}"
MARKER_A2="ISO_MARKER_A2_${TOKEN}"
MARKER_B1="ISO_MARKER_B1_${TOKEN}"
MARKER_REST="ISO_MARKER_RESTRICTED_${TOKEN}"

log "login principals"
login A1 "iso-a1-owner@unorag.isolation.test" "$WS_A1"
login A1V "iso-a1-viewer@unorag.isolation.test" "$WS_A1"
login A2 "iso-a2-owner@unorag.isolation.test" "$WS_A2"
login B1 "iso-b1-owner@unorag.isolation.test" "$WS_B1"

# --- provision libraries + docs + keys ---
LIB_A1_BODY="$WORKDIR/lib_a1.json"
LIB_A2_BODY="$WORKDIR/lib_a2.json"
LIB_B1_BODY="$WORKDIR/lib_b1.json"
create_library A1 "ISO Lib A1 $TOKEN" "$LIB_A1_BODY"
create_library A2 "ISO Lib A2 $TOKEN" "$LIB_A2_BODY"
create_library B1 "ISO Lib B1 $TOKEN" "$LIB_B1_BODY"
LIB_A1="$(json_get "$LIB_A1_BODY" id)"
LIB_A2="$(json_get "$LIB_A2_BODY" id)"
LIB_B1="$(json_get "$LIB_B1_BODY" id)"

UP_A1="$WORKDIR/up_a1.json"
UP_A2="$WORKDIR/up_a2.json"
UP_B1="$WORKDIR/up_b1.json"
UP_REST="$WORKDIR/up_rest.json"
upload_marker_doc A1 "$LIB_A1" "$MARKER_A1" "$UP_A1"
upload_marker_doc A2 "$LIB_A2" "$MARKER_A2" "$UP_A2"
upload_marker_doc B1 "$LIB_B1" "$MARKER_B1" "$UP_B1"
upload_marker_doc A1 "$LIB_A1" "$MARKER_REST" "$UP_REST"

DOC_A1="$(json_get "$UP_A1" document_id)"
DOC_A2="$(json_get "$UP_A2" document_id)"
DOC_B1="$(json_get "$UP_B1" document_id)"
DOC_REST="$(json_get "$UP_REST" document_id)"
JOB_A1="$(json_get "$UP_A1" job_id)"
JOB_A2="$(json_get "$UP_A2" job_id)"
JOB_B1="$(json_get "$UP_B1" job_id)"
JOB_REST="$(json_get "$UP_REST" job_id)"

wait_job A1 "$JOB_A1" "ingest-A1"
wait_job A2 "$JOB_A2" "ingest-A2"
wait_job B1 "$JOB_B1" "ingest-B1"
wait_job A1 "$JOB_REST" "ingest-restricted"

KEY_A1="$WORKDIR/key_a1.json"
KEY_A2="$WORKDIR/key_a2.json"
KEY_B1="$WORKDIR/key_b1.json"
create_service_key A1 "iso-a1-$TOKEN" "$KEY_A1"
create_service_key A2 "iso-a2-$TOKEN" "$KEY_A2"
create_service_key B1 "iso-b1-$TOKEN" "$KEY_B1"

# Positive controls (own marker) — if these fail soft, stack cannot validate isolation.
POS="$WORKDIR/pos.json"
set +e
probe_has_marker session_ask A1 "$LIB_A1" "$MARKER_A1" "$POS"
POS_RC=$?
set -e
if [[ $POS_RC -ne 0 ]]; then
	# Distinguish refuse/embedding vs hard error
	if grep -q '"refused"[[:space:]]*:[[:space:]]*true' "$POS" 2>/dev/null; then
		skip "positive A1 ask refused — configure live embedding/LLM (ASK_MODE/EMBEDDING_MODEL) for S1/S2"
	fi
	skip "positive A1 ask missing own marker — ingestion/retrieval not ready for isolation probe"
fi
record "S2.positive_A1" pass "own marker visible"
log "PASS S2.positive_A1 (own marker)"

# --- S2: A1 must not see A2 / B1 markers (session + Mode B) ---
assert_no_leak "S2.A1_session_no_A2" session_ask A1 "$LIB_A1" "$MARKER_A2" "$WORKDIR/s2_a1_a2.json"
assert_no_leak "S2.A1_session_no_B1" session_ask A1 "$LIB_A1" "$MARKER_B1" "$WORKDIR/s2_a1_b1.json"
assert_no_leak "S2.A1_svc_ask_no_A2" svc_ask "$KEY_A1" "$LIB_A1" "$MARKER_A2" "$WORKDIR/s2_a1_svc_a2.json"
assert_no_leak "S2.A1_svc_retrieve_no_A2" svc_retrieve "$KEY_A1" "$LIB_A1" "$MARKER_A2" "$WORKDIR/s2_a1_ret_a2.json"
assert_no_leak "S2.A2_session_no_A1" session_ask A2 "$LIB_A2" "$MARKER_A1" "$WORKDIR/s2_a2_a1.json"

# Foreign library_id with A1 key must not grant A2/B1 access
assert_no_leak "S2.A1_key_foreign_lib_A2" svc_ask "$KEY_A1" "$LIB_A2" "$MARKER_A2" "$WORKDIR/s2_a1_foreign_a2.json"
assert_no_leak "S2.A1_key_foreign_lib_B1" svc_retrieve "$KEY_A1" "$LIB_B1" "$MARKER_B1" "$WORKDIR/s2_a1_foreign_b1.json"

# --- S1: Org B must not see Org A ---
assert_no_leak "S1.B1_session_no_A1" session_ask B1 "$LIB_B1" "$MARKER_A1" "$WORKDIR/s1_b1_a1.json"
assert_no_leak "S1.B1_svc_ask_no_A1" svc_ask "$KEY_B1" "$LIB_B1" "$MARKER_A1" "$WORKDIR/s1_b1_svc_a1.json"
assert_no_leak "S1.B1_key_foreign_lib_A1" svc_ask "$KEY_B1" "$LIB_A1" "$MARKER_A1" "$WORKDIR/s1_b1_foreign_a1.json"

# --- Non-query IDOR: document / library / archive ---
# Note: single-doc/library routes expose DELETE/PATCH (not GET); 405 on GET is expected.
log "IDOR probes (document / library / archive)"
IDOR_LIST="$WORKDIR/idor_libs.json"
IDOR_LIST_CODE="$(
	auth_curl B1 -o "$IDOR_LIST" -w '%{http_code}' \
		"$BASE_URL/api/libraries" || true
)"
[[ "$IDOR_LIST_CODE" == "200" ]] || fail "B1 list libraries HTTP $IDOR_LIST_CODE"
python3 - "$IDOR_LIST" "$LIB_A1" "$LIB_A2" <<'PY' || fail "B1 library list leaked Org A library id"
import json, sys
path, *forbidden = sys.argv[1:]
with open(path, encoding="utf-8") as f:
	data = json.load(f)
rows = data if isinstance(data, list) else data.get("libraries") or data.get("items") or []
ids = {str(r.get("id") or "") for r in rows if isinstance(r, dict)}
for lib in forbidden:
	if lib in ids:
		sys.stderr.write(f"leaked library_id={lib}\n")
		sys.exit(1)
print("list ok")
PY
record "S1.idor_library_list" pass "A1/A2 libs absent from B1 list"
log "PASS S1.idor_library_list"

IDOR_DOC="$WORKDIR/idor_doc.json"
IDOR_CODE="$(
	auth_curl B1 -o "$IDOR_DOC" -w '%{http_code}' -X DELETE \
		"$BASE_URL/api/libraries/${LIB_A1}/documents/${DOC_A1}" || true
)"
if [[ "$IDOR_CODE" == "200" || "$IDOR_CODE" == "202" ]]; then
	record "S1.idor_document_delete" fail "B1 deleted A1 document"
	fail "B1 could DELETE A1 document (HTTP $IDOR_CODE)"
fi
record "S1.idor_document_delete" pass "HTTP $IDOR_CODE"
log "PASS S1.idor_document_delete (HTTP $IDOR_CODE)"

IDOR_LIB="$WORKDIR/idor_lib.json"
IDOR_LIB_CODE="$(
	auth_curl B1 -o "$IDOR_LIB" -w '%{http_code}' -X PATCH \
		-H 'content-type: application/json' \
		-d '{"name":"idor-should-fail"}' \
		"$BASE_URL/api/libraries/${LIB_A1}" || true
)"
if [[ "$IDOR_LIB_CODE" == "200" ]]; then
	record "S1.idor_library_patch" fail "B1 patched A1 library"
	fail "B1 could PATCH A1 library (HTTP 200)"
fi
record "S1.idor_library_patch" pass "HTTP $IDOR_LIB_CODE"
log "PASS S1.idor_library_patch (HTTP $IDOR_LIB_CODE)"

# Archive listing via session — must not include foreign markers if any turns exist.
# Temp asks are not persisted; still verify endpoint does not 500 and returns array.
ARCH="$WORKDIR/archive_b1.json"
ARCH_CODE="$(
	auth_curl B1 -o "$ARCH" -w '%{http_code}' \
		"$BASE_URL/api/rag/v1/archive" || true
)"
[[ "$ARCH_CODE" == "200" || "$ARCH_CODE" == "401" || "$ARCH_CODE" == "404" ]] \
	|| fail "archive probe unexpected HTTP $ARCH_CODE"
if [[ "$ARCH_CODE" == "200" ]] && grep -q "$MARKER_A1" "$ARCH"; then
	record "S1.idor_archive" fail "A1 marker in B1 archive"
	fail "B1 archive payload contains A1 marker"
fi
record "S1.idor_archive" pass "HTTP $ARCH_CODE no A1 marker"
log "PASS S1.idor_archive"

# Trace-style debug: archive/{id}/debug should 404 for random foreign id
TRACE="$WORKDIR/trace.json"
TRACE_CODE="$(
	auth_curl B1 -o "$TRACE" -w '%{http_code}' \
		"$BASE_URL/api/rag/v1/archive/${DOC_A1}/debug" || true
)"
if [[ "$TRACE_CODE" == "200" ]]; then
	record "S1.idor_trace_debug" fail "unexpected 200"
	fail "B1 got archive debug for foreign id"
fi
record "S1.idor_trace_debug" pass "HTTP $TRACE_CODE"
log "PASS S1.idor_trace_debug (HTTP $TRACE_CODE)"

# --- Restricted ACL ---
log "restricted ACL: only A1 owner principal"
ACL_BODY="$WORKDIR/acl.json"
ACL_CODE="$(
	auth_curl A1 -o "$ACL_BODY" -w '%{http_code}' \
		-X PUT -H 'content-type: application/json' \
		-d "{\"scope\":\"restricted\",\"principal_ids\":[\"${USER_A1}\"]}" \
		"$BASE_URL/api/libraries/${LIB_A1}/documents/${DOC_REST}/acl" || true
)"
[[ "$ACL_CODE" == "200" ]] || fail "ACL update HTTP $ACL_CODE $(head -c 300 "$ACL_BODY")"
PROJ="$(json_get "$ACL_BODY" projection || true)"
if [[ "$PROJ" == "reindex_required" ]]; then
	REIDX="$WORKDIR/reidx.json"
	REIDX_CODE="$(
		auth_curl A1 -o "$REIDX" -w '%{http_code}' \
			-X POST -H 'content-type: application/json' -d '{}' \
			"$BASE_URL/api/libraries/${LIB_A1}/documents/${DOC_REST}/reindex" || true
	)"
	[[ "$REIDX_CODE" == "202" || "$REIDX_CODE" == "200" ]] \
		|| fail "reindex after ACL HTTP $REIDX_CODE"
	REIDX_JOB="$(json_get "$REIDX" job_id 2>/dev/null || true)"
	if [[ -n "${REIDX_JOB:-}" ]]; then
		wait_job A1 "$REIDX_JOB" "acl-reindex"
	fi
fi

# Viewer must not see restricted marker; owner must.
assert_no_leak "S3.viewer_no_restricted" session_ask A1V "$LIB_A1" "$MARKER_REST" "$WORKDIR/s3_viewer.json"
set +e
probe_has_marker session_ask A1 "$LIB_A1" "$MARKER_REST" "$WORKDIR/s3_owner.json"
OWN_RC=$?
set -e
if [[ $OWN_RC -ne 0 ]]; then
	skip "restricted owner positive control missing marker after ACL (embedding/ACL projection)"
fi
record "S3.owner_has_restricted" pass "owner still sees marker"
log "PASS S3.owner_has_restricted"

# --- Lifecycle smoke: replace + delete on A2 doc (API-level) ---
log "lifecycle: replace + delete on A2 document"
V2="$WORKDIR/a2-v2.md"
cat >"$V2" <<EOF
# Isolation Marker Document (A2 v2)
Unique isolation marker: \`${MARKER_A2}\`.
Version two body.
EOF
REP="$WORKDIR/replace.json"
REP_CODE="$(
	auth_curl A2 -o "$REP" -w '%{http_code}' \
		-F "file=@${V2};filename=a2-v2.md;type=text/markdown" \
		"$BASE_URL/api/libraries/${LIB_A2}/documents/${DOC_A2}/versions" || true
)"
[[ "$REP_CODE" == "202" ]] || fail "replace HTTP $REP_CODE $(head -c 300 "$REP")"
wait_job A2 "$(json_get "$REP" job_id)" "replace-A2"
record "S2.replace_A2" pass "ok"

DEL="$WORKDIR/delete.json"
DEL_CODE="$(
	auth_curl A2 -o "$DEL" -w '%{http_code}' -X DELETE \
		"$BASE_URL/api/libraries/${LIB_A2}/documents/${DOC_A2}" || true
)"
[[ "$DEL_CODE" == "202" || "$DEL_CODE" == "200" ]] \
	|| fail "delete HTTP $DEL_CODE $(head -c 300 "$DEL")"
record "S2.delete_A2" pass "HTTP $DEL_CODE"
log "PASS S2.replace_A2 / S2.delete_A2"

# After delete, A2 must not surface marker (best-effort; may need job completion)
DEL_JOB="$(json_get "$DEL" job_id 2>/dev/null || true)"
if [[ -n "${DEL_JOB:-}" ]]; then
	set +e
	wait_job A2 "$DEL_JOB" "delete-A2"
	set -e
fi
assert_no_leak "S2.post_delete_no_A2_marker" session_ask A2 "$LIB_A2" "$MARKER_A2" "$WORKDIR/s2_post_del.json"

if [[ "$KEEP_TOPOLOGY" != "1" ]]; then
	log "cleanup topology (set UNORAG_ISOLATION_KEEP=1 to retain)"
	set +e
	node "$ACC_DIR/bootstrap_isolation_topology.mjs" --cleanup --out "$TOPOLOGY_JSON"
	set -e
fi

write_report PASS "all S1/S2 automated probes passed"
log "S1/S2 isolation PASS (rc_sha=$RC_SHA)"
exit 0
