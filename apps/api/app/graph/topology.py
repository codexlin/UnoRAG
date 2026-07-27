"""AskGraph topology — LangGraph wiring only (no business algorithms).

Owns ``add_node`` / ``add_edge`` / ``add_conditional_edges`` / entry·exit.
Node callables and route predicates are injected; this module does not
implement retrieval, judge, rewrite, or generation logic.
"""

from __future__ import annotations

from typing import Any

from langgraph.graph import END, StateGraph

from app.graph.state import AskState


def compile_ask_topology(
	*,
	routing: Any,
	rewrite: Any,
	retrieval: Any,
	table: Any,
	decision: Any,
	generation: Any,
):
	"""Wire injected node bundles into a compiled Ask StateGraph."""
	graph: StateGraph[AskState] = StateGraph(AskState)
	graph.add_node("query_router", routing.query_router)
	graph.add_node("build_retrieval_plan", routing.build_plan)
	graph.add_node("clarify", routing.clarify)
	graph.add_node("build_table_plan", table.build_table_plan)
	graph.add_node("table_retrieve", table.table_retrieve)
	graph.add_node("table_execute", table.table_execute)
	graph.add_node("rewrite", rewrite.rewrite)
	graph.add_node("retrieve", retrieval.retrieve)
	graph.add_node("judge", decision.judge)
	graph.add_node("retry", decision.retry)
	graph.add_node("generate", generation.generate)
	graph.add_node("refuse", decision.refuse)
	graph.set_entry_point("query_router")
	graph.add_edge("query_router", "build_retrieval_plan")
	graph.add_conditional_edges(
		"build_retrieval_plan",
		routing.route_after_plan,
		{"clarify": "clarify", "rewrite": "rewrite"},
	)
	graph.add_edge("clarify", END)
	graph.add_edge("build_table_plan", "table_retrieve")
	graph.add_edge("table_retrieve", "table_execute")
	graph.add_conditional_edges(
		"table_execute",
		table.route_after_table_execute,
		{"judge": "judge", "end": END},
	)
	graph.add_conditional_edges(
		"rewrite",
		routing.route_after_rewrite,
		{"retrieve": "retrieve", "table": "build_table_plan"},
	)
	graph.add_conditional_edges(
		"retrieve",
		retrieval.route_after_retrieve,
		{"upgrade_precise": "build_table_plan", "judge": "judge"},
	)
	graph.add_conditional_edges(
		"judge",
		decision.route_after_judge,
		{"retry": "retry", "generate": "generate", "refuse": "refuse"},
	)
	graph.add_conditional_edges(
		"retry",
		decision.route_after_retry,
		{"retrieve": "retrieve", "table_retrieve": "table_retrieve"},
	)
	graph.add_edge("generate", END)
	graph.add_edge("refuse", END)
	return graph.compile()
