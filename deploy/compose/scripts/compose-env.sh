# shellcheck shell=bash
# Shared Compose env-file flags for deploy/compose scripts.
# Usage (from deploy/compose, bash or zsh):
#   source scripts/compose-env.sh
#   mk_compose up -d
# Optional deployment-specific overlay:
#   UNORAG_COMPOSE_OVERLAY=./docker-compose.customer.yml mk_compose up -d
# Does NOT source secrets into the host shell.

_mk_this_file() {
	# bash (execute or source)
	if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
		printf '%s' "${BASH_SOURCE[0]}"
		return
	fi
	# zsh (source)
	if [[ -n "${ZSH_VERSION:-}" ]]; then
		# shellcheck disable=SC2296
		printf '%s' "${(%):-%x}"
		return
	fi
	printf '%s' "$0"
}

_MK_SCRIPTS_DIR="$(cd "$(dirname "$(_mk_this_file)")" && pwd)"
_MK_COMPOSE_DIR="$(cd "${_MK_SCRIPTS_DIR}/.." && pwd)"
_MK_CONFIG_DIR="$(cd "${_MK_COMPOSE_DIR}/../config" && pwd)"

mk_require_runtime_config() {
	local missing=0
	local f
	for f in runtime.env runtime.secret; do
		if [[ ! -f "${_MK_CONFIG_DIR}/${f}" ]]; then
			echo "missing ${_MK_CONFIG_DIR}/${f}" >&2
			missing=1
		fi
	done
	if [[ "$missing" -ne 0 ]]; then
		echo "run: ${_MK_COMPOSE_DIR}/scripts/init-config.sh" >&2
		return 1
	fi
}

# Keys from managed env files + common host aliases that must not override --env-file.
_mk_managed_env_keys() {
	{
		# Always strip these even if absent from current files (hybrid / aliases).
		printf '%s\n' \
			DATABASE_URL WEB_DATABASE_URL WORKER_DATABASE_URL \
			DBOS_SYSTEM_DATABASE_URL MIGRATOR_DATABASE_URL \
			OPENAI_API_KEY OPENAI_BASE_URL DASHSCOPE_API_KEY DASHSCOPE_BASE_URL \
			HTTP_PORT COMPOSE_PROJECT_NAME
		local _mk_file
		for _mk_file in "$@"; do
			[[ -f "$_mk_file" ]] || continue
			awk -F= '
				/^[[:space:]]*#/ { next }
				/^[[:space:]]*$/ { next }
				{
					key = $1
					gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
					if (key != "" && key ~ /^[A-Za-z_][A-Za-z0-9_]*$/) print key
				}
			' "${_mk_file}"
		done
	} | sort -u
}

# Run docker compose with managed host keys unset so --env-file values win.
_mk_run_compose() {
	# Args: env-file paths..., then literal --, then docker compose argv.
	local -a _mk_files=()
	local -a _mk_compose_args=()
	local _mk_sep=0
	local _mk_arg
	for _mk_arg in "$@"; do
		if [[ "$_mk_arg" == "--" && "$_mk_sep" -eq 0 ]]; then
			_mk_sep=1
			continue
		fi
		if [[ "$_mk_sep" -eq 0 ]]; then
			_mk_files+=("$_mk_arg")
		else
			_mk_compose_args+=("$_mk_arg")
		fi
	done

	local -a _mk_env_unset=()
	local _mk_key
	while IFS= read -r _mk_key; do
		[[ -n "$_mk_key" ]] || continue
		_mk_env_unset+=(-u "$_mk_key")
	done < <(_mk_managed_env_keys "${_mk_files[@]}")

	local -a _mk_file_args=(-f "${_MK_COMPOSE_DIR}/docker-compose.yml")
	if [[ -n "${UNORAG_COMPOSE_OVERLAY:-}" ]]; then
		local _mk_overlay="${UNORAG_COMPOSE_OVERLAY}"
		if [[ "${_mk_overlay}" != /* ]]; then
			_mk_overlay="${_MK_COMPOSE_DIR}/${_mk_overlay#./}"
		fi
		if [[ ! -f "${_mk_overlay}" ]]; then
			echo "missing Compose overlay: ${_mk_overlay}" >&2
			return 1
		fi
		_mk_file_args+=(-f "${_mk_overlay}")
	fi

	env "${_mk_env_unset[@]}" docker compose \
		"${_mk_file_args[@]}" \
		"${_mk_compose_args[@]}"
}

# docker compose with runtime + secret only (bootstrap.env NOT required).
mk_compose() {
	mk_require_runtime_config || return 1
	_mk_run_compose \
		"${_MK_CONFIG_DIR}/runtime.env" \
		"${_MK_CONFIG_DIR}/runtime.secret" \
		-- \
		--env-file "${_MK_CONFIG_DIR}/runtime.env" \
		--env-file "${_MK_CONFIG_DIR}/runtime.secret" \
		"$@"
}

# Same as mk_compose plus bootstrap.env (migrate/bootstrap profile services).
mk_compose_bootstrap() {
	mk_require_runtime_config || return 1
	if [[ ! -f "${_MK_CONFIG_DIR}/bootstrap.env" ]]; then
		echo "missing ${_MK_CONFIG_DIR}/bootstrap.env — run init-config.sh" >&2
		return 1
	fi
	_mk_run_compose \
		"${_MK_CONFIG_DIR}/runtime.env" \
		"${_MK_CONFIG_DIR}/runtime.secret" \
		"${_MK_CONFIG_DIR}/bootstrap.env" \
		-- \
		--env-file "${_MK_CONFIG_DIR}/runtime.env" \
		--env-file "${_MK_CONFIG_DIR}/runtime.secret" \
		--env-file "${_MK_CONFIG_DIR}/bootstrap.env" \
		"$@"
}

# Read a single key from split config files (for scripts that need a value).
# Order: bootstrap.env → runtime.secret → runtime.env
# Avoid variable name `line` — zsh can leak `line=''` into command substitution.
mk_config_get() {
	local _mk_key="$1"
	local _mk_file _mk_value
	for _mk_file in \
		"${_MK_CONFIG_DIR}/bootstrap.env" \
		"${_MK_CONFIG_DIR}/runtime.secret" \
		"${_MK_CONFIG_DIR}/runtime.env"; do
		[[ -f "$_mk_file" ]] || continue
		_mk_value="$(
			awk -F= -v k="${_mk_key}" '
				$1 == k { v = substr($0, index($0, "=") + 1) }
				END { if (v != "") print v }
			' "${_mk_file}" 2>/dev/null || true
		)"
		if [[ -n "$_mk_value" ]]; then
			printf '%s' "${_mk_value}"
			return 0
		fi
	done
	return 1
}

mk_config_enabled() {
	local _mk_value
	_mk_value="$(mk_config_get "$1" || true)"
	case "$_mk_value" in
		true | TRUE | True | 1) return 0 ;;
		*) return 1 ;;
	esac
}

mk_dbos_required() {
	return 0
}

mk_validate_dbos_config() {
	local _mk_queues
	_mk_queues="$(mk_config_get UNORAG_DBOS_LISTEN_QUEUES || echo ingest-local,ingest-auto,ingest-mineru,lifecycle)"
	_mk_queues="${_mk_queues//[[:space:]]/}"
	local _mk_required_queue
	for _mk_required_queue in ingest-local ingest-auto ingest-mineru lifecycle; do
		if [[ ",${_mk_queues}," != *",${_mk_required_queue},"* ]]; then
			echo "UNORAG_DBOS_LISTEN_QUEUES must include ${_mk_required_queue}" >&2
			return 1
		fi
	done
}
