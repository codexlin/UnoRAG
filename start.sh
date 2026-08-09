#!/usr/bin/env bash
# Local one-command UnoRAG startup. Production installs must use a release manifest.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${ROOT}/deploy/config"
COMPOSE_DIR="${ROOT}/deploy/compose"
CONFIG_HELPER_IMAGE="${UNORAG_CONFIG_HELPER_IMAGE:-python:3.12-slim-bookworm}"

OPEN_BROWSER=1
CHECK_ONLY=0
REQUESTED_PORT="${UNORAG_HTTP_PORT:-}"
REQUESTED_PROJECT_NAME="${UNORAG_COMPOSE_PROJECT_NAME:-}"
REQUESTED_NPM_REGISTRY="${UNORAG_NPM_REGISTRY:-}"
INSTALL_ARGS=()
NEEDS_GRAFANA_SECRET=0

usage() {
	cat <<'EOF'
Usage: ./start.sh [options]

Start a local UnoRAG stack with Docker Compose. On first run the script creates
gitignored configuration, generates local secrets, and securely asks for the
OpenAI-compatible model API key.

Options:
  --port PORT              Host HTTP port (first run default: 8080)
  --project-name NAME      Isolated Docker Compose project and volume prefix
  --npm-registry URL       Alternate npm registry for local image builds
  --with-observability     Start Grafana, Prometheus, Loki, Tempo and Alertmanager
  --with-langfuse          Enable the configured metadata-only Langfuse exporter
  --manifest FILE          Install digest-pinned release images instead of local build
  --allow-platform-emulation
                           Permit local product-image emulation (never for production)
  --no-open                Do not open the browser after startup
  --check                  Check Docker prerequisites without changing files
  -h, --help               Show this help

Environment:
  LLM_API_KEY              Avoid the interactive API-key prompt
  UNORAG_ADMIN_PASSWORD    Use a chosen initial admin password
  UNORAG_ADMIN_EMAIL       Override admin@example.com on first bootstrap
  UNORAG_HTTP_PORT         Same as --port
  UNORAG_COMPOSE_PROJECT_NAME
                           Same as --project-name
  UNORAG_NPM_REGISTRY      Same as --npm-registry

The default provider/model comes from deploy/config/runtime.env. Edit that file
before rerunning when using a provider other than the shipped DashScope defaults.
EOF
}

die() {
	echo "error: $*" >&2
	exit 1
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--port)
			[[ -n "${2:-}" ]] || die "--port requires a value"
			REQUESTED_PORT="$2"
			shift 2
			;;
		--project-name)
			[[ -n "${2:-}" ]] || die "--project-name requires a value"
			REQUESTED_PROJECT_NAME="$2"
			shift 2
			;;
		--npm-registry)
			[[ -n "${2:-}" ]] || die "--npm-registry requires a URL"
			REQUESTED_NPM_REGISTRY="$2"
			shift 2
			;;
		--with-observability | --with-ops)
			INSTALL_ARGS+=(--with-observability)
			NEEDS_GRAFANA_SECRET=1
			shift
			;;
		--with-langfuse)
			INSTALL_ARGS+=(--with-langfuse)
			NEEDS_GRAFANA_SECRET=1
			shift
			;;
		--manifest)
			[[ -n "${2:-}" ]] || die "--manifest requires a file"
			manifest_dir="$(cd "$(dirname "$2")" 2>/dev/null && pwd)" || die "manifest directory not found"
			INSTALL_ARGS+=(--manifest "${manifest_dir}/$(basename "$2")")
			shift 2
			;;
		--allow-platform-emulation)
			INSTALL_ARGS+=(--allow-platform-emulation)
			shift
			;;
		--no-open)
			OPEN_BROWSER=0
			shift
			;;
		--check)
			CHECK_ONLY=1
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*) die "unknown argument: $1 (run ./start.sh --help)" ;;
	esac
done

if [[ -n "$REQUESTED_PORT" && ! "$REQUESTED_PORT" =~ ^[0-9]+$ ]]; then
	die "port must be an integer"
fi
if [[ -n "$REQUESTED_PORT" && ("$REQUESTED_PORT" -lt 1 || "$REQUESTED_PORT" -gt 65535) ]]; then
	die "port must be between 1 and 65535"
