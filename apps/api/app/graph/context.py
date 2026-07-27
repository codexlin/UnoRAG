"""AskGraph runtime context — explicit node dependencies (no multi-var closures).

Policy / EffectiveAskSettings are resolved once at request entry (service /
``build_ask_graph``). Nodes must only read State + Context; never re-resolve
policy, read env product knobs, or touch DB/session singletons.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.graph.state import GenerateFn, LoadTableGroupsFn, RetrieveFn
from app.security.access_scope import AccessScope, resolve_access_scope
from app.services.ask_overrides import effective_ask_settings

# Resolved ask knobs proxy from ``effective_ask_settings`` (do not re-resolve in nodes).
EffectiveAskSettings = Any


@dataclass(frozen=True)
class AskGraphContext:
	"""Runtime deps for Ask nodes. Only what nodes need to run — no session/metadata."""

	settings: EffectiveAskSettings
	scope: AccessScope
	mode: str
	retrieve: RetrieveFn
	generate: GenerateFn
	load_table_groups: LoadTableGroupsFn | None


def build_ask_graph_context(
	*,
	settings: Any,
	retrieve: RetrieveFn,
	generate: GenerateFn,
	mode: str,
	load_table_groups: LoadTableGroupsFn | None = None,
	access_scope: AccessScope | None = None,
) -> AskGraphContext:
	"""Build context once at graph construction / request entry.

	Plain ``Settings`` (e.g. tests) are wrapped via ``effective_ask_settings`` here;
	callers that already hold EffectiveAskSettings skip a second resolve.
	"""
	# Product knobs live on ASK_DEFAULTS ⊕ overrides — never plain Settings/env.
	if not hasattr(settings, "answer_min_score"):
		settings = effective_ask_settings(settings)
	scope = resolve_access_scope(settings, access_scope)
	return AskGraphContext(
		settings=settings,
		scope=scope,
		mode=mode,
		retrieve=retrieve,
		generate=generate,
		load_table_groups=load_table_groups,
	)
