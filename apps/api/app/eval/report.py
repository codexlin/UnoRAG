"""Release gate report schema and builders."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.eval.schemas import EvalCase, EvalCaseResult
from app.settings import Settings


def dataset_fingerprint(path: Path) -> str:
	digest = hashlib.sha256()
	digest.update(path.read_bytes())
	return digest.hexdigest()


def git_commit(repo_root: Path | None = None) -> str | None:
	root = repo_root or Path(__file__).resolve().parents[4]
	try:
		completed = subprocess.run(
			["git", "rev-parse", "HEAD"],
			cwd=root,
			check=True,
			capture_output=True,
			text=True,
		)
		return completed.stdout.strip() or None
	except Exception:
		return os.environ.get("GITHUB_SHA") or os.environ.get("GIT_COMMIT")


def dependency_versions() -> dict[str, str]:
	versions: dict[str, str] = {}
	for name in ("fastapi", "pydantic", "qdrant_client", "langchain_core", "langgraph"):
		try:
			module = __import__(name)
			versions[name] = str(getattr(module, "__version__", "unknown"))
		except Exception:
			versions[name] = "unavailable"
	return versions


def settings_snapshot(settings: Settings | None = None) -> dict[str, Any]:
	resolved = settings or Settings()
	return {
		"ask_mode": resolved.ask_mode,
		"chat_model": resolved.chat_model,
		"embedding_model": resolved.embedding_model,
		"embedding_dim": resolved.embedding_dim,
		"hybrid_enabled": resolved.hybrid_enabled,
		"rerank_enabled": resolved.rerank_enabled,
		"active_generation_gate_enabled": resolved.active_generation_gate_enabled,
		"legacy_ingest_writes_enabled": resolved.legacy_ingest_writes_enabled,
		"mineru_enabled": resolved.mineru_enabled,
		"pipeline_note": "lifecycle-v2",
	}


def build_release_report(
	*,
	mode: str,
	cases_path: Path,
	cases: list[EvalCase],
	results: list[EvalCaseResult],
	layer_metrics: dict[str, dict[str, float | int]],
	fuses: dict[str, Any],
	baseline_compare: dict[str, Any],
	baseline_path: Path | None = None,
	settings: Settings | None = None,
) -> dict[str, Any]:
	passed = sum(1 for item in results if item.ok)
	failed = [item for item in results if not item.ok]
	gate_ok = (
		not failed
		and not fuses.get("tripped")
		and not baseline_compare.get("blocked")
	)
	return {
		"schema_version": "meriknow.release_gate.v1",
		"generated_at": datetime.now(timezone.utc).isoformat(),
		"mode": mode,
		"gate_ok": gate_ok,
		"git_commit": git_commit(),
		"dataset": {
			"path": str(cases_path),
			"sha256": dataset_fingerprint(cases_path),
			"case_count": len(cases),
		},
		"baseline_path": str(baseline_path) if baseline_path else None,
		"config": settings_snapshot(settings),
		"dependencies": dependency_versions(),
		"summary": {
			"total": len(results),
			"passed": passed,
			"failed": len(failed),
		},
		"layers": layer_metrics,
		"fuses": fuses,
		"baseline_compare": baseline_compare,
		"failures": [
			{
				"id": item.id,
				"kind": item.kind,
				"errors": list(item.errors),
				"observed": item.observed,
			}
			for item in failed
		],
	}


def write_report(path: Path, report: dict[str, Any]) -> None:
	path.parent.mkdir(parents=True, exist_ok=True)
	path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
