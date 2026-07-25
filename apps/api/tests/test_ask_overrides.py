from __future__ import annotations

import os

from app.graph import AskGraphService
from app.graph.ask_graph import stub_generate
from app.services.ask_defaults import ASK_DEFAULTS, ASK_OVERRIDE_KEYS
from app.services.ask_overrides import effective_ask_settings, has_ask_overrides
from app.settings import Settings, get_settings


def test_effective_ask_settings_merges_only_set_keys() -> None:
	base = Settings(_env_file=None)
	effective = effective_ask_settings(
		base,
		{
			"retrieve_top_k": 3,
			"hybrid_enabled": True,
			"answer_min_score": None,  # unset → keep code default
			"unknown": 99,
		},
	)
	assert effective.retrieve_top_k == 3
	assert effective.hybrid_enabled is True
	assert effective.answer_min_score == ASK_DEFAULTS.answer_min_score
	assert effective.session_memory_max_turns == ASK_DEFAULTS.session_memory_max_turns
	assert effective.citation_adjudicate_ratio == ASK_DEFAULTS.citation_adjudicate_ratio
	# Non-ask fields still resolve from base Settings.
	assert effective.chat_model == base.chat_model
	assert set(ASK_OVERRIDE_KEYS)


def test_effective_ask_settings_always_uses_code_defaults() -> None:
	base = Settings(_env_file=None)
	assert has_ask_overrides(None) is False
	assert has_ask_overrides({}) is False
	assert has_ask_overrides({"answer_min_score": None}) is False
	effective = effective_ask_settings(base, None)
	assert effective.retrieve_top_k == ASK_DEFAULTS.retrieve_top_k
	assert effective.hybrid_enabled is ASK_DEFAULTS.hybrid_enabled
	assert effective is not base


def test_ask_knobs_ignore_environment_variables(monkeypatch) -> None:
	"""Product ask knobs must not be loaded from env into Settings or defaults."""
	monkeypatch.setenv("RETRIEVE_TOP_K", "19")
	monkeypatch.setenv("ANSWER_MIN_SCORE", "0.99")
	monkeypatch.setenv("HYBRID_ENABLED", "true")
	monkeypatch.setenv("RERANK_ENABLED", "true")
	monkeypatch.setenv("CITATION_ADJUDICATE_ENABLED", "false")
	monkeypatch.setenv("CITATION_ADJUDICATE_ABSOLUTE_FLOOR", "0.01")
	monkeypatch.setenv("CITATION_ADJUDICATE_RATIO", "0.11")
	monkeypatch.setenv("CITATION_ADJUDICATE_LEXICAL_THRESHOLD", "0.99")
	monkeypatch.setenv("SESSION_MEMORY_ENABLED", "false")
	monkeypatch.setenv("SESSION_MEMORY_MAX_TURNS", "1")

	get_settings.cache_clear()
	try:
		settings = Settings(_env_file=None)
		assert not hasattr(settings, "retrieve_top_k")
		assert not hasattr(settings, "answer_min_score")
		assert not hasattr(settings, "hybrid_enabled")
		assert not hasattr(settings, "rerank_enabled")
		assert not hasattr(settings, "citation_adjudicate_enabled")
		assert not hasattr(settings, "session_memory_enabled")

		effective = effective_ask_settings(settings)
		assert effective.retrieve_top_k == 6
		assert effective.answer_min_score == 0.4
		assert effective.hybrid_enabled is False
		assert effective.rerank_enabled is False
		assert effective.citation_adjudicate_enabled is True
		assert effective.citation_adjudicate_absolute_floor == 0.35
		assert effective.citation_adjudicate_ratio == 0.68
		assert effective.citation_adjudicate_lexical_threshold == 0.2
		assert effective.session_memory_enabled is True
		assert effective.session_memory_max_turns == 10
	finally:
		get_settings.cache_clear()
		for key in (
			"RETRIEVE_TOP_K",
			"ANSWER_MIN_SCORE",
			"HYBRID_ENABLED",
			"RERANK_ENABLED",
			"CITATION_ADJUDICATE_ENABLED",
			"CITATION_ADJUDICATE_ABSOLUTE_FLOOR",
			"CITATION_ADJUDICATE_RATIO",
			"CITATION_ADJUDICATE_LEXICAL_THRESHOLD",
			"SESSION_MEMORY_ENABLED",
			"SESSION_MEMORY_MAX_TURNS",
		):
			os.environ.pop(key, None)


def test_ask_override_raises_min_score_refuse() -> None:
	"""Override answer_min_score so a mid score that passes default still refuses."""
	settings = Settings(_env_file=None, ask_mode="stub", max_retrieve_retries=0)

	def fake_retrieve(
		_query: str,
		_library_id: str | None,
		_top_k: int,
		_filters: dict | None = None,
	):
		return [
			{
				"id": "mid",
				"index": 1,
				"title": "noise",
				"page": None,
				"snippet": "somewhat related",
				"score": 0.35,
				"text": "somewhat related",
			}
		]

	service = AskGraphService(
		settings,
		retrieve_fn=fake_retrieve,
		generate_fn=stub_generate,
	)
	# Default answer_min_score=0.4 → 0.35 is weak; lower via override to pass first.
	base_ok = service.ask(
		question="anything",
		library_id="lib-unit",
		ask_overrides={
			"answer_min_score": 0.2,
			"citation_adjudicate_enabled": False,
			"session_memory_enabled": False,
		},
	)
	assert base_ok.refused is False

	overridden = service.ask(
		question="anything",
		library_id="lib-unit",
		ask_overrides={
			"answer_min_score": 0.5,
			"citation_adjudicate_enabled": False,
			"session_memory_enabled": False,
		},
	)
	assert overridden.refused is True
	assert overridden.refuse_reason == "weak_match"


def test_ask_override_changes_top_k_in_retrieval_plan() -> None:
	settings = Settings(_env_file=None, ask_mode="stub", max_retrieve_retries=0)

	def fake_retrieve(
		_query: str,
		_library_id: str | None,
		top_k: int,
		_filters: dict | None = None,
	):
		return [
			{
				"id": f"c-{i}",
				"index": i,
				"title": "制度.pdf",
				"page": "1",
				"snippet": "病假三个工作日",
				"score": 0.9,
				"text": "病假三个工作日内补交证明",
			}
			for i in range(1, max(top_k, 1) + 1)
		]

	service = AskGraphService(
		settings,
		retrieve_fn=fake_retrieve,
		generate_fn=stub_generate,
	)
	question = "病假需要几天内补交证明？"
	base = service.ask(
		question=question,
		library_id="lib-unit",
		ask_overrides={
			"answer_min_score": 0.1,
			"citation_adjudicate_enabled": False,
			"session_memory_enabled": False,
		},
	)
	assert int((base.retrieval_debug.get("retrieval_plan") or {}).get("top_k") or 0) == 6

	overridden = service.ask(
		question=question,
		library_id="lib-unit",
		ask_overrides={
			"retrieve_top_k": 2,
			"answer_min_score": 0.1,
			"citation_adjudicate_enabled": False,
			"session_memory_enabled": False,
		},
	)
	assert int((overridden.retrieval_debug.get("retrieval_plan") or {}).get("top_k") or 0) == 2
