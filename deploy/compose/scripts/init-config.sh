#!/usr/bin/env bash
# Reconcile example configs into gitignored files (0600) without overwriting values.
# New keys are appended, retired runtime keys are removed, and a legacy monolithic
# deploy/compose/.env is imported at most once.
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="$(cd "${COMPOSE_DIR}/../config" && pwd)"
LEGACY_ENV="${COMPOSE_DIR}/.env"

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

echo "==> reconciling split config schema"
python3 - <<'PY' "$CONFIG_DIR"
import sys
from pathlib import Path

config_dir = Path(sys.argv[1])

retired_runtime = {
    "UNORAG_API_IMAGE",
    "UNORAG_OUTBOX_IMAGE",
    "MINERU_ENABLED",
    "MINERU_PARSE_METHOD",
    "LIFECYCLE_WORKER_POLL_SECONDS",
    "LIFECYCLE_WORKER_LEASE_SECONDS",
    "LIFECYCLE_WORKER_HEARTBEAT_SECONDS",
    "LIFECYCLE_LOCAL_CAPACITY",
    "LIFECYCLE_MINERU_CAPACITY",
    "UNORAG_DBOS_CLEANUP_ENABLED",
}
retired_secrets = {
    "UNORAG_INTERNAL_SECRET",
    "INTERNAL_AUTH_SECRET",
    "UNORAG_API_DB_PASSWORD",
    "UNORAG_OUTBOX_DB_PASSWORD",
    "UNORAG_RAG_READ_DB_PASSWORD",
    "API_DATABASE_URL",
    "OUTBOX_DATABASE_URL",
    "RAG_READ_DATABASE_URL",
}
known_value_migrations = {
    (
        "LLM_BASE_URL",
        "https://dashscope.aliyuncs.com/compatible-api/v1",
    ): "https://dashscope.aliyuncs.com/compatible-mode/v1",
}

def assignment(line):
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in line:
        return None
    key, value = line.split("=", 1)
    key = key.strip()
    if not key or not all(ch.isupper() or ch.isdigit() or ch == "_" for ch in key):
        return None
    return key, value

def reconcile(name, retired):
    example = config_dir / f"{name}.example"
    target = config_dir / name
    example_assignments = [
        parsed
        for line in example.read_text(encoding="utf-8").splitlines()
        if (parsed := assignment(line)) is not None
    ]
    output = []
    seen = set()
    removed = []
    migrated = []
    for line in target.read_text(encoding="utf-8").splitlines():
        parsed = assignment(line)
        if parsed is not None and parsed[0] in retired:
            removed.append(parsed[0])
            continue
        if parsed is not None:
            key, value = parsed
            seen.add(key)
            replacement = known_value_migrations.get((key, value.strip()))
            if replacement is not None:
                line = f"{key}={replacement}"
                migrated.append(key)
        output.append(line)

    added = [(key, value) for key, value in example_assignments if key not in seen]
    if added:
        if output and output[-1].strip():
            output.append("")
        output.append("# Added by init-config.sh for the current runtime schema.")
        output.extend(f"{key}={value}" for key, value in added)

    target.write_text("\n".join(output).rstrip() + "\n", encoding="utf-8")
    target.chmod(0o600)
    print(
        f"reconciled {name}: added={len(added)} "
        f"retired={len(set(removed))} migrated={len(set(migrated))}"
    )

