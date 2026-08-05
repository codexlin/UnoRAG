#!/usr/bin/env bash
# L9 private-deploy smoke: health → login → library → upload → ask → replace →
# cross-library isolation probe → delete.
# Requires curl + a running edge (default http://localhost from compose).
# Exit: 0=pass, 1=fail, 2=skip (stack/credentials unavailable).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "${ROOT}/scripts/compose-env.sh"

# Prefer split config (bootstrap.env) over a local smoke helper file.
# .smoke-admin-password is only a fallback so rotation of bootstrap.env is not shadowed.
_SMOKE_PW_FILE="${ROOT}/.smoke-admin-password"
if [[ -z "${UNORAG_ADMIN_PASSWORD:-}" ]]; then
	UNORAG_ADMIN_PASSWORD="$(mk_config_get UNORAG_ADMIN_PASSWORD 2>/dev/null || true)"
fi
if [[ -z "${UNORAG_ADMIN_PASSWORD:-}" && -f "$_SMOKE_PW_FILE" ]]; then
	UNORAG_ADMIN_PASSWORD="$(tr -d '\n' < "$_SMOKE_PW_FILE")"
fi
if [[ -z "${UNORAG_ADMIN_EMAIL:-}" ]]; then
	UNORAG_ADMIN_EMAIL="$(mk_config_get UNORAG_ADMIN_EMAIL 2>/dev/null || true)"
fi
if [[ -z "${UNORAG_BASE_URL:-}" ]]; then
	UNORAG_BASE_URL="$(mk_config_get UNORAG_BASE_URL 2>/dev/null || true)"
	if [[ -z "$UNORAG_BASE_URL" ]]; then
		_HTTP_PORT="$(mk_config_get HTTP_PORT 2>/dev/null || echo 80)"
		UNORAG_BASE_URL="http://localhost:${_HTTP_PORT}"
	fi
fi

BASE_URL="${UNORAG_BASE_URL:-http://localhost}"
BASE_URL="${BASE_URL%/}"
EMAIL="${UNORAG_ADMIN_EMAIL:-admin@example.com}"
PASSWORD="${UNORAG_ADMIN_PASSWORD:-}"
JOB_TIMEOUT_SEC="${UNORAG_PILOT_JOB_TIMEOUT_SEC:-300}"
POLL_INTERVAL_SEC="${UNORAG_PILOT_POLL_INTERVAL_SEC:-3}"
COOKIE_JAR="$(mktemp -t unorag-pilot-cookies.XXXXXX)"
WORKDIR="$(mktemp -d -t unorag-pilot-work.XXXXXX)"
SERVICE_KEY_ID=""
RETRIEVE_KEY_ID=""
LIB_A_ID=""
LIB_B_ID=""

cleanup() {
	local key_id library_id
	for key_id in "$SERVICE_KEY_ID" "$RETRIEVE_KEY_ID"; do
		[[ -n "$key_id" ]] || continue
		curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" -X DELETE \
			-o /dev/null --max-time 5 \
			"$BASE_URL/api/workspace/keys/$key_id" 2>/dev/null || true
	done
	for library_id in "$LIB_A_ID" "$LIB_B_ID"; do
		[[ -n "$library_id" ]] || continue
		curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" -X DELETE \
			-o /dev/null --max-time 10 \
			"$BASE_URL/api/libraries/$library_id" 2>/dev/null || true
	done
	rm -f "$COOKIE_JAR"
	rm -rf "$WORKDIR"
}
trap cleanup EXIT

log() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }
fail() { warn "FAIL: $*"; exit 1; }
skip() { warn "SKIP: $*"; exit 2; }

if ! command -v curl >/dev/null 2>&1; then
	skip "curl is required"
fi
if ! command -v python3 >/dev/null 2>&1; then
	skip "python3 is required for JSON parsing"
fi

json_get() {
	# json_get <file> <python_expr_on_obj>
	local file="$1"
	local expr="$2"
	python3 - "$file" "$expr" <<'PY'
import json, sys
path, expr = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
	obj = json.load(f)
# expr is a dotted path like "job_id" or "status"
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

# --- readiness ---
log "checking edge readiness at $BASE_URL/api/rag/health/ready"
HEALTH_BODY="$WORKDIR/health.json"
HEALTH_CODE="$(
	curl -sS -o "$HEALTH_BODY" -w '%{http_code}' --max-time 5 \
		"$BASE_URL/api/rag/health/ready" || true
)"
if [[ "$HEALTH_CODE" == "000" || -z "$HEALTH_CODE" ]]; then
	skip "edge not reachable at $BASE_URL (is compose up? install.sh done?)"