fi
if [[ -n "$REQUESTED_PROJECT_NAME" && ! "$REQUESTED_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
	die "project name must use lowercase letters, digits, hyphens, or underscores"
fi
if [[ -n "$REQUESTED_NPM_REGISTRY" && ! "$REQUESTED_NPM_REGISTRY" =~ ^https://[^[:space:]]+$ ]]; then
	die "npm registry must be an https URL"
fi

command -v docker >/dev/null 2>&1 || die "Docker is not installed or not on PATH"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose)"
docker info >/dev/null 2>&1 || die "Docker is installed but the daemon is not running"

if [[ "$CHECK_ONLY" -eq 1 ]]; then
	echo "Docker and Docker Compose are ready."
	exit 0
fi

fresh_runtime=0
if [[ ! -f "${CONFIG_DIR}/runtime.env" ]]; then
	fresh_runtime=1
fi
bootstrap_existed=0
if [[ -f "${CONFIG_DIR}/bootstrap.env" ]]; then
	bootstrap_existed=1
fi

echo "==> preparing local configuration"
if command -v python3 >/dev/null 2>&1; then
	"${COMPOSE_DIR}/scripts/init-config.sh"
else
	echo "    host Python not found; using a temporary Docker helper"
	docker run --rm \
		--user "$(id -u):$(id -g)" \
		-v "${ROOT}:/workspace" \
		-w /workspace \
		"${CONFIG_HELPER_IMAGE}" \
		bash deploy/compose/scripts/init-config.sh
fi

get_value() {
	local file="$1" key="$2"
	awk -F= -v k="$key" '
		$1 == k { value = substr($0, index($0, "=") + 1) }
		END { print value }
	' "$file"
}

set_value() {
	local file="$1" key="$2" value="$3" tmp
	tmp="$(mktemp "${file}.tmp.XXXXXX")"
	chmod 600 "$tmp"
	awk -v k="$key" -v v="$value" '
		BEGIN { found = 0 }
		{
			line = $0
			candidate = line
			sub(/=.*/, "", candidate)
			if (candidate == k) {
				print k "=" v
				found = 1
			} else {
				print line
			}
		}
		END { if (!found) print k "=" v }
	' "$file" >"$tmp"
	mv "$tmp" "$file"
	chmod 600 "$file"
}

random_hex() {
	# od and /dev/urandom are available on supported macOS/Linux/WSL hosts.
	od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

ensure_random_secret() {
	local file="$1" key="$2" current
	current="$(get_value "$file" "$key")"
	if [[ -z "$current" || "$current" == *"replace-with-random"* ]]; then
		set_value "$file" "$key" "$(random_hex)"
	fi
}

RUNTIME_ENV="${CONFIG_DIR}/runtime.env"
RUNTIME_SECRET="${CONFIG_DIR}/runtime.secret"
BOOTSTRAP_ENV="${CONFIG_DIR}/bootstrap.env"

if [[ "$fresh_runtime" -eq 1 ]]; then
	set_value "$RUNTIME_ENV" HTTP_PORT "${REQUESTED_PORT:-8080}"
elif [[ -n "$REQUESTED_PORT" ]]; then
	set_value "$RUNTIME_ENV" HTTP_PORT "$REQUESTED_PORT"
fi
if [[ -n "$REQUESTED_PROJECT_NAME" ]]; then
	set_value "$RUNTIME_ENV" COMPOSE_PROJECT_NAME "$REQUESTED_PROJECT_NAME"
fi

ensure_random_secret "$RUNTIME_SECRET" POSTGRES_PASSWORD
ensure_random_secret "$RUNTIME_SECRET" UNORAG_WEB_DB_PASSWORD
ensure_random_secret "$RUNTIME_SECRET" UNORAG_WORKER_DB_PASSWORD
ensure_random_secret "$RUNTIME_SECRET" UNORAG_DBOS_DB_PASSWORD
ensure_random_secret "$RUNTIME_SECRET" UNORAG_SESSION_SECRET

host_llm_key="${LLM_API_KEY:-}"
configured_llm_key="$(get_value "$RUNTIME_SECRET" LLM_API_KEY)"
if [[ -n "$host_llm_key" ]]; then
	set_value "$RUNTIME_SECRET" LLM_API_KEY "$host_llm_key"
elif [[ -z "$configured_llm_key" ]]; then
	if [[ -t 0 ]]; then
		read -r -s -p "OpenAI-compatible model API key: " configured_llm_key
		echo
		[[ -n "$configured_llm_key" ]] || die "model API key cannot be empty"
		set_value "$RUNTIME_SECRET" LLM_API_KEY "$configured_llm_key"
	else
		die "LLM_API_KEY is required in non-interactive mode"
	fi
fi
unset host_llm_key configured_llm_key LLM_API_KEY

generated_admin_password=""
rotate_admin_after_install=0
host_admin_password="${UNORAG_ADMIN_PASSWORD:-}"
configured_admin_password="$(get_value "$BOOTSTRAP_ENV" UNORAG_ADMIN_PASSWORD)"
if [[ -n "$host_admin_password" ]]; then
	set_value "$BOOTSTRAP_ENV" UNORAG_ADMIN_PASSWORD "$host_admin_password"
	if [[ "$bootstrap_existed" -eq 1 ]]; then
		rotate_admin_after_install=1
	fi
elif [[ -z "$configured_admin_password" || "$configured_admin_password" == "change-this-before-deployment" ]]; then
	generated_admin_password="$(random_hex)"
	set_value "$BOOTSTRAP_ENV" UNORAG_ADMIN_PASSWORD "$generated_admin_password"
	if [[ "$bootstrap_existed" -eq 1 ]]; then
		rotate_admin_after_install=1
	fi
fi
unset host_admin_password configured_admin_password UNORAG_ADMIN_PASSWORD

if [[ -n "${UNORAG_ADMIN_EMAIL:-}" ]]; then
	set_value "$BOOTSTRAP_ENV" UNORAG_ADMIN_EMAIL "$UNORAG_ADMIN_EMAIL"
fi

if [[ "$NEEDS_GRAFANA_SECRET" -eq 1 ]]; then
	ensure_random_secret "$RUNTIME_SECRET" GRAFANA_ADMIN_PASSWORD
fi

echo "==> starting UnoRAG (the first image build may take several minutes)"
if [[ -n "$REQUESTED_NPM_REGISTRY" ]]; then
	export NPM_CONFIG_REGISTRY="$REQUESTED_NPM_REGISTRY"
fi
if [[ "${#INSTALL_ARGS[@]}" -eq 0 ]]; then
	(cd "$COMPOSE_DIR" && ./scripts/install.sh)
else
	(cd "$COMPOSE_DIR" && ./scripts/install.sh "${INSTALL_ARGS[@]}")
fi

if [[ "$rotate_admin_after_install" -eq 1 ]]; then
	echo "==> applying the configured administrator password"
	(cd "$COMPOSE_DIR" && ./scripts/rotate-admin-password.sh)
fi

http_port="$(get_value "$RUNTIME_ENV" HTTP_PORT)"
http_port="${http_port:-80}"
if [[ "$http_port" == "80" ]]; then
	product_url="http://localhost/"
else
	product_url="http://localhost:${http_port}/"
fi
admin_email="$(get_value "$BOOTSTRAP_ENV" UNORAG_ADMIN_EMAIL)"

echo
echo "UnoRAG is ready."
echo "  URL:   ${product_url}"
echo "  Email: ${admin_email:-admin@example.com}"
if [[ -n "$generated_admin_password" ]]; then
	echo "  Initial password: ${generated_admin_password}"
	echo "  Change this password after the first login."
else
	echo "  Password: the value already configured in deploy/config/bootstrap.env"
fi
echo "  Stop:  cd deploy/compose && source scripts/compose-env.sh && mk_compose down"

if [[ "$OPEN_BROWSER" -eq 1 ]]; then
	if command -v open >/dev/null 2>&1; then
		open "$product_url" >/dev/null 2>&1 || true
	elif command -v xdg-open >/dev/null 2>&1; then
		xdg-open "$product_url" >/dev/null 2>&1 || true
	fi
fi