reconcile("runtime.env", retired_runtime)
reconcile("runtime.secret", retired_secrets)
reconcile("bootstrap.env", set())
PY

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
    "APP_ENV", "COMPOSE_PROJECT_NAME", "HTTP_PORT", "UNORAG_BASE_URL",
    "UNORAG_WEB_IMAGE", "UNORAG_WEB_MIGRATOR_IMAGE", "UNORAG_WEB_OPS_IMAGE",
    "UNORAG_DBOS_WORKER_IMAGE",
    "POSTGRES_IMAGE", "QDRANT_IMAGE", "REDIS_IMAGE", "CADDY_IMAGE",
    "POSTGRES_DB", "POSTGRES_USER", "UNORAG_DBOS_DATABASE",
    "QDRANT_URL", "QDRANT_COLLECTION", "REDIS_URL",
    "DOCUMENT_MAX_UPLOAD_BYTES",
    "LLM_BASE_URL", "CHAT_MODEL", "AI_SUPPORTS_STRUCTURED_OUTPUTS",
    "JUDGE_MODEL", "JUDGE_BASE_URL", "JUDGE_PROVIDER_NAME",
    "JUDGE_SUPPORTS_STRUCTURED_OUTPUTS", "ASK_JUDGE_TIMEOUT_MS",
    "ASK_JUDGE_MAX_ATTEMPTS", "ASK_JUDGE_MAX_OUTPUT_TOKENS",
    "EMBEDDING_MODEL", "EMBEDDING_DIM",
    "RERANK_BASE_URL", "RERANK_MODEL",
    "MINERU_PROVIDER", "MINERU_SELF_HOSTED_URL", "MINERU_URL",
    "MINERU_MODE", "MINERU_VERSION",
    "PARSER_POLL_INTERVAL_MS", "PARSER_MAX_WAIT_MS",
    "PARSER_RETRY_BACKOFF_MS",
    "DATABASE_POOL_MAX", "LLM_MAX_INFLIGHT", "EMBEDDING_BATCH_SIZE",
    "UNORAG_DBOS_LISTEN_QUEUES", "UNORAG_DBOS_APPLICATION_VERSION",
    "DBOS_SYSTEM_DATABASE_POOL_SIZE", "DBOS_INGEST_LOCAL_CONCURRENCY",
    "DBOS_INGEST_AUTO_CONCURRENCY", "DBOS_INGEST_MINERU_CONCURRENCY",
    "DBOS_LIFECYCLE_CONCURRENCY",
    "DBOS_CONTROL_POLL_MS", "DBOS_UPGRADE_DRAIN_TIMEOUT_SECONDS",
    "ASK_RUN_MAINTENANCE_ENABLED", "ASK_RUN_MAINTENANCE_INTERVAL_MS",
    "ASK_RUN_STALE_AFTER_MINUTES", "ASK_RUN_RETENTION_DAYS",
    "ASK_RUN_MAINTENANCE_BATCH_SIZE",
    "TOMBSTONE_MAINTENANCE_ENABLED", "TOMBSTONE_MAINTENANCE_INTERVAL_MS",
    "TOMBSTONE_RETENTION_DAYS", "TOMBSTONE_MAINTENANCE_BATCH_SIZE",
    "OBSERVABILITY_CYCLE_ENABLED", "OBSERVABILITY_CYCLE_INTERVAL_MS",
    "EMAIL_PROVIDER", "OBSERVABILITY_ALERT_WEBHOOK_ENABLED",
    "OBSERVABILITY_ALERT_EMAIL_ENABLED",
    "OTEL_SDK_DISABLED", "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_TRACES_SAMPLER", "OTEL_TRACES_SAMPLER_ARG",
    "OTEL_COLLECTOR_IMAGE", "PROMETHEUS_IMAGE", "ALERTMANAGER_IMAGE",
    "GRAFANA_IMAGE", "LOKI_IMAGE", "TEMPO_IMAGE", "GRAFANA_PORT",
    "GRAFANA_ADMIN_USER", "PROMETHEUS_RETENTION_TIME",
    "PROMETHEUS_RETENTION_SIZE", "ALERTMANAGER_RETENTION_TIME",
    "TEMPO_RETENTION_TIME", "LOKI_RETENTION_PERIOD",
]
secret_keys = [
    "POSTGRES_PASSWORD", "UNORAG_SESSION_SECRET",
    "LLM_API_KEY", "MINERU_API_KEY",
    "DATABASE_URL", "WEB_DATABASE_URL", "WORKER_DATABASE_URL",
    "DBOS_SYSTEM_DATABASE_URL", "MIGRATOR_DATABASE_URL",
    "UNORAG_WEB_DB_PASSWORD", "UNORAG_WORKER_DB_PASSWORD", "UNORAG_DBOS_DB_PASSWORD",
    "OBSERVABILITY_ALERT_WEBHOOK_URL", "OBSERVABILITY_ALERT_WEBHOOK_SECRET",
    "OBSERVABILITY_ALERT_EMAIL_TO", "EMAIL_FROM", "RESEND_API_KEY",
    "GRAFANA_ADMIN_PASSWORD", "OTEL_EXPORTER_OTLP_HEADERS",
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
echo "  2. Fill ${CONFIG_DIR}/runtime.secret (database/session secrets >= 32 characters)"
echo "  3. Fill ${CONFIG_DIR}/bootstrap.env (admin password for one-time job)"
echo "  4. cd ${COMPOSE_DIR} && ./scripts/install.sh"
