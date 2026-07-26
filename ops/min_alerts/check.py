#!/usr/bin/env python3
"""MeriKnow minimum alerts: evaluate five signals and POST to a webhook.

Signals:
  1. health.qdrant_ask   — /health qdrant_ok=false or ask_ready=false
  2. worker.heartbeat    — LIFECYCLE_WORKER_READY_FILE missing or stale
  3. jobs.dead_stuck     — dead/stuck job count grew vs baseline
  4. ask.http_5xx        — Ask probe returns 5xx/503 (optional cookie jar)
  5. disk.usage          — documents / postgres / qdrant path > threshold

Env (also CLI flags):
  ALERT_WEBHOOK_URL              required for notify (unless --dry-run)
  MERIKNOW_HEALTH_URL            default http://127.0.0.1:3000/api/rag/health
  MERIKNOW_ALERT_ASK_PROBE_URL   optional Ask probe URL
  MERIKNOW_ALERT_ASK_PROBE_BODY  JSON body for Ask probe
  MERIKNOW_ALERT_ASK_COOKIE_JAR  Netscape cookie jar for Ask probe
  DATABASE_URL                   for dead/stuck SQL (preferred over lifecycle JSON)
  LIFECYCLE_WORKER_READY_FILE    heartbeat file path
  DOCUMENT_STORAGE_ROOT          documents disk path
  MERIKNOW_ALERT_DISK_PATHS      JSON {"documents":"...","postgres":"...","qdrant":"..."}
  MERIKNOW_ALERT_DISK_FORCE_PERCENT  int — force all disk signals (acceptance inject)
  MERIKNOW_ALERT_STATE_FILE      default /tmp/meriknow-min-alerts-state.json
  MERIKNOW_ALERT_DISK_THRESHOLD  default 85
  MERIKNOW_ALERT_HEARTBEAT_MAX_AGE_SEC  default 120
  MERIKNOW_ALERT_SEVERITY        default warning

Usage:
  python ops/min_alerts/check.py once
  python ops/min_alerts/check.py watch --interval 30
  python ops/min_alerts/check.py mock-receiver --port 18999 --out /tmp/alerts.jsonl
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

SIGNAL_HEALTH = "health.qdrant_ask"
SIGNAL_WORKER = "worker.heartbeat"
SIGNAL_JOBS = "jobs.dead_stuck"
SIGNAL_ASK = "ask.http_5xx"
SIGNAL_DISK = "disk.usage"
ALL_SIGNALS = (SIGNAL_HEALTH, SIGNAL_WORKER, SIGNAL_JOBS, SIGNAL_ASK, SIGNAL_DISK)


def utc_now() -> str:
	return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def env(name: str, default: str = "") -> str:
	return os.environ.get(name, default).strip()


def load_json_file(path: Path) -> dict[str, Any]:
	if not path.exists():
		return {}
	try:
		data = json.loads(path.read_text(encoding="utf-8"))
	except Exception:
		return {}
	return data if isinstance(data, dict) else {}


def save_json_file(path: Path, data: dict[str, Any]) -> None:
	path.parent.mkdir(parents=True, exist_ok=True)
	tmp = path.with_suffix(path.suffix + ".tmp")
	tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
	os.chmod(tmp, 0o600)
	tmp.replace(path)


def http_json(
	url: str,
	*,
	method: str = "GET",
	body: bytes | None = None,
	headers: dict[str, str] | None = None,
	timeout: float = 8.0,
	cookie_jar: Path | None = None,
) -> tuple[int, dict[str, str], Any]:
	hdrs = {"Accept": "application/json", "User-Agent": "meriknow-min-alerts/1"}
	if headers:
		hdrs.update(headers)
	if cookie_jar and cookie_jar.exists():
		# Minimal Netscape jar reader (incl. #HttpOnly_ lines from curl -c).
		host = urlparse(url).hostname or ""
		cookies: list[str] = []
		for line in cookie_jar.read_text(encoding="utf-8").splitlines():
			if not line.strip():
				continue
			if line.startswith("#HttpOnly_"):
				line = line[len("#HttpOnly_") :]
			elif line.startswith("#"):
				continue
			parts = line.split("\t")
			if len(parts) >= 7:
				domain, _flag, _path, _secure, _exp, name, value = parts[:7]
				domain = domain.lstrip(".")
				if (
					not domain
					or host == domain
					or host.endswith("." + domain)
					or domain == "localhost"
					or host in {"localhost", "127.0.0.1"}
				):
					cookies.append(f"{name}={value}")
			elif "=" in line:
				cookies.append(line.strip())
		if cookies:
			hdrs["Cookie"] = "; ".join(cookies)
	req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
	try:
		with urllib.request.urlopen(req, timeout=timeout) as resp:
			raw = resp.read()
			resp_headers = {k.lower(): v for k, v in resp.headers.items()}
			code = int(resp.status)
	except urllib.error.HTTPError as exc:
		raw = exc.read() if exc.fp else b""
		resp_headers = {k.lower(): v for k, v in (exc.headers.items() if exc.headers else [])}
		code = int(exc.code)
	except Exception as exc:
		return 0, {}, {"_error": str(exc)}
	text = raw.decode("utf-8", errors="replace") if raw else ""
	try:
		payload: Any = json.loads(text) if text else {}
	except Exception:
		payload = {"_raw": text[:2000]}
	return code, resp_headers, payload


def post_webhook(url: str, payload: dict[str, Any], timeout: float = 8.0) -> tuple[int, str]:
	data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
	code, _hdrs, body = http_json(
		url,
		method="POST",
		body=data,
		headers={"Content-Type": "application/json"},
		timeout=timeout,
	)
	note = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)[:300]
	return code, note


def disk_usage_percent(path: str) -> float | None:
	p = Path(path)
	if not p.exists():
		return None
	try:
		usage = shutil.disk_usage(p)
	except Exception:
		return None
	if usage.total <= 0:
		return None
	return round(100.0 * (usage.used / usage.total), 2)


def query_jobs(database_url: str) -> dict[str, Any]:
	"""Return dead/stuck summaries using psycopg if available."""
	dsn = database_url.replace("postgresql+psycopg://", "postgresql://", 1)
	try:
		import psycopg
	except ImportError as exc:
		raise RuntimeError("psycopg not installed; set PYTHONPATH to apps/api .venv") from exc
	with psycopg.connect(dsn) as conn:
		with conn.cursor() as cur:
			cur.execute(
				"""
				SELECT id::text, type, status, error_code, workspace_id::text,
				       organization_id::text, updated_at
				FROM app.jobs
				WHERE status = 'dead'
				ORDER BY updated_at DESC
				LIMIT 50
				"""
			)
			dead_rows = [
				{
					"id": r[0],
					"type": r[1],
					"status": r[2],
					"error_code": r[3],
					"workspace_id": r[4],
					"organization_id": r[5],
					"updated_at": r[6].isoformat() if r[6] else None,
				}
				for r in cur.fetchall()
			]
			cur.execute(
				"""
				SELECT id::text, type, status, stage, claimed_by, workspace_id::text,
				       organization_id::text, lease_expires_at, heartbeat_at, updated_at
				FROM app.jobs
				WHERE status IN ('running', 'cancelling')
				  AND (
				    lease_expires_at <= now()
				    OR heartbeat_at < now() - interval '10 minutes'
				  )
				ORDER BY lease_expires_at NULLS FIRST, updated_at
				LIMIT 50
				"""
			)
			stuck_rows = [
				{
					"id": r[0],
					"type": r[1],
					"status": r[2],
					"stage": r[3],
					"claimed_by": r[4],
					"workspace_id": r[5],
					"organization_id": r[6],
					"lease_expires_at": r[7].isoformat() if r[7] else None,
					"heartbeat_at": r[8].isoformat() if r[8] else None,
					"updated_at": r[9].isoformat() if r[9] else None,
				}
				for r in cur.fetchall()
			]
	return {
		"dead_count": len(dead_rows),
		"stuck_count": len(stuck_rows),
		"dead_jobs": dead_rows,
		"stuck_jobs": stuck_rows,
	}


def evaluate(cfg: dict[str, Any], state: dict[str, Any]) -> list[dict[str, Any]]:
	"""Return list of signal evaluations: {name, firing, labels, annotations}."""
	results: list[dict[str, Any]] = []

	# 1) Health
	health_url = cfg["health_url"]
	code, _h, health = http_json(health_url)
	qok = health.get("qdrant_ok") if isinstance(health, dict) else None
	ask_ready = health.get("ask_ready") if isinstance(health, dict) else None
	health_firing = (
		code == 0
		or code >= 500
		or qok is False
		or ask_ready is False
		or (isinstance(health, dict) and health.get("status") == "unavailable")
	)
	results.append(
		{
			"name": SIGNAL_HEALTH,
			"firing": bool(health_firing),
			"labels": {"signal": SIGNAL_HEALTH, "namespace": cfg["namespace"]},
			"annotations": {
				"summary": "Qdrant/Ask health unavailable"
				if health_firing
				else "Qdrant/Ask health OK",
				"health_url": health_url,
				"http_status": str(code),
				"qdrant_ok": json.dumps(qok),
				"ask_ready": json.dumps(ask_ready),
				"reasons": json.dumps(
					(health.get("reasons") if isinstance(health, dict) else [])[:8],
					ensure_ascii=False,
				),
				"workspace_id": cfg.get("default_workspace_id") or "",
			},
		}
	)

	# 2) Worker heartbeat
	ready = Path(cfg["ready_file"]) if cfg["ready_file"] else None
	max_age = float(cfg["heartbeat_max_age_sec"])
	worker_firing = False
	age = None
	worker_id = str(state.get("last_worker_id") or "")
	if ready is None:
		# Not configured → treat as skipped (not firing); acceptance always sets it.
		worker_detail = "LIFECYCLE_WORKER_READY_FILE unset (skip)"
	elif not ready.exists():
		worker_firing = True
		worker_detail = f"ready file missing: {ready}"
	else:
		age = max(0.0, time.time() - ready.stat().st_mtime)
		try:
			worker_id = ready.read_text(encoding="utf-8").splitlines()[0].strip() or worker_id
		except Exception:
			pass
		if worker_id:
			state["last_worker_id"] = worker_id
		if age > max_age:
			worker_firing = True
			worker_detail = f"heartbeat stale age_sec={age:.1f} > {max_age}"
		else:
			worker_detail = f"heartbeat ok age_sec={age:.1f} worker_id={worker_id}"
	results.append(
		{
			"name": SIGNAL_WORKER,
			"firing": worker_firing,
			"labels": {"signal": SIGNAL_WORKER, "namespace": cfg["namespace"]},
			"annotations": {
				"summary": "lifecycle worker heartbeat lost"
				if worker_firing
				else "lifecycle worker heartbeat OK",
				"detail": worker_detail,
				"ready_file": str(ready) if ready else "",
				"age_sec": "" if age is None else f"{age:.1f}",
				"worker_id": worker_id,
				"workspace_id": cfg.get("default_workspace_id") or "",
			},
		}
	)

	# 3) Dead / stuck growth
	jobs_info: dict[str, Any] = {"dead_count": 0, "stuck_count": 0, "dead_jobs": [], "stuck_jobs": []}
	jobs_error = ""
	if cfg.get("lifecycle_json"):
		lj = load_json_file(Path(cfg["lifecycle_json"]))
		summary = lj.get("summary") if isinstance(lj.get("summary"), dict) else {}
		jobs_info = {
			"dead_count": int(summary.get("dead_jobs") or len(lj.get("dead_jobs") or [])),
			"stuck_count": int(summary.get("stuck_jobs") or len(lj.get("stuck_jobs") or [])),
			"dead_jobs": lj.get("dead_jobs") or [],
			"stuck_jobs": lj.get("stuck_jobs") or [],
		}
	elif cfg.get("database_url"):
		try:
			jobs_info = query_jobs(cfg["database_url"])
		except Exception as exc:
			jobs_error = str(exc)
	baseline = state.setdefault("jobs_baseline", {})
	if "dead" not in baseline or "stuck" not in baseline:
		baseline["dead"] = int(jobs_info["dead_count"])
		baseline["stuck"] = int(jobs_info["stuck_count"])
		baseline["set_at"] = utc_now()
		jobs_firing = False
		jobs_summary = (
			f"baseline set dead={baseline['dead']} stuck={baseline['stuck']}"
			+ (f" err={jobs_error}" if jobs_error else "")
		)
	else:
		dead_growth = int(jobs_info["dead_count"]) - int(baseline["dead"])
		stuck_growth = int(jobs_info["stuck_count"]) - int(baseline["stuck"])
		# Fire when dead or stuck exceeds the baseline snapshot.
		jobs_firing = dead_growth > 0 or stuck_growth > 0
		jobs_summary = (
			f"dead={jobs_info['dead_count']}(base {baseline['dead']}, Δ{dead_growth}) "
			f"stuck={jobs_info['stuck_count']}(base {baseline['stuck']}, Δ{stuck_growth})"
			+ (f" err={jobs_error}" if jobs_error else "")
		)
	sample = (jobs_info.get("stuck_jobs") or jobs_info.get("dead_jobs") or [{}])[0]
	results.append(
		{
			"name": SIGNAL_JOBS,
			"firing": bool(jobs_firing) and not jobs_error,
			"labels": {"signal": SIGNAL_JOBS, "namespace": cfg["namespace"]},
			"annotations": {
				"summary": "dead/stuck jobs grew" if jobs_firing else "dead/stuck jobs stable",
				"detail": jobs_summary,
				"job_id": str(sample.get("id") or ""),
				"workspace_id": str(
					sample.get("workspace_id") or cfg.get("default_workspace_id") or ""
				),
				"organization_id": str(sample.get("organization_id") or ""),
				"error_code": str(sample.get("error_code") or ""),
				"dead_count": str(jobs_info["dead_count"]),
				"stuck_count": str(jobs_info["stuck_count"]),
			},
		}
	)

	# 4) Ask 5xx / 503
	ask_firing = False
	ask_detail = "ask probe not configured (skip)"
	trace_id = ""
	ask_http = ""
	probe_url = cfg.get("ask_probe_url") or ""
	if probe_url:
		body_raw = (cfg.get("ask_probe_body") or "").encode("utf-8")
		cookie = Path(cfg["ask_cookie_jar"]) if cfg.get("ask_cookie_jar") else None
		acode, ahdrs, abody = http_json(
			probe_url,
			method="POST",
			body=body_raw or b"{}",
			headers={"Content-Type": "application/json"},
			cookie_jar=cookie,
			timeout=15.0,
		)
		ask_http = str(acode)
		trace_candidates: list[str] = []
		if isinstance(abody, dict):
			debug = abody.get("debug") if isinstance(abody.get("debug"), dict) else {}
			detail = abody.get("detail") if isinstance(abody.get("detail"), dict) else {}
			for key in (
				abody.get("trace_id"),
				abody.get("request_id"),
				debug.get("trace_id"),
				detail.get("trace_id"),
				detail.get("request_id"),
			):
				if key:
					trace_candidates.append(str(key))
		for key in (ahdrs.get("x-request-id"), ahdrs.get("x-trace-id")):
			if key:
				trace_candidates.append(str(key))
		trace_id = next((t for t in trace_candidates if t), "")
		ask_firing = acode >= 500 or acode == 503 or acode == 0
		ask_detail = f"ask probe HTTP {acode}"
		if isinstance(abody, dict):
			hint = abody.get("message") or abody.get("detail") or abody.get("error")
			if isinstance(hint, dict):
				hint = hint.get("message") or json.dumps(hint, ensure_ascii=False)[:160]
			if hint:
				ask_detail += f" detail={str(hint)[:160]}"
	results.append(
		{
			"name": SIGNAL_ASK,
			"firing": bool(ask_firing),
			"labels": {"signal": SIGNAL_ASK, "namespace": cfg["namespace"]},
			"annotations": {
				"summary": "Ask 5xx/503 anomaly" if ask_firing else "Ask probe OK/skipped",
				"detail": ask_detail,
				"http_status": ask_http,
				"trace_id": trace_id,
				"workspace_id": cfg.get("default_workspace_id") or "",
				"ask_probe_url": probe_url,
			},
		}
	)

	# 5) Disk usage
	threshold = float(cfg["disk_threshold"])
	force = cfg.get("disk_force_percent")
	paths: dict[str, str] = dict(cfg.get("disk_paths") or {})
	disk_parts: list[str] = []
	disk_firing = False
	worst = 0.0
	for name, path in paths.items():
		if force is not None:
			pct = float(force)
		else:
			pct_val = disk_usage_percent(path)
			pct = -1.0 if pct_val is None else pct_val
		if pct >= threshold:
			disk_firing = True
		worst = max(worst, pct)
		disk_parts.append(f"{name}={pct}% path={path}")
	results.append(
		{
			"name": SIGNAL_DISK,
			"firing": disk_firing,
			"labels": {"signal": SIGNAL_DISK, "namespace": cfg["namespace"]},
			"annotations": {
				"summary": f"disk usage over {threshold:.0f}%"
				if disk_firing
				else f"disk usage under {threshold:.0f}%",
				"detail": "; ".join(disk_parts) or "no disk paths configured",
				"threshold": str(threshold),
				"worst_percent": str(worst),
				"forced": "true" if force is not None else "false",
				"workspace_id": cfg.get("default_workspace_id") or "",
			},
		}
	)
	return results


def build_payload(
	*,
	signal: dict[str, Any],
	status: str,
	severity: str,
	starts_at: str,
	ends_at: str | None,
) -> dict[str, Any]:
	ann = dict(signal.get("annotations") or {})
	labels = dict(signal.get("labels") or {})
	ns = str(labels.get("namespace") or "meriknow")
	return {
		"version": "meriknow.min_alerts/1",
		"status": status,
		"alert_name": signal["name"],
		"namespace": ns,
		"fingerprint": f"{signal['name']}:{ns}",
		"severity": severity,
		"starts_at": starts_at,
		"ends_at": ends_at,
		"labels": labels,
		"annotations": ann,
		# Flatten common locator keys for receivers that don't nest.
		"workspace_id": ann.get("workspace_id") or "",
		"organization_id": ann.get("organization_id") or "",
		"trace_id": ann.get("trace_id") or "",
		"job_id": ann.get("job_id") or "",
		"request_id": ann.get("request_id") or ann.get("trace_id") or "",
		"worker_id": ann.get("worker_id") or "",
	}


def apply_transitions(
	evals: list[dict[str, Any]],
	state: dict[str, Any],
	*,
	webhook_url: str,
	severity: str,
	dry_run: bool,
) -> list[dict[str, Any]]:
	alerts_state: dict[str, Any] = state.setdefault("alerts", {})
	events: list[dict[str, Any]] = []
	for signal in evals:
		name = signal["name"]
		prev = alerts_state.get(name) or {"status": "resolved"}
		prev_status = prev.get("status") or "resolved"
		now = utc_now()
		if signal["firing"]:
			starts = prev.get("starts_at") if prev_status == "firing" else now
			if prev_status != "firing":
				payload = build_payload(
					signal=signal,
					status="firing",
					severity=severity,
					starts_at=starts or now,
					ends_at=None,
				)
				delivery = {"skipped": True, "reason": "dry_run"} if dry_run else None
				if not dry_run:
					if not webhook_url:
						delivery = {"ok": False, "error": "ALERT_WEBHOOK_URL empty"}
					else:
						code, note = post_webhook(webhook_url, payload)
						delivery = {"ok": 200 <= code < 300, "http_status": code, "note": note}
				events.append({"transition": "firing", "payload": payload, "delivery": delivery})
				alerts_state[name] = {
					"status": "firing",
					"starts_at": starts or now,
					"last_annotations": signal.get("annotations"),
				}
			else:
				alerts_state[name] = {
					"status": "firing",
					"starts_at": starts or now,
					"last_annotations": signal.get("annotations"),
				}
		else:
			if prev_status == "firing":
				payload = build_payload(
					signal=signal,
					status="resolved",
					severity=severity,
					starts_at=str(prev.get("starts_at") or now),
					ends_at=now,
				)
				delivery = {"skipped": True, "reason": "dry_run"} if dry_run else None
				if not dry_run:
					if not webhook_url:
						delivery = {"ok": False, "error": "ALERT_WEBHOOK_URL empty"}
					else:
						code, note = post_webhook(webhook_url, payload)
						delivery = {"ok": 200 <= code < 300, "http_status": code, "note": note}
				events.append({"transition": "resolved", "payload": payload, "delivery": delivery})
			alerts_state[name] = {
				"status": "resolved",
				"starts_at": None,
				"last_annotations": signal.get("annotations"),
				"resolved_at": now if prev_status == "firing" else prev.get("resolved_at"),
			}
	state["updated_at"] = utc_now()
	return events


def build_config(args: argparse.Namespace) -> dict[str, Any]:
	disk_paths: dict[str, str] = {}
	raw_paths = env("MERIKNOW_ALERT_DISK_PATHS")
	if raw_paths:
		try:
			disk_paths = {str(k): str(v) for k, v in json.loads(raw_paths).items()}
		except Exception as exc:
			raise SystemExit(f"invalid MERIKNOW_ALERT_DISK_PATHS: {exc}") from exc
	doc_root = args.document_root or env("DOCUMENT_STORAGE_ROOT")
	if doc_root and "documents" not in disk_paths:
		disk_paths["documents"] = doc_root
	# Sensible local defaults for docker named volumes (host view may vary).
	if "postgres" not in disk_paths and args.postgres_path:
		disk_paths["postgres"] = args.postgres_path
	if "qdrant" not in disk_paths and args.qdrant_path:
		disk_paths["qdrant"] = args.qdrant_path
	# If still missing postgres/qdrant, fall back to documents parent / repo data root.
	force = args.disk_force_percent
	if force is None and env("MERIKNOW_ALERT_DISK_FORCE_PERCENT"):
		force = float(env("MERIKNOW_ALERT_DISK_FORCE_PERCENT"))
	return {
		"webhook_url": args.webhook_url or env("ALERT_WEBHOOK_URL"),
		"health_url": args.health_url
		or env("MERIKNOW_HEALTH_URL", "http://127.0.0.1:3000/api/rag/health"),
		"ask_probe_url": args.ask_probe_url or env("MERIKNOW_ALERT_ASK_PROBE_URL"),
		"ask_probe_body": args.ask_probe_body
		or env(
			"MERIKNOW_ALERT_ASK_PROBE_BODY",
			'{"library_id":"00000000-0000-4000-8000-000000000099","question":"min-alert probe"}',
		),
		"ask_cookie_jar": args.ask_cookie_jar or env("MERIKNOW_ALERT_ASK_COOKIE_JAR"),
		"database_url": args.database_url or env("DATABASE_URL") or env("WORKER_DATABASE_URL"),
		"lifecycle_json": args.lifecycle_json or env("MERIKNOW_ALERT_LIFECYCLE_JSON"),
		"ready_file": args.ready_file or env("LIFECYCLE_WORKER_READY_FILE"),
		"disk_paths": disk_paths,
		"disk_threshold": float(
			args.disk_threshold
			if args.disk_threshold is not None
			else env("MERIKNOW_ALERT_DISK_THRESHOLD", "85")
		),
		"disk_force_percent": force,
		"heartbeat_max_age_sec": float(
			args.heartbeat_max_age_sec
			if args.heartbeat_max_age_sec is not None
			else env("MERIKNOW_ALERT_HEARTBEAT_MAX_AGE_SEC", "120")
		),
		"state_file": args.state_file
		or env("MERIKNOW_ALERT_STATE_FILE", "/tmp/meriknow-min-alerts-state.json"),
		"severity": args.severity or env("MERIKNOW_ALERT_SEVERITY", "warning"),
		"namespace": args.namespace or env("MERIKNOW_ALERT_NAMESPACE", "meriknow"),
		"default_workspace_id": args.workspace_id
		or env("DEFAULT_WORKSPACE_ID")
		or env("MERIKNOW_WORKSPACE_ID"),
		"dry_run": bool(args.dry_run),
	}


def cmd_once(args: argparse.Namespace) -> int:
	cfg = build_config(args)
	state_path = Path(cfg["state_file"])
	state = load_json_file(state_path)
	evals = evaluate(cfg, state)
	events = apply_transitions(
		evals,
		state,
		webhook_url=cfg["webhook_url"],
		severity=cfg["severity"],
		dry_run=cfg["dry_run"],
	)
	save_json_file(state_path, state)
	out = {
		"evaluated_at": utc_now(),
		"signals": [
			{
				"name": e["name"],
				"firing": e["firing"],
				"annotations": e["annotations"],
			}
			for e in evals
		],
		"events": events,
		"state_file": str(state_path),
	}
	print(json.dumps(out, ensure_ascii=False, indent=2))
	# Exit 0 even when firing (monitoring tool); use --fail-on-firing for CI.
	if args.fail_on_firing and any(e["firing"] for e in evals):
		return 1
	bad = [ev for ev in events if ev.get("delivery") and ev["delivery"].get("ok") is False]
	if bad:
		return 1
	return 0


def cmd_watch(args: argparse.Namespace) -> int:
	interval = max(5, int(args.interval))
	while True:
		rc = cmd_once(args)
		if args.exit_on_error and rc != 0:
			return rc
		time.sleep(interval)


def cmd_mock_receiver(args: argparse.Namespace) -> int:
	out_path = Path(args.out)
	out_path.parent.mkdir(parents=True, exist_ok=True)
	if not out_path.exists():
		out_path.write_text("", encoding="utf-8")
		os.chmod(out_path, 0o600)

	class Handler(BaseHTTPRequestHandler):
		def log_message(self, fmt: str, *a: Any) -> None:
			sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % a))

		def do_POST(self) -> None:  # noqa: N802
			length = int(self.headers.get("Content-Length") or 0)
			raw = self.rfile.read(length) if length else b"{}"
			try:
				payload = json.loads(raw.decode("utf-8"))
			except Exception:
				payload = {"_raw": raw.decode("utf-8", errors="replace")[:4000]}
			rec = {
				"received_at": utc_now(),
				"path": self.path,
				"payload": payload,
			}
			with out_path.open("a", encoding="utf-8") as f:
				f.write(json.dumps(rec, ensure_ascii=False) + "\n")
			body = b'{"ok":true}\n'
			self.send_response(200)
			self.send_header("Content-Type", "application/json")
			self.send_header("Content-Length", str(len(body)))
			self.end_headers()
			self.wfile.write(body)

		def do_GET(self) -> None:  # noqa: N802
			body = b'{"ok":true,"service":"meriknow-min-alerts-mock"}\n'
			self.send_response(200)
			self.send_header("Content-Type", "application/json")
			self.send_header("Content-Length", str(len(body)))
			self.end_headers()
			self.wfile.write(body)

	server = ThreadingHTTPServer((args.host, int(args.port)), Handler)
	print(
		json.dumps(
			{
				"mock_receiver": True,
				"listen": f"http://{args.host}:{args.port}/",
				"out": str(out_path),
			}
		),
		flush=True,
	)
	try:
		server.serve_forever()
	except KeyboardInterrupt:
		pass
	finally:
		server.server_close()
	return 0


def build_parser() -> argparse.ArgumentParser:
	p = argparse.ArgumentParser(description="MeriKnow minimum alerts checker")
	sub = p.add_subparsers(dest="cmd", required=True)

	def add_common(sp: argparse.ArgumentParser) -> None:
		sp.add_argument("--webhook-url", default="")
		sp.add_argument("--health-url", default="")
		sp.add_argument("--ask-probe-url", default="")
		sp.add_argument("--ask-probe-body", default="")
		sp.add_argument("--ask-cookie-jar", default="")
		sp.add_argument("--database-url", default="")
		sp.add_argument("--lifecycle-json", default="")
		sp.add_argument("--ready-file", default="")
		sp.add_argument("--document-root", default="")
		sp.add_argument("--postgres-path", default="")
		sp.add_argument("--qdrant-path", default="")
		sp.add_argument("--state-file", default="")
		sp.add_argument("--workspace-id", default="")
		sp.add_argument("--severity", default="")
		sp.add_argument("--namespace", default="")
		sp.add_argument("--disk-threshold", type=float, default=None)
		sp.add_argument("--disk-force-percent", type=float, default=None)
		sp.add_argument("--heartbeat-max-age-sec", type=float, default=None)
		sp.add_argument("--dry-run", action="store_true")
		sp.add_argument("--fail-on-firing", action="store_true")

	once = sub.add_parser("once", help="Evaluate once and notify on transitions")
	add_common(once)
	once.set_defaults(func=cmd_once)

	watch = sub.add_parser("watch", help="Loop evaluate")
	add_common(watch)
	watch.add_argument("--interval", type=int, default=30)
	watch.add_argument("--exit-on-error", action="store_true")
	watch.set_defaults(func=cmd_watch)

	mock = sub.add_parser("mock-receiver", help="Local webhook sink writing JSONL")
	mock.add_argument("--host", default="127.0.0.1")
	mock.add_argument("--port", type=int, default=18999)
	mock.add_argument("--out", required=True)
	mock.set_defaults(func=cmd_mock_receiver)
	return p


def main(argv: list[str] | None = None) -> int:
	parser = build_parser()
	args = parser.parse_args(argv)
	return int(args.func(args))


if __name__ == "__main__":
	raise SystemExit(main())
