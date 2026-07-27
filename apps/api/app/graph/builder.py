"""AskGraph assembly — build context + node bundles + compile topology.

Real implementation module for ``build_ask_graph`` (facade re-exports from
``ask_graph.py``). Does not import ``service`` / the ask_graph facade.
"""

from __future__ import annotations

from app.graph.context import build_ask_graph_context
from app.graph.nodes import (
	build_decision_nodes,
	build_generation_nodes,
	build_retrieval_nodes,
	build_rewrite_nodes,
	build_routing_nodes,
	build_table_nodes,
)
from app.graph.state import GenerateFn, LoadTableGroupsFn, RetrieveFn
from app.graph.topology import compile_ask_topology
from app.security.access_scope import AccessScope
from app.settings import Settings


def build_ask_graph(
	*,
	settings: Settings,
	retrieve_fn: RetrieveFn,
	generate_fn: GenerateFn,
	mode: str,
	load_table_groups_fn: LoadTableGroupsFn | None = None,
	access_scope: AccessScope | None = None,
):
	"""Compile Ask topology; nodes close over a single AskGraphContext (not loose deps)."""
	ctx = build_ask_graph_context(
		settings=settings,
		retrieve=retrieve_fn,
		generate=generate_fn,
		mode=mode,
		load_table_groups=load_table_groups_fn,
		access_scope=access_scope,
	)
	# Derived once from already-resolved ctx.settings (nodes never re-resolve policy).
	min_score = float(ctx.settings.answer_min_score)
	max_retries = max(0, int(ctx.settings.max_retrieve_retries))

	routing = build_routing_nodes(ctx, min_score=min_score)
	rewrite = build_rewrite_nodes(ctx, min_score=min_score)
	retrieval = build_retrieval_nodes(ctx)
	table = build_table_nodes(ctx)
	decision = build_decision_nodes(ctx, min_score=min_score, max_retries=max_retries)
	generation = build_generation_nodes(ctx)

	return compile_ask_topology(
		routing=routing,
		rewrite=rewrite,
		retrieval=retrieval,
		table=table,
		decision=decision,
		generation=generation,
	)
