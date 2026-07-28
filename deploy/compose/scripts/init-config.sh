#!/usr/bin/env bash
# Copy example configs → real gitignored files (0600). Never overwrites existing.
# Optionally migrates legacy deploy/compose/.env into the split files once.
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="$(cd "${COMPOSE_DIR}/../config" && pwd)"
REPO_ROOT="$(cd "${COMPOSE_DIR}/../.." && pwd)"
LEGACY_ENV="${COMPOSE_DIR}/.env"
ALERTS_EXAMPLE="${REPO_ROOT}/ops/min_alerts/env.example"
ALERTS_ENV="${REPO_ROOT}/ops/min_alerts/.env"

copy_if_missing() {
	local src="$1"
	local dst="$2"
	if [[ -f "$dst" ]]; then
		echo "keep existing ${dst}"
		return 0
	fi
	cp "$src" "$dst"
	chmod 600 "$dst"
	echo "created ${dst} (mode 0600)"
}

echo "==> ensuring deploy/config examples → real files"
copy_if_missing "${CONFIG_DIR}/runtime.env.example" "${CONFIG_DIR}/runtime.env"
copy_if_missing "${CONFIG_DIR}/runtime.secret.example" "${CONFIG_DIR}/runtime.secret"
copy_if_missing "${CONFIG_DIR}/bootstrap.env.example" "${CONFIG_DIR}/bootstrap.env"

if [[ -f "$ALERTS_EXAMPLE" ]]; then
	copy_if_missing "$ALERTS_EXAMPLE" "$ALERTS_ENV"
fi

# One-time migration from legacy monolithic compose .env
if [[ -f "$LEGACY_ENV" ]]; then
	python3 - <<'PY' "$LEGACY_ENV" "$CONFIG_DIR"
import re
import sys
from pathlib import Path

legacy_path = Path(sys.argv[1])
config_dir = Path(sys.argv[2])

def parse_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip()
    return out

def upsert(path: Path, updates: dict[str, str], *, only_empty: bool = True) -> list[str]:
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    lines = text.splitlines()
    seen: set[str] = set()
    changed: list[str] = []
    out_lines: list[str] = []
    for line in lines:
        if not line.strip() or line.strip().startswith("#") or "=" not in line:
            out_lines.append(line)
            continue
        key = line.split("=", 1)[0].strip()
        seen.add(key)
        cur = line.split("=", 1)[1]
        if key in updates:
            new_v = updates[key]
            if only_empty and cur.strip():
                out_lines.append(line)
            else:
                out_lines.append(f"{key}={new_v}")
                if cur.strip() != new_v:
                    changed.append(key)
        else:
            out_lines.append(line)
    for key, val in updates.items():
        if key not in seen:
            out_lines.append(f"{key}={val}")
            changed.append(key)
    path.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    path.chmod(0o600)
    return changed

legacy = parse_env(legacy_path)

# Map legacy OPENAI_/DASHSCOPE_ → LLM_*
llm_key = (legacy.get("LLM_API_KEY") or legacy.get("OPENAI_API_KEY") or legacy.get("DASHSCOPE_API_KEY") or "").strip()
llm_base = (legacy.get("LLM_BASE_URL") or legacy.get("OPENAI_BASE_URL") or "").strip()

