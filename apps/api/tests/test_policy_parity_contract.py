"""Load shared policy-parity fixtures against Python policy_profiles."""

from __future__ import annotations

import json
from pathlib import Path

from app.services.ask_defaults import ASK_OVERRIDE_KEYS
from app.services.policy_profiles import (
	migrate_legacy_ask_to_public,
	resolve_ask_policy,
	resolve_document_policy,
)

# apps/api/tests → UnoRAG/
REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "tests" / "contracts" / "policy-parity" / "fixtures.json"


def _load_cases() -> list[dict]:
	payload = json.loads(FIXTURES.read_text(encoding="utf-8"))
	assert payload["cases"], "fixtures must contain cases"
	return payload["cases"]


def test_policy_parity_fixtures_exist_and_cover_kinds() -> None:
	cases = _load_cases()
	kinds = {c["kind"] for c in cases}
	assert kinds >= {
		"ask_resolve",
		"ask_migrate",
		"document_resolve",
		"override_keys",
	}


def test_policy_parity_python_resolves_all_fixture_cases() -> None:
	"""Each fixture case must be executable on the Python side (local green)."""
	for case in _load_cases():
		kind = case["kind"]
		inp = case.get("input") or {}
		if kind == "ask_resolve":
			snap = resolve_ask_policy(
				inp.get("raw"),
				question=inp.get("question"),
				policy_version=inp.get("policy_version"),
			).snapshot()
			assert "public" in snap and "resolved" in snap
		elif kind == "ask_migrate":
			public = migrate_legacy_ask_to_public(inp.get("raw"))
			assert "answer_profile" in public
		elif kind == "document_resolve":
			doc = resolve_document_policy(
				document_profile=inp.get("document_profile"),
				scan_handling=inp.get("scan_handling"),
				parse_preference=inp.get("parse_preference"),
			).as_dict()
			assert "chunk_profile" in doc
		elif kind == "override_keys":
			assert list(ASK_OVERRIDE_KEYS) == [
				"retrieve_top_k",
				"answer_min_score",
				"hybrid_enabled",
				"rerank_enabled",
				"citation_adjudicate_enabled",
				"citation_adjudicate_absolute_floor",
				"session_memory_enabled",
				"session_memory_max_turns",
			]
		else:
			raise AssertionError(f"unknown kind {kind}")
