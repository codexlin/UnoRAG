"""Code defaults for ask / retrieval product knobs.

Resolution order (no env):
  workspace ask_overrides  >  ASK_DEFAULTS
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class AskDefaults:
	retrieve_top_k: int = 6
	answer_min_score: float = 0.4
	hybrid_enabled: bool = False
	rerank_enabled: bool = False
	citation_adjudicate_enabled: bool = True
	citation_adjudicate_absolute_floor: float = 0.35
	# Code-only (not exposed in workspace UI / ask_overrides).
	citation_adjudicate_ratio: float = 0.68
	citation_adjudicate_lexical_threshold: float = 0.2
	session_memory_enabled: bool = True
	# Kept for workspace UI compat; effective history window is WORKING_MEMORY_MAX_TURNS.
	session_memory_max_turns: int = 10


ASK_DEFAULTS = AskDefaults()

# Keys that workspace settings / AskRequest.ask_overrides may set.
ASK_OVERRIDE_KEYS = (
	"retrieve_top_k",
	"answer_min_score",
	"hybrid_enabled",
	"rerank_enabled",
	"citation_adjudicate_enabled",
	"citation_adjudicate_absolute_floor",
	"session_memory_enabled",
	"session_memory_max_turns",
)


def ask_defaults_dict() -> dict[str, Any]:
	return asdict(ASK_DEFAULTS)


def ui_ask_defaults_dict() -> dict[str, Any]:
	"""Defaults for the 8 UI-overridable knobs (keep in sync with web PUBLIC_ASK_DEFAULTS knobs)."""
	full = ask_defaults_dict()
	return {key: full[key] for key in ASK_OVERRIDE_KEYS}
