# Shared helpers for UnoRAG acceptance scripts.
# shellcheck shell=bash

acc_root() {
	cd "$(dirname "${BASH_SOURCE[1]}")/.." && pwd
}

repo_root_from_acc() {
	local acc
	acc="$(cd "$(dirname "${BASH_SOURCE[1]}")/../.." && pwd)"
	printf '%s' "$acc"
}

# Load KEY=VALUE without sourcing (values may contain spaces). Never print secrets.
load_env_file_keys() {
	local envfile="$1"
	shift
	local allow=("$@")
	[[ -f "$envfile" ]] || return 0
	while IFS= read -r line || [[ -n "$line" ]]; do
		[[ "$line" =~ ^[[:space:]]*# ]] && continue
		[[ "$line" =~ ^[[:space:]]*$ ]] && continue
		[[ "$line" == *=* ]] || continue
		local key="${line%%=*}"
		local val="${line#*=}"
		val="${val%$'\r'}"
		val="${val%\"}"
		val="${val#\"}"
		val="${val%\'}"
		val="${val#\'}"
		if ((${#allow[@]})); then
			local ok=0 a
			for a in "${allow[@]}"; do
				[[ "$key" == "$a" ]] && ok=1 && break
			done
			[[ $ok -eq 1 ]] || continue
		fi
		export "$key=$val"
	done <"$envfile"
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
	code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$@" || true)"
	printf '%s' "$code"
}

now_iso() {
	date -u +%Y-%m-%dT%H:%M:%SZ
}

now_epoch() {
	date +%s
}

require_cmds() {
	local c
	for c in "$@"; do
		command -v "$c" >/dev/null 2>&1 || return 1
	done
	return 0
}

port_listening() {
	local port="$1"
	lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

wait_http_ok() {
	# wait_http_ok <url> <timeout_sec>
	local url="$1" timeout_sec="${2:-120}" started code
	started="$(now_epoch)"
	while true; do
		code="$(http_code "$url")"
		if [[ "$code" == "200" ]]; then
			return 0
		fi
		if (( $(now_epoch) - started > timeout_sec )); then
			return 1
		fi
		sleep 2
	done
}

# Patch KEY=value in an env file (creates key if missing). Keeps other lines intact.
env_set_key() {
	local file="$1" key="$2" value="$3"
	python3 - "$file" "$key" "$value" <<'PY'
import pathlib, sys
path, key, value = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
out, found = [], False
for line in lines:
	if line.startswith(f"{key}="):
		out.append(f"{key}={value}")
		found = True
	else:
		out.append(line)
if not found:
	out.append(f"{key}={value}")
path.write_text("\n".join(out) + "\n", encoding="utf-8")
PY
}

env_get_key() {
	local file="$1" key="$2"
	python3 - "$file" "$key" <<'PY'
import pathlib, sys
path, key = pathlib.Path(sys.argv[1]), sys.argv[2]
if not path.exists():
	sys.exit(2)
for line in path.read_text(encoding="utf-8").splitlines():
	if line.startswith(f"{key}="):
		print(line.split("=", 1)[1])
		raise SystemExit(0)
sys.exit(2)
PY
}
