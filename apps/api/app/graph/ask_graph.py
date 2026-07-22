from __future__ import annotations

import uuid
from typing import Any, TypedDict

from langgraph.graph import END, StateGraph

from app.schemas import AskResponse, Citation


class AskState(TypedDict, total=False):
	session_id: str
	question: str
	library_id: str | None
	rewritten_question: str
	citations: list[dict[str, Any]]
	answer: str
	retrieval_debug: dict[str, Any]


def _rewrite_node(state: AskState) -> AskState:
	question = state["question"].strip()
	return {
		"rewritten_question": question,
		"retrieval_debug": {
			**state.get("retrieval_debug", {}),
			"rewrite": "passthrough",
		},
	}


def _retrieve_node(state: AskState) -> AskState:
	# Stub retrieval — replace with hybrid search + rerank later.
	citations = [
		{
			"id": "c1",
			"index": 1,
			"title": "员工手册-休假篇.pdf",
			"page": "p.12",
			"snippet": "病假须于返岗后三个工作日内补交证明材料，并由直属主管确认……",
			"score": 0.91,
		},
		{
			"id": "c2",
			"index": 2,
			"title": "考勤管理细则.docx",
			"page": "§3.2",
			"snippet": "未能按期提交病假证明的，人力资源部有权按事假或旷工规则核算……",
			"score": 0.78,
		},
	]
	return {
		"citations": citations,
		"retrieval_debug": {
			**state.get("retrieval_debug", {}),
			"retrieve": "stub",
			"library_id": state.get("library_id"),
			"hit_count": len(citations),
		},
	}


def _generate_node(state: AskState) -> AskState:
	answer = (
		"根据现行人事制度，病假须于返岗后三个工作日内补交证明材料，并由直属主管确认。"
		"逾期未补交的，可按事假或旷工规则处理（以制度原文为准）。"
		"\n\n（当前为 LangGraph stub 路径，尚未接入真实检索与模型。）"
	)
	return {
		"answer": answer,
		"retrieval_debug": {
			**state.get("retrieval_debug", {}),
			"generate": "stub_template",
		},
	}


def build_stub_graph():
	graph: StateGraph[AskState] = StateGraph(AskState)
	graph.add_node("rewrite", _rewrite_node)
	graph.add_node("retrieve", _retrieve_node)
	graph.add_node("generate", _generate_node)
	graph.set_entry_point("rewrite")
	graph.add_edge("rewrite", "retrieve")
	graph.add_edge("retrieve", "generate")
	graph.add_edge("generate", END)
	return graph.compile()


class AskGraphService:
	"""Thin wrapper; later swap stub graph for full agentic path."""

	def __init__(self) -> None:
		self._graph = build_stub_graph()

	def ask(
		self,
		*,
		question: str,
		library_id: str | None = None,
		session_id: str | None = None,
		mode: str = "stub",
	) -> AskResponse:
		resolved_session = session_id or str(uuid.uuid4())
		state = self._graph.invoke(
			{
				"session_id": resolved_session,
				"question": question,
				"library_id": library_id,
				"retrieval_debug": {},
			}
		)
		citations = [Citation.model_validate(item) for item in state.get("citations", [])]
		return AskResponse(
			session_id=resolved_session,
			question=question,
			answer=state["answer"],
			citations=citations,
			mode=mode,
			retrieval_debug=state.get("retrieval_debug", {}),
		)
