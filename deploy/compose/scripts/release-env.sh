#!/usr/bin/env bash
# Shared release manifest validation and runtime pin management.

mk_release_env_get() {
	local file="$1" key="$2"
	awk -F= -v key="$key" '
		/^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
		$1 == key { value = substr($0, index($0, "=") + 1) }
		END { if (value != "") print value }
	' "$file"
}

mk_release_assert_image() {
	local name="$1" value="$2" mode="${3:-pinned}"
	[[ -n "$value" ]] || {
		printf 'error: %s is required\n' "$name" >&2
		return 1
	}
	[[ "$value" != "latest" && "$value" != *":latest" ]] || {
		printf 'error: %s may not use latest\n' "$name" >&2
		return 1
	}
	if [[ "$mode" == "digest" ]]; then
		[[ "$value" =~ ^[^[:space:]@]+@sha256:[a-f0-9]{64}$ ]] || {
			printf 'error: %s must use a complete sha256 registry digest\n' "$name" >&2
			return 1
		}
		return 0
	fi
	[[ "$value" == *@sha256:* || "$value" == *:* ]] || {
		printf 'error: %s must contain a tag or digest\n' "$name" >&2
		return 1
	}
}

mk_release_assert_dbos_version() {
	local value="$1"
	[[ "$value" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || {
		printf 'error: invalid DBOS version\n' >&2
		return 1
	}
}

mk_release_write_runtime_pins() {
	local runtime_env="$1" web="$2" migrator="$3" ops="$4" worker="$5" version="$6" tmp
	tmp="$(mktemp)"
	awk -F= \
		-v web="$web" -v migrator="$migrator" -v ops="$ops" \
		-v worker="$worker" -v version="$version" '
		BEGIN { seen_web=seen_migrator=seen_ops=seen_worker=seen_version=0 }
		$1 == "UNORAG_WEB_IMAGE" { print "UNORAG_WEB_IMAGE=" web; seen_web=1; next }
		$1 == "UNORAG_WEB_MIGRATOR_IMAGE" { print "UNORAG_WEB_MIGRATOR_IMAGE=" migrator; seen_migrator=1; next }
		$1 == "UNORAG_WEB_OPS_IMAGE" { print "UNORAG_WEB_OPS_IMAGE=" ops; seen_ops=1; next }
		$1 == "UNORAG_DBOS_WORKER_IMAGE" { print "UNORAG_DBOS_WORKER_IMAGE=" worker; seen_worker=1; next }
		$1 == "UNORAG_DBOS_APPLICATION_VERSION" { print "UNORAG_DBOS_APPLICATION_VERSION=" version; seen_version=1; next }
		{ print }
		END {
			if (!seen_web) print "UNORAG_WEB_IMAGE=" web
			if (!seen_migrator) print "UNORAG_WEB_MIGRATOR_IMAGE=" migrator
			if (!seen_ops) print "UNORAG_WEB_OPS_IMAGE=" ops
			if (!seen_worker) print "UNORAG_DBOS_WORKER_IMAGE=" worker
			if (!seen_version) print "UNORAG_DBOS_APPLICATION_VERSION=" version
		}
	' "$runtime_env" >"$tmp"
	mv "$tmp" "$runtime_env"
	chmod 600 "$runtime_env"
}
