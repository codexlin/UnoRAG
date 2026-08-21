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

mk_release_verify_signature() {
	local name="$1" image="$2"
	case "${UNORAG_VERIFY_IMAGE_SIGNATURES:-false}" in
		1|true|TRUE|yes|YES) ;;
		0|false|FALSE|no|NO|"") return 0 ;;
		*)
			printf 'error: UNORAG_VERIFY_IMAGE_SIGNATURES must be true or false\n' >&2
			return 1
			;;
	esac
	mk_release_assert_image "$name" "$image" digest || return 1
	command -v cosign >/dev/null 2>&1 || {
		printf 'error: cosign is required to verify signed release images\n' >&2
		return 1
	}
	local identity="${UNORAG_COSIGN_CERTIFICATE_IDENTITY_REGEXP:-}"
	local issuer="${UNORAG_COSIGN_OIDC_ISSUER:-https://token.actions.githubusercontent.com}"
	local new_bundle="${UNORAG_COSIGN_NEW_BUNDLE_FORMAT:-true}"
	local storage_mode="${UNORAG_COSIGN_REGISTRY_REFERRERS_MODE:-oci-1-1}"
	local normalized_bundle
	local -a verify_args=()
	[[ -n "$identity" ]] || {
		printf 'error: UNORAG_COSIGN_CERTIFICATE_IDENTITY_REGEXP is required\n' >&2
		return 1
	}
	case "$storage_mode" in
		oci-1-1) ;;
		legacy) ;;
		*)
			printf 'error: UNORAG_COSIGN_REGISTRY_REFERRERS_MODE must be oci-1-1 or legacy\n' >&2
			return 1
			;;
	esac
	case "$new_bundle" in
		1|true|TRUE|yes|YES) normalized_bundle=true ;;
		0|false|FALSE|no|NO) normalized_bundle=false ;;
		*)
			printf 'error: UNORAG_COSIGN_NEW_BUNDLE_FORMAT must be true or false\n' >&2
			return 1
			;;
	esac
	if [[ "$storage_mode:$normalized_bundle" != oci-1-1:true && "$storage_mode:$normalized_bundle" != legacy:false ]]; then
		printf 'error: Cosign storage mode and bundle format are incompatible\n' >&2
		return 1
	fi
	verify_args+=("--new-bundle-format=$normalized_bundle")
	cosign verify \
		"${verify_args[@]}" \
		--certificate-identity-regexp "$identity" \
		--certificate-oidc-issuer "$issuer" \
		"$image" >/dev/null || {
		printf 'error: signature verification failed for %s\n' "$name" >&2
		return 1
	}
}