runtime_keys = [
    "APP_ENV", "COMPOSE_PROJECT_NAME", "HTTP_PORT",
    "UNORAG_WEB_IMAGE", "UNORAG_WEB_MIGRATOR_IMAGE", "UNORAG_API_IMAGE",
    "POSTGRES_IMAGE", "QDRANT_IMAGE", "REDIS_IMAGE", "CADDY_IMAGE",
    "POSTGRES_DB", "POSTGRES_USER",
    "QDRANT_URL", "QDRANT_COLLECTION", "REDIS_URL",
    "DOCUMENT_MAX_UPLOAD_BYTES",
    "LLM_BASE_URL", "CHAT_MODEL", "EMBEDDING_MODEL", "EMBEDDING_DIM",
    "RERANK_BASE_URL", "RERANK_MODEL",
    "MINERU_ENABLED", "MINERU_PROVIDER", "MINERU_SELF_HOSTED_URL", "MINERU_URL",
    "MINERU_MODE", "MINERU_VERSION", "MINERU_PARSE_METHOD",
    "EXTERNAL_PARSER_ALLOWED", "MINERU_302_BASE_URL",
    "MINERU_302_UPLOAD_PATH", "MINERU_302_TASK_PATH",
    "MINERU_302_POLL_INTERVAL_S", "MINERU_302_MAX_WAIT_S",
    "DATABASE_POOL_MAX", "LLM_MAX_INFLIGHT", "EMBEDDING_BATCH_SIZE",
    "LIFECYCLE_WORKER_POLL_SECONDS", "LIFECYCLE_WORKER_LEASE_SECONDS",
    "LIFECYCLE_WORKER_HEARTBEAT_SECONDS", "LIFECYCLE_LOCAL_CAPACITY",
    "LIFECYCLE_MINERU_CAPACITY",
]
secret_keys = [
    "POSTGRES_PASSWORD", "UNORAG_INTERNAL_SECRET", "UNORAG_SESSION_SECRET",
    "LLM_API_KEY", "MINERU_302_API_KEY",
    "DATABASE_URL", "API_DATABASE_URL", "WORKER_DATABASE_URL",
    "RAG_READ_DATABASE_URL", "MIGRATOR_DATABASE_URL",
]
bootstrap_keys = [
    "UNORAG_ORGANIZATION_ID", "UNORAG_ORGANIZATION_SLUG", "UNORAG_ORGANIZATION_NAME",
    "UNORAG_WORKSPACE_ID", "UNORAG_WORKSPACE_SLUG", "UNORAG_WORKSPACE_NAME",
    "UNORAG_PRINCIPAL_ID", "UNORAG_ADMIN_SUBJECT", "UNORAG_ADMIN_EMAIL",
    "UNORAG_ADMIN_NAME", "UNORAG_ADMIN_PASSWORD",
]

runtime_updates = {k: legacy[k] for k in runtime_keys if k in legacy and legacy[k]}
if llm_base:
    runtime_updates["LLM_BASE_URL"] = llm_base
if "DOCUMENT_MAX_UPLOAD_BYTES" not in runtime_updates and legacy.get("MAX_UPLOAD_BYTES"):
    runtime_updates["DOCUMENT_MAX_UPLOAD_BYTES"] = legacy["MAX_UPLOAD_BYTES"]
# DOCUMENT_STORAGE_ROOT is a Compose invariant (/var/lib/unorag/documents);
# never migrate a host path into runtime.env as a tunable knob.

secret_updates = {k: legacy[k] for k in secret_keys if k in legacy and legacy[k]}
if llm_key:
    secret_updates["LLM_API_KEY"] = llm_key
# Prefer UNORAG_INTERNAL_SECRET; fall back to INTERNAL_AUTH_SECRET
if not secret_updates.get("UNORAG_INTERNAL_SECRET") and legacy.get("INTERNAL_AUTH_SECRET"):
    secret_updates["UNORAG_INTERNAL_SECRET"] = legacy["INTERNAL_AUTH_SECRET"]

bootstrap_updates = {k: legacy[k] for k in bootstrap_keys if k in legacy and legacy[k]}

# True one-time migration: only fill empty slots. Never re-overwrite
# COMPOSE_PROJECT_NAME / HTTP_PORT / APP_ENV / LLM_BASE_URL on later runs.
marker = config_dir / ".legacy-env-migrated"
if marker.exists():
    print("skip legacy .env migration (already migrated once)")
else:
    r = upsert(config_dir / "runtime.env", runtime_updates, only_empty=True)
    s = upsert(config_dir / "runtime.secret", secret_updates, only_empty=True)
    b = upsert(config_dir / "bootstrap.env", bootstrap_updates, only_empty=True)
    marker.write_text("migrated\n", encoding="utf-8")
    marker.chmod(0o600)
    print(f"migrated_from_legacy_env keys_runtime={len(r)} keys_secret={len(s)} keys_bootstrap={len(b)}")
    print("note: legacy deploy/compose/.env left in place; scripts now prefer deploy/config/*")
PY
fi

echo
echo "next:"
echo "  1. Edit ${CONFIG_DIR}/runtime.env"
echo "  2. Fill ${CONFIG_DIR}/runtime.secret (secrets >= 32 bytes; INTERNAL != SESSION)"
echo "  3. Fill ${CONFIG_DIR}/bootstrap.env (admin password for one-time job)"
echo "  4. cd ${COMPOSE_DIR} && ./scripts/install.sh"