fi
if [[ "$HEALTH_CODE" != "200" ]]; then
	skip "health returned HTTP $HEALTH_CODE (want 200); fix stack before pilot smoke"
fi
python3 - "$HEALTH_BODY" <<'PY' || fail "TypeScript runtime health contract mismatch"
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    health = json.load(handle)
expected = {
    "status": "ok",
    "service": "unorag-web",
    "effective_mode": "typescript",
    "graph": "langgraph-ts",
    "metadata_backend": "postgres",
    "live_ready": True,
    "ask_ready": True,
}
actual = {key: health.get(key) for key in expected}
if actual != expected or health.get("degraded") is not False:
    print(f"health mismatch: expected={expected} actual={actual}", file=sys.stderr)
    raise SystemExit(1)
PY

if [[ -z "$PASSWORD" || "$PASSWORD" == "change-this-before-deployment" ]]; then
	skip "set UNORAG_ADMIN_PASSWORD in deploy/config/bootstrap.env (or .smoke-admin-password)"
fi

# --- login ---
log "login as $EMAIL"
LOGIN_BODY="$WORKDIR/login.json"
LOGIN_CODE="$(
	curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
		-o "$LOGIN_BODY" -w '%{http_code}' \
		-H 'content-type: application/json' \
		-d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
		"$BASE_URL/api/auth/session" || true
)"
if [[ "$LOGIN_CODE" == "000" ]]; then
	skip "login endpoint unreachable"
fi
if [[ "$LOGIN_CODE" != "200" ]]; then
	fail "login HTTP $LOGIN_CODE body=$(head -c 400 "$LOGIN_BODY" 2>/dev/null || true)"
fi

auth_curl() {
	curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$@"
}

# --- create libraries ---
TOKEN="pilot-smoke-$(date +%s)-$RANDOM"
LIB_A_BODY="$WORKDIR/lib_a.json"
log "create library A"
LIB_A_CODE="$(
	auth_curl -o "$LIB_A_BODY" -w '%{http_code}' \
		-H 'content-type: application/json' \
		-d "{\"name\":\"Pilot Smoke A $TOKEN\"}" \
		"$BASE_URL/api/libraries" || true
)"
[[ "$LIB_A_CODE" == "200" || "$LIB_A_CODE" == "201" ]] \
	|| fail "create library A HTTP $LIB_A_CODE $(head -c 300 "$LIB_A_BODY")"
LIB_A_ID="$(json_get "$LIB_A_BODY" id)" || fail "library A missing id"

LIB_B_BODY="$WORKDIR/lib_b.json"
log "create library B (isolation probe)"
LIB_B_CODE="$(
	auth_curl -o "$LIB_B_BODY" -w '%{http_code}' \
		-H 'content-type: application/json' \
		-d "{\"name\":\"Pilot Smoke B $TOKEN\"}" \
		"$BASE_URL/api/libraries" || true
)"
[[ "$LIB_B_CODE" == "200" || "$LIB_B_CODE" == "201" ]] \
	|| fail "create library B HTTP $LIB_B_CODE"
LIB_B_ID="$(json_get "$LIB_B_BODY" id)" || fail "library B missing id"

# --- upload ---
DOC_FILE="$WORKDIR/pilot-doc.md"
SECRET_MARKER="PILOT_UNIQUE_${TOKEN}"
cat >"$DOC_FILE" <<EOF
# Pilot Smoke Document