mk_release_verify_images() {
	[[ "$#" -gt 0 && $(( $# % 2 )) -eq 0 ]] || {
		printf 'error: signature verification requires NAME IMAGE pairs\n' >&2
		return 1
	}
	while [[ "$#" -gt 0 ]]; do
		mk_release_verify_signature "$1" "$2" || return 1
		shift 2
	done
}

mk_release_assert_dbos_version() {
	local value="$1"
	[[ "$value" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || {
		printf 'error: invalid DBOS version\n' >&2
		return 1
	}
}

mk_release_assert_platform() {
	local value="$1"
	case "$value" in
		linux/amd64|linux/arm64) return 0 ;;
		*)
			printf 'error: unsupported release platform: %s (expected linux/amd64 or linux/arm64)\n' "$value" >&2
			return 1
			;;
	esac
}

mk_release_resolve_platform() {
	local file="$1" value
	value="$(mk_release_env_get "$file" UNORAG_IMAGE_PLATFORM)"
	if [[ -z "$value" ]]; then
		# Manifests before v0.1.0-rc.6 were built on an amd64-only runner and
		# did not carry an explicit platform field.
		printf 'warning: legacy manifest has no UNORAG_IMAGE_PLATFORM; assuming linux/amd64\n' >&2
		value="linux/amd64"
	fi
	mk_release_assert_platform "$value" || return 1
	printf '%s\n' "$value"
}

mk_release_docker_platform() {
	local value os arch
	if [[ -n "${UNORAG_DOCKER_PLATFORM_OVERRIDE:-}" ]]; then
		value="$UNORAG_DOCKER_PLATFORM_OVERRIDE"
	else
		command -v docker >/dev/null 2>&1 || {
			printf 'error: docker is required to validate the release platform\n' >&2
			return 1
		}
		value="$(docker info --format '{{.OSType}}/{{.Architecture}}' 2>/dev/null)" || {
			printf 'error: cannot query Docker Engine platform; ensure Docker is running\n' >&2
			return 1
		}
	fi
	os="${value%%/*}"
	arch="${value#*/}"
	case "$arch" in
		x86_64) arch="amd64" ;;
		aarch64) arch="arm64" ;;
	esac
	value="${os}/${arch}"
	mk_release_assert_platform "$value" || return 1
	printf '%s\n' "$value"
}

mk_release_assert_host_platform() {
	local expected="$1" allow_emulation="${2:-0}" actual
	mk_release_assert_platform "$expected" || return 1
	actual="$(mk_release_docker_platform)" || return 1
	if [[ "$actual" == "$expected" ]]; then
		return 0
	fi
	if [[ "$allow_emulation" == "1" ]]; then
		printf 'warning: release targets %s but Docker Engine is %s; explicit emulation accepted for local validation\n' \
			"$expected" "$actual" >&2
		return 0
	fi
	printf 'error: release targets %s but Docker Engine is %s\n' "$expected" "$actual" >&2
	printf 'error: use a matching host; for local acceptance only, add a product-service platform overlay and pass --allow-platform-emulation\n' >&2
	return 1
}

mk_release_write_runtime_pins() {
	local runtime_env="$1" web="$2" migrator="$3" ops="$4" worker="$5" version="$6" platform="${7:-}" tmp
	tmp="$(mktemp)"
	awk -F= \
		-v web="$web" -v migrator="$migrator" -v ops="$ops" \
		-v worker="$worker" -v version="$version" -v platform="$platform" '
		BEGIN { seen_web=seen_migrator=seen_ops=seen_worker=seen_version=seen_platform=0 }
		$1 == "UNORAG_WEB_IMAGE" { print "UNORAG_WEB_IMAGE=" web; seen_web=1; next }
		$1 == "UNORAG_WEB_MIGRATOR_IMAGE" { print "UNORAG_WEB_MIGRATOR_IMAGE=" migrator; seen_migrator=1; next }
		$1 == "UNORAG_WEB_OPS_IMAGE" { print "UNORAG_WEB_OPS_IMAGE=" ops; seen_ops=1; next }
		$1 == "UNORAG_DBOS_WORKER_IMAGE" { print "UNORAG_DBOS_WORKER_IMAGE=" worker; seen_worker=1; next }
		$1 == "UNORAG_DBOS_APPLICATION_VERSION" { print "UNORAG_DBOS_APPLICATION_VERSION=" version; seen_version=1; next }
		$1 == "UNORAG_IMAGE_PLATFORM" { print "UNORAG_IMAGE_PLATFORM=" platform; seen_platform=1; next }
		{ print }
		END {
			if (!seen_web) print "UNORAG_WEB_IMAGE=" web
			if (!seen_migrator) print "UNORAG_WEB_MIGRATOR_IMAGE=" migrator
			if (!seen_ops) print "UNORAG_WEB_OPS_IMAGE=" ops
			if (!seen_worker) print "UNORAG_DBOS_WORKER_IMAGE=" worker
			if (!seen_version) print "UNORAG_DBOS_APPLICATION_VERSION=" version
			if (!seen_platform) print "UNORAG_IMAGE_PLATFORM=" platform
		}
	' "$runtime_env" >"$tmp"
	mv "$tmp" "$runtime_env"
	chmod 600 "$runtime_env"
}
