"""Ask P0 observability: one retrieval_debug truth → stdout JSON line + turn persist."""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from typing import Any

logger = logging.getLogger(__name__)

# Minimal detail keys per stage — always present (null if unknown). Extra keys allowed.
STAGE_DETAIL_KEYS: dict[str, tuple[str, ...]] = {
	"route": ("path", "route", "decision_reason"),
	"retrieve": (
		"hit_count",
		"top_score",
		"has_table_summary",
		"source_types",
		"table_summary_hits",
		"top_table_summary_score",
	),
	# Product term: 裁决 / adjudicate (keep/upgrade/refuse). New emits use adjudicate only.
	"adjudicate": ("decision", "decision_reason", "upgrade_to"),
	# Legacy stage name: keep for reading historical traces only.
	"gate": ("decision", "decision_reason", "upgrade_to"),
	"table_load": ("load_source", "complete", "table_id"),
	"table_execute": ("operation", "ok", "matched_count"),
	"generate": ("mode", "model", "input_tokens", "output_tokens"),
	"persist": ("ok", "error"),
}


def question_hash(question: str) -> str:
	"""SHA256 of question text, first 16 hex chars. Never log the raw question."""
	return hashlib.sha256((question or "").encode("utf-8")).hexdigest()[:16]


def resolve_trace_id(
	*,
	x_request_id: str | None = None,
	request_id: str | None = None,
) -> str:
	"""Prefer x-request-id / internal request_id; otherwise generate."""
	for candidate in (x_request_id, request_id):
		value = (candidate or "").strip()
		if value and value.lower() != "development":
			return value
	return str(uuid.uuid4())


def normalize_stage_detail(stage: str, detail: dict[str, Any] | None = None) -> dict[str, Any]:
	raw = dict(detail or {})
	out: dict[str, Any] = {}
	for key in STAGE_DETAIL_KEYS.get(stage, ()):
		out[key] = raw[key] if key in raw else None
	for key, value in raw.items():
		if key not in out:
			out[key] = value
	return out


def append_stage(
	debug: dict[str, Any],
	*,
	name: str,
	duration_ms: float | int,
	ok: bool = True,
	detail: dict[str, Any] | None = None,
) -> dict[str, Any]:
	"""Append a timed stage onto retrieval_debug (mutates and returns debug)."""
	stages = list(debug.get("stages") or [])
	stages.append(
		{
			"stage": name,
			"duration_ms": int(round(duration_ms)),
			"ok": bool(ok),
			"detail": normalize_stage_detail(name, detail),
		}
	)
	debug["stages"] = stages
	return debug


def citation_retrieve_detail(citations: list[dict[str, Any]] | None) -> dict[str, Any]:
	"""Build retrieve-stage detail from hit list (source types for adjudication)."""
	items = list(citations or [])
	source_types: list[str] = []
	seen: set[str] = set()
	table_summary_hits = 0
	top_table_summary_score: float | None = None
	for item in items:
		rt = str(item.get("record_type") or "chunk")
		if rt not in seen:
			seen.add(rt)
			source_types.append(rt)
		if rt == "table_summary":
			table_summary_hits += 1
			try:
				score = float(item.get("score") or 0.0)
			except (TypeError, ValueError):
				score = 0.0
			if top_table_summary_score is None or score > top_table_summary_score:
				top_table_summary_score = score
	top_score: float | None = None
	if items:
		try:
			top_score = float(items[0].get("score") or 0.0)
		except (TypeError, ValueError):
			top_score = None
	return {
		"hit_count": len(items),
		"top_score": top_score,
		"has_table_summary": table_summary_hits > 0,
		"source_types": source_types,
		"table_summary_hits": table_summary_hits,
		"top_table_summary_score": top_table_summary_score,
	}


