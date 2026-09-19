#!/usr/bin/env bash
# Reconcile example configs into gitignored files (0600) while preserving values.
# Runtime settings are layered into common and advanced files, retired keys are
# removed, and a legacy monolithic deploy/compose/.env is imported at most once.
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
copy_if_missing "${CONFIG_DIR}/runtime.advanced.env.example" "${CONFIG_DIR}/runtime.advanced.env"
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
    "MINERU_URL",
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

def assignments(path):
    return {
        key: value
        for line in path.read_text(encoding="utf-8").splitlines()
        if (parsed := assignment(line)) is not None
        for key, value in [parsed]
    }

def render_example(example, values, extras=None):
    output = []
    known = set()
    for line in example.read_text(encoding="utf-8").splitlines():
        parsed = assignment(line)
        if parsed is None:
            output.append(line)
            continue
        key, default = parsed
        known.add(key)
        output.append(f"{key}={values.get(key, default)}")
    extra_items = [
        (key, value)
        for key, value in (extras or {}).items()
        if key not in known and key not in retired_runtime
    ]
    if extra_items:
        output.extend(["", "# Preserved custom advanced settings."])
        output.extend(f"{key}={value}" for key, value in sorted(extra_items))
    return "\n".join(output).rstrip() + "\n"

def reconcile_layered_runtime():
    base_example = config_dir / "runtime.env.example"
    advanced_example = config_dir / "runtime.advanced.env.example"
    base_path = config_dir / "runtime.env"
    advanced_path = config_dir / "runtime.advanced.env"
    base_defaults = assignments(base_example)
    advanced_defaults = assignments(advanced_example)
    base_current = assignments(base_path)
    advanced_current = assignments(advanced_path)

    # Existing single-file runtime values win over newly copied advanced
    # defaults. The retired MinerU alias is migrated once, then removed.
    combined = {**advanced_current, **base_current}
    legacy_mineru_url = combined.get("MINERU_URL", "").strip()
    if legacy_mineru_url and not combined.get("MINERU_SELF_HOSTED_URL", "").strip():
        combined["MINERU_SELF_HOSTED_URL"] = legacy_mineru_url
    combined.pop("MINERU_URL", None)
    for (key, old_value), replacement in known_value_migrations.items():
        if combined.get(key, "").strip() == old_value:
            combined[key] = replacement

    known = set(base_defaults) | set(advanced_defaults) | retired_runtime
    extras = {key: value for key, value in combined.items() if key not in known}
    base_path.write_text(render_example(base_example, combined), encoding="utf-8")
    advanced_path.write_text(
        render_example(advanced_example, combined, extras), encoding="utf-8"
    )
    base_path.chmod(0o600)
    advanced_path.chmod(0o600)
    moved = sum(1 for key in base_current if key in advanced_defaults)
    retired = sum(1 for key in base_current if key in retired_runtime)
    print(
        f"reconciled layered runtime: common={len(base_defaults)} "
        f"advanced={len(advanced_defaults)} moved={moved} retired={retired}"
    )

def reconcile(name, retired):
    example = config_dir / f"{name}.example"
    target = config_dir / name
    example_assignments = [
        parsed
        for line in example.read_text(encoding="utf-8").splitlines()
        if (parsed := assignment(line)) is not None
    ]
    target_lines = target.read_text(encoding="utf-8").splitlines()
    output = []
    seen = set()
    removed = []
    migrated = []
    for line in target_lines:
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

reconcile_layered_runtime()
reconcile("runtime.secret", retired_secrets)
reconcile("bootstrap.env", set())
PY

# One-time migration from legacy monolithic compose .env
if [[ -f "$LEGACY_ENV" ]]; then
	python3 - <<'PY' "$LEGACY_ENV" "$CONFIG_DIR"
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

common_keys = set(parse_env(config_dir / "runtime.env.example"))
advanced_keys = set(parse_env(config_dir / "runtime.advanced.env.example"))
runtime_keys = common_keys | advanced_keys
secret_keys = [
    "POSTGRES_PASSWORD", "UNORAG_SESSION_SECRET",
    "LLM_API_KEY", "MINERU_API_KEY",
    "COS_SECRET_ID", "COS_SECRET_KEY", "COS_SECURITY_TOKEN",
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
# never migrate a host path into either runtime configuration layer.

common_updates = {k: v for k, v in runtime_updates.items() if k in common_keys}
advanced_updates = {k: v for k, v in runtime_updates.items() if k in advanced_keys}

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
    r = upsert(config_dir / "runtime.env", common_updates, only_empty=True)
    a = upsert(
        config_dir / "runtime.advanced.env", advanced_updates, only_empty=True
    )
    s = upsert(config_dir / "runtime.secret", secret_updates, only_empty=True)
    b = upsert(config_dir / "bootstrap.env", bootstrap_updates, only_empty=True)
    marker.write_text("migrated\n", encoding="utf-8")
    marker.chmod(0o600)
    print(
        f"migrated_from_legacy_env keys_runtime={len(r)} "
        f"keys_advanced={len(a)} keys_secret={len(s)} keys_bootstrap={len(b)}"
    )
    print("note: legacy deploy/compose/.env left in place; scripts now prefer deploy/config/*")
PY
fi

# Every new instance gets a unique bootstrap password. Existing values are kept
# so rerunning config reconciliation never rotates a live administrator.
BOOTSTRAP_FILE="${CONFIG_DIR}/bootstrap.env"
BOOTSTRAP_PASSWORD="$(awk -F= '$1 == "UNORAG_ADMIN_PASSWORD" { print substr($0, index($0, "=") + 1) }' "$BOOTSTRAP_FILE")"
if [[ -z "$BOOTSTRAP_PASSWORD" || "$BOOTSTRAP_PASSWORD" == "change-this-before-deployment" ]]; then
	BOOTSTRAP_PASSWORD="Aa$(od -An -N31 -tx1 /dev/urandom | tr -d ' \n')"
	BOOTSTRAP_TMP="$(mktemp "${BOOTSTRAP_FILE}.tmp.XXXXXX")"
	chmod 600 "$BOOTSTRAP_TMP"
	awk -v value="$BOOTSTRAP_PASSWORD" '
		BEGIN { found = 0 }
		$0 ~ /^UNORAG_ADMIN_PASSWORD=/ {
			print "UNORAG_ADMIN_PASSWORD=" value
			found = 1
			next
		}
		{ print }
		END { if (!found) print "UNORAG_ADMIN_PASSWORD=" value }
	' "$BOOTSTRAP_FILE" >"$BOOTSTRAP_TMP"
	mv "$BOOTSTRAP_TMP" "$BOOTSTRAP_FILE"
	chmod 600 "$BOOTSTRAP_FILE"
	echo "generated a unique initial administrator password in ${BOOTSTRAP_FILE}"
fi
unset BOOTSTRAP_PASSWORD BOOTSTRAP_TMP

echo
echo "next:"
echo "  1. Edit ${CONFIG_DIR}/runtime.env"
echo "  2. Review ${CONFIG_DIR}/runtime.advanced.env only when tuning is required"
echo "  3. Fill ${CONFIG_DIR}/runtime.secret (database/session secrets >= 32 characters)"
echo "  4. Review ${CONFIG_DIR}/bootstrap.env (one-time administrator credentials)"
echo "  5. cd ${COMPOSE_DIR} && ./scripts/install.sh"