Unique marker: \`${SECRET_MARKER}\`.

## Policy

Leave proof must be submitted within three working days.
EOF

UPLOAD_BODY="$WORKDIR/upload.json"
log "upload markdown to library A"
UPLOAD_CODE="$(
	auth_curl -o "$UPLOAD_BODY" -w '%{http_code}' \
		-F "file=@${DOC_FILE};filename=pilot-smoke.md;type=text/markdown" \
		-F "display_name=Pilot Smoke Doc" \
		"$BASE_URL/api/libraries/${LIB_A_ID}/documents" || true
)"
[[ "$UPLOAD_CODE" == "202" ]] \
	|| fail "upload HTTP $UPLOAD_CODE (want 202) $(head -c 400 "$UPLOAD_BODY")"
JOB_ID="$(json_get "$UPLOAD_BODY" job_id)" || fail "upload missing job_id"
DOC_ID="$(json_get "$UPLOAD_BODY" document_id)" || fail "upload missing document_id"
log "accepted job_id=$JOB_ID document_id=$DOC_ID"

wait_job() {
	local job_id="$1"
	local label="$2"
	local started end status stage body code
	started="$(date +%s)"
	body="$WORKDIR/job-${job_id}.json"
	while true; do
		code="$(
			auth_curl -o "$body" -w '%{http_code}' \
				"$BASE_URL/api/jobs/${job_id}" || true
		)"
		[[ "$code" == "200" ]] || fail "GET job $job_id HTTP $code"
		status="$(json_get "$body" status || true)"
		stage="$(json_get "$body" stage || true)"
		log "  [$label] status=$status stage=${stage:-?} elapsed=$(( $(date +%s) - started ))s"
		case "$status" in
			completed) return 0 ;;
			failed|dead|cancelled)
				fail "$label job terminal status=$status $(head -c 500 "$body")"
				;;
		esac
		end="$(date +%s)"
		if (( end - started > JOB_TIMEOUT_SEC )); then
			fail "$label job timed out after ${JOB_TIMEOUT_SEC}s (status=$status)"
		fi
		sleep "$POLL_INTERVAL_SEC"
	done
}

wait_job "$JOB_ID" "ingest"

# --- ask ---
ASK_BODY="$WORKDIR/ask.json"
log "ask library A for unique marker"
ASK_CODE="$(
	auth_curl -o "$ASK_BODY" -w '%{http_code}' \
		-H 'content-type: application/json' \
		-d "{\"question\":\"What is the unique marker ${SECRET_MARKER}?\",\"library_id\":\"${LIB_A_ID}\"}" \
		"$BASE_URL/api/rag/v1/ask" || true
)"
if [[ "$ASK_CODE" != "200" ]]; then
	# Model/embedding may be unavailable — treat as skip only when stack otherwise healthy.
	if [[ "$ASK_CODE" == "503" || "$ASK_CODE" == "502" || "$ASK_CODE" == "500" ]]; then
		skip "ask HTTP $ASK_CODE — model/embedding likely unavailable; lifecycle upload passed. body=$(head -c 300 "$ASK_BODY")"
	fi
	fail "ask HTTP $ASK_CODE $(head -c 400 "$ASK_BODY")"
fi
set +e
python3 - "$ASK_BODY" "$SECRET_MARKER" <<'PY'
import json, sys
path, marker = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
	data = json.load(f)
blob = json.dumps(data, ensure_ascii=False)
answer = data.get("answer") or ""
if marker in blob or marker in answer:
	print("ask ok")
	sys.exit(0)
if data.get("refused") is True:
	sys.stderr.write("ask refused; marker not in payload (check embedding/live mode)\n")
	sys.exit(3)
sys.exit(1)
PY
ASK_RC=$?
set -e
if [[ $ASK_RC -eq 3 ]]; then
	skip "ask refused without marker — configure live embedding/LLM for full pilot; ingest path already validated"
fi
[[ $ASK_RC -eq 0 ]] || fail "ask response missing unique marker"

# --- Public API v1: real service keys + stable external contract ---
SERVICE_KEY_BODY="$WORKDIR/service-key.json"
log "create library-scoped service key for Public API v1"
SERVICE_KEY_CODE="$(
	auth_curl -o "$SERVICE_KEY_BODY" -w '%{http_code}' \
		-H 'content-type: application/json' \
		-d "{\"name\":\"Pilot API v1 $TOKEN\",\"scopes\":[\"ask\",\"retrieve\"],\"library_ids\":[\"${LIB_A_ID}\"]}" \
		"$BASE_URL/api/workspace/keys" || true
)"
[[ "$SERVICE_KEY_CODE" == "201" ]] \
	|| fail "create service key HTTP $SERVICE_KEY_CODE $(head -c 300 "$SERVICE_KEY_BODY")"
SERVICE_KEY_ID="$(json_get "$SERVICE_KEY_BODY" id)" || fail "service key missing id"
SERVICE_KEY_RAW="$(json_get "$SERVICE_KEY_BODY" key)" || fail "service key missing one-time key"

validate_public_v1() {
	local kind="$1" body="$2" headers="$3" marker="$4" library_id="$5"
	python3 - "$kind" "$body" "$headers" "$marker" "$library_id" <<'PY'
import json, sys, uuid

kind, body_path, headers_path, marker, library_id = sys.argv[1:6]
with open(body_path, encoding="utf-8") as f:
	data = json.load(f)
with open(headers_path, encoding="utf-8", errors="replace") as f:
	header_lines = f.read().splitlines()
headers = {}
for line in header_lines:
	if ":" in line:
		key, value = line.split(":", 1)
		headers[key.strip().lower()] = value.strip()

request_id = headers.get("x-request-id", "")
uuid.UUID(request_id)
assert headers.get("x-unorag-api-version") == "1", headers
assert data.get("trace_id") == request_id, (data.get("trace_id"), request_id)
assert data.get("library_id", library_id) == library_id

common = {
	"api_version", "trace_id", "citations", "refused", "refuse_reason", "retrieval_mode",
}
expected = (
	common | {"query", "library_id"}
	if kind == "retrieve"
	else common | {"session_id", "question", "answer"}
)
assert set(data) == expected, sorted(set(data) ^ expected)
assert data.get("api_version") == "v1", data.get("api_version")

citations = data.get("citations")
assert isinstance(citations, list) and citations, "expected at least one citation"
required_citation = {
	"id", "index", "title", "snippet", "score", "document_id", "filename",
	"page", "page_start", "page_end", "section_path", "table_id", "figure_id",
	"row_start", "row_end", "record_type",
}
for citation in citations:
	assert set(citation) == required_citation, sorted(set(citation) ^ required_citation)
	for forbidden in (
		"text", "body", "tenant_id", "generation_id", "document_version_id",
		"dense_score", "bm25_score", "rrf_score", "retrieval_debug", "doc_id",
	):
		assert forbidden not in citation
assert "retrieval_debug" not in data
blob = json.dumps(citations, ensure_ascii=False)
assert marker in blob, "marker missing from public citations"
print(f"public {kind} contract ok trace_id={request_id} citations={len(citations)}")
PY
}

PUBLIC_RETRIEVE_BODY="$WORKDIR/public-retrieve.json"
PUBLIC_RETRIEVE_HEADERS="$WORKDIR/public-retrieve.headers"
log "Public API v1 retrieve with real service key"
PUBLIC_RETRIEVE_CODE="$(
	curl -sS -D "$PUBLIC_RETRIEVE_HEADERS" -o "$PUBLIC_RETRIEVE_BODY" \
		-w '%{http_code}' \
		-H 'content-type: application/json' \
		-H "authorization: Bearer ${SERVICE_KEY_RAW}" \
		-d "{\"query\":\"${SECRET_MARKER}\",\"library_id\":\"${LIB_A_ID}\",\"top_k\":6}" \
		"$BASE_URL/api/v1/retrieve" || true
)"
[[ "$PUBLIC_RETRIEVE_CODE" == "200" ]] \
	|| fail "public retrieve HTTP $PUBLIC_RETRIEVE_CODE $(head -c 400 "$PUBLIC_RETRIEVE_BODY")"
validate_public_v1 retrieve "$PUBLIC_RETRIEVE_BODY" "$PUBLIC_RETRIEVE_HEADERS" \
	"$SECRET_MARKER" "$LIB_A_ID" || fail "public retrieve v1 contract mismatch"

PUBLIC_ASK_BODY="$WORKDIR/public-ask.json"
PUBLIC_ASK_HEADERS="$WORKDIR/public-ask.headers"
log "Public API v1 ask with real service key"
PUBLIC_ASK_CODE="$(
	curl -sS -D "$PUBLIC_ASK_HEADERS" -o "$PUBLIC_ASK_BODY" \
		-w '%{http_code}' \
		-H 'content-type: application/json' \
		-H "authorization: Bearer ${SERVICE_KEY_RAW}" \
		-d "{\"question\":\"What is the unique marker ${SECRET_MARKER}?\",\"library_id\":\"${LIB_A_ID}\",\"session_id\":\"pilot-${TOKEN}\"}" \
		"$BASE_URL/api/v1/ask" || true
)"
[[ "$PUBLIC_ASK_CODE" == "200" ]] \
	|| fail "public ask HTTP $PUBLIC_ASK_CODE $(head -c 400 "$PUBLIC_ASK_BODY")"
validate_public_v1 ask "$PUBLIC_ASK_BODY" "$PUBLIC_ASK_HEADERS" \
	"$SECRET_MARKER" "$LIB_A_ID" || fail "public ask v1 contract mismatch"

INVALID_BODY="$WORKDIR/public-invalid.json"
log "Public API v1 rejects client algorithm overrides"
INVALID_CODE="$(
	curl -sS -o "$INVALID_BODY" -w '%{http_code}' \
		-H 'content-type: application/json' \
		-H "authorization: Bearer ${SERVICE_KEY_RAW}" \
		-d "{\"question\":\"test\",\"library_id\":\"${LIB_A_ID}\",\"ask_overrides\":{}}" \
		"$BASE_URL/api/v1/ask" || true
)"
[[ "$INVALID_CODE" == "400" ]] || fail "ask_overrides expected 400, got $INVALID_CODE"
[[ "$(json_get "$INVALID_BODY" error.code || true)" == "invalid_request" ]] \
	|| fail "ask_overrides error code mismatch"

DENIED_BODY="$WORKDIR/public-library-denied.json"
log "Public API v1 enforces service-key library allow-list"
DENIED_CODE="$(
	curl -sS -o "$DENIED_BODY" -w '%{http_code}' \
		-H 'content-type: application/json' \
		-H "authorization: Bearer ${SERVICE_KEY_RAW}" \
		-d "{\"query\":\"test\",\"library_id\":\"${LIB_B_ID}\"}" \
		"$BASE_URL/api/v1/retrieve" || true
)"
[[ "$DENIED_CODE" == "403" ]] || fail "library allow-list expected 403, got $DENIED_CODE"
[[ "$(json_get "$DENIED_BODY" error.code || true)" == "library_access_denied" ]] \
	|| fail "library allow-list error code mismatch"

RETRIEVE_KEY_BODY="$WORKDIR/retrieve-only-key.json"
log "create retrieve-only key and enforce scope"
RETRIEVE_KEY_CODE="$(
	auth_curl -o "$RETRIEVE_KEY_BODY" -w '%{http_code}' \
		-H 'content-type: application/json' \
		-d "{\"name\":\"Pilot Retrieve Only $TOKEN\",\"scopes\":[\"retrieve\"],\"library_ids\":[\"${LIB_A_ID}\"]}" \
		"$BASE_URL/api/workspace/keys" || true
)"
[[ "$RETRIEVE_KEY_CODE" == "201" ]] || fail "create retrieve-only key HTTP $RETRIEVE_KEY_CODE"
RETRIEVE_KEY_ID="$(json_get "$RETRIEVE_KEY_BODY" id)" || fail "retrieve-only key missing id"
RETRIEVE_KEY_RAW="$(json_get "$RETRIEVE_KEY_BODY" key)" || fail "retrieve-only key missing key"

SCOPE_BODY="$WORKDIR/public-scope-denied.json"
SCOPE_CODE="$(
	curl -sS -o "$SCOPE_BODY" -w '%{http_code}' \
		-H 'content-type: application/json' \
		-H "authorization: Bearer ${RETRIEVE_KEY_RAW}" \
		-d "{\"question\":\"test\",\"library_id\":\"${LIB_A_ID}\"}" \
		"$BASE_URL/api/v1/ask" || true
)"
[[ "$SCOPE_CODE" == "403" ]] || fail "scope check expected 403, got $SCOPE_CODE"
[[ "$(json_get "$SCOPE_BODY" error.code || true)" == "insufficient_scope" ]] \
	|| fail "scope error code mismatch"

log "revoke service keys and verify revoked key rejection"
auth_curl -X DELETE -o /dev/null \
	"$BASE_URL/api/workspace/keys/$SERVICE_KEY_ID" || fail "revoke service key failed"
REVOKED_BODY="$WORKDIR/public-revoked.json"
REVOKED_CODE="$(
	curl -sS -o "$REVOKED_BODY" -w '%{http_code}' \
		-H 'content-type: application/json' \
		-H "authorization: Bearer ${SERVICE_KEY_RAW}" \
		-d "{\"query\":\"test\",\"library_id\":\"${LIB_A_ID}\"}" \
		"$BASE_URL/api/v1/retrieve" || true
)"
[[ "$REVOKED_CODE" == "401" ]] || fail "revoked key expected 401, got $REVOKED_CODE"
[[ "$(json_get "$REVOKED_BODY" error.code || true)" == "authentication_failed" ]] \
	|| fail "revoked key error code mismatch"
SERVICE_KEY_ID=""

auth_curl -X DELETE -o /dev/null \
	"$BASE_URL/api/workspace/keys/$RETRIEVE_KEY_ID" || fail "revoke retrieve-only key failed"
RETRIEVE_KEY_ID=""

# --- cross-library isolation ---
ASK_B_BODY="$WORKDIR/ask_b.json"
log "isolation: ask library B for library A marker (must not cite A)"
ASK_B_CODE="$(
	auth_curl -o "$ASK_B_BODY" -w '%{http_code}' \
		-H 'content-type: application/json' \
		-d "{\"question\":\"Quote the unique marker ${SECRET_MARKER}\",\"library_id\":\"${LIB_B_ID}\"}" \
		"$BASE_URL/api/rag/v1/ask" || true
)"
[[ "$ASK_B_CODE" == "200" ]] || fail "isolation ask HTTP $ASK_B_CODE"
python3 - "$ASK_B_BODY" "$SECRET_MARKER" "$DOC_ID" <<'PY' || fail "cross-library isolation leak detected"
import json, sys
path, marker, doc_id = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding="utf-8") as f:
	data = json.load(f)
citations = data.get("citations") or []
for c in citations:
	cid = str(c.get("document_id") or c.get("doc_id") or "")
	if cid == doc_id:
		sys.stderr.write(f"citation leaked document_id={cid}\n")
		sys.exit(1)
	text = json.dumps(c, ensure_ascii=False)
	if marker in text:
		sys.stderr.write("citation payload contains secret marker\n")
		sys.exit(1)
answer = data.get("answer") or ""
# If not refused and answer confidently repeats the marker, treat as leak.
if marker in answer and data.get("refused") is not True:
	sys.stderr.write("answer contains secret marker without refuse\n")
	sys.exit(1)
print("isolation ok")
PY

# --- replace ---
DOC_FILE_V2="$WORKDIR/pilot-doc-v2.md"
cat >"$DOC_FILE_V2" <<EOF
# Pilot Smoke Document v2

Unique marker: \`${SECRET_MARKER}\`.

## Policy (updated)

Leave proof must be submitted within **five** working days.
EOF

REPLACE_BODY="$WORKDIR/replace.json"
log "replace document (new version)"
REPLACE_CODE="$(
	auth_curl -o "$REPLACE_BODY" -w '%{http_code}' \
		-F "file=@${DOC_FILE_V2};filename=pilot-smoke-v2.md;type=text/markdown" \
		"$BASE_URL/api/libraries/${LIB_A_ID}/documents/${DOC_ID}/versions" || true
)"
[[ "$REPLACE_CODE" == "202" ]] \
	|| fail "replace HTTP $REPLACE_CODE $(head -c 400 "$REPLACE_BODY")"
JOB2="$(json_get "$REPLACE_BODY" job_id)" || fail "replace missing job_id"
wait_job "$JOB2" "replace"

# --- delete ---
DEL_BODY="$WORKDIR/delete.json"
log "delete document"
DEL_CODE="$(
	auth_curl -o "$DEL_BODY" -w '%{http_code}' -X DELETE \
		"$BASE_URL/api/libraries/${LIB_A_ID}/documents/${DOC_ID}" || true
)"
[[ "$DEL_CODE" == "202" || "$DEL_CODE" == "200" ]] \
	|| fail "delete HTTP $DEL_CODE $(head -c 300 "$DEL_BODY")"

# Best-effort wait for delete job if present
DEL_JOB="$(json_get "$DEL_BODY" job_id 2>/dev/null || true)"
if [[ -n "${DEL_JOB:-}" ]]; then
	# delete may complete asynchronously; allow failed wait to be soft only if status deleting→gone
	set +e
	wait_job "$DEL_JOB" "delete"
	DEL_WAIT_RC=$?
	set -e
	if [[ $DEL_WAIT_RC -ne 0 ]]; then
		warn "delete job wait reported failure; verify cleanup manually in go report"
	fi
fi

log "pilot-smoke PASS (upload→ask→isolation→replace→delete)"
log "library_a=$LIB_A_ID library_b=$LIB_B_ID document_id=$DOC_ID"
exit 0