def initial_ask_debug(
	*,
	trace_id: str,
	question: str,
	library_id: str | None,
	requested_mode: str,
	effective_mode: str,
	degraded: bool,
	reasons: list[str],
	session_memory: bool,
	hybrid_enabled: bool,
	stream: bool = False,
) -> dict[str, Any]:
	return {
		"trace_id": trace_id,
		"question_hash": question_hash(question),
		"library_id": library_id,
		"started_at": time.time(),
		"stages": [],
		"requested_mode": requested_mode,
		"effective_mode": effective_mode,
		"degraded": degraded,
		"reasons": list(reasons),
		"session_memory": session_memory,
		"hybrid_enabled": hybrid_enabled,
		"stream": bool(stream),
	}


def finalize_ask_debug(
	debug: dict[str, Any],
	*,
	started_at: float,
	truncated: bool = False,
) -> dict[str, Any]:
	"""Set total_duration_ms at ask/stream end (or disconnect)."""
	debug["total_duration_ms"] = int(round((time.perf_counter() - started_at) * 1000))
	if truncated:
		debug["truncated"] = True
	else:
		debug.pop("truncated", None)
	return debug


def build_ask_trace_event(debug: dict[str, Any]) -> dict[str, Any]:
	"""Project retrieval_debug into a greppable ask.trace JSON line payload."""
	ask_policy = debug.get("ask_policy")
	resolved = (
		ask_policy.get("resolved")
		if isinstance(ask_policy, dict) and isinstance(ask_policy.get("resolved"), dict)
		else {}
	)
	return {
		"event": "ask.trace",
		"trace_id": debug.get("trace_id"),
		"question_hash": debug.get("question_hash"),
		"library_id": debug.get("library_id"),
		"path": debug.get("path"),
		"route": debug.get("route"),
		"upgrade": debug.get("upgrade"),
		"upgrade_reason": debug.get("upgrade_reason"),
		"downgrade_reason": debug.get("downgrade_reason"),
		"precise_gate": debug.get("precise_gate"),
		"refuse_reason": debug.get("refuse_reason"),
		"total_duration_ms": debug.get("total_duration_ms"),
		"truncated": bool(debug.get("truncated")),
		"stages": list(debug.get("stages") or []),
		# Resolved product knobs used for this ask (hybrid/rerank must be concrete).
		"ask_policy": ask_policy if isinstance(ask_policy, dict) else None,
		"hybrid_enabled": debug.get("hybrid_enabled", resolved.get("hybrid_enabled")),
		"rerank_enabled": debug.get("rerank_enabled", resolved.get("rerank_enabled")),
	}


def emit_ask_trace(debug: dict[str, Any]) -> None:
	"""Stdout one JSON line with event=ask.trace (also mirrored to logger)."""
	payload = build_ask_trace_event(debug)
	line = json.dumps(payload, ensure_ascii=False, default=str)
	print(line, flush=True)
	logger.info("%s", line)


# Keys that must never leave the control plane via archive/debug APIs.
_SECRET_KEY_FRAGMENTS = (
	"api_key",
	"apikey",
	"authorization",
	"password",
	"secret",
	"access_token",
	"refresh_token",
	"private_key",
	"bearer",
)


def _is_secret_key(key: str) -> bool:
	"""True for underscore-private or credential-shaped keys."""
	if key.startswith("_"):
		return True
	lower = key.lower().replace("-", "_")
	if lower in _SECRET_KEY_FRAGMENTS:
		return True
	return any(fragment in lower for fragment in _SECRET_KEY_FRAGMENTS)


def sanitize_retrieval_debug(debug: dict[str, Any] | None) -> dict[str, Any] | None:
	"""Return archive/debug-safe retrieval_debug (UI-homologous, no secrets).

	Keeps adjudicate stages, citation_adjudication, path/route/upgrade, etc.
	Drops private `_…` keys (e.g. full evidence row indices) and credential fields.
	"""
	if not isinstance(debug, dict):
		return None

	def _clean(value: Any) -> Any:
		if isinstance(value, dict):
			out: dict[str, Any] = {}
			for key, item in value.items():
				if not isinstance(key, str) or _is_secret_key(key):
					continue
				out[key] = _clean(item)
			return out
		if isinstance(value, list):
			return [_clean(item) for item in value]
		return value

	cleaned = _clean(debug)
	return cleaned if isinstance(cleaned, dict) else None
