from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from typing import Any, Literal, TypedDict

from langgraph.graph import END, StateGraph

from app.schemas import AskResponse, Citation
from app.services.answer_copy import no_match_answer, weak_match_answer
from app.services.llm import ChatService
from app.services.retrieval import RetrievalService
from app.services.runtime import RuntimeCapability, resolve_runtime
from app.services.session_memory import SessionMemory, default_session_memory
from app.settings import Settings, get_settings

logger = logging.getLogger(__name__)

RetrieveFn = Callable[[str, str | None, int], list[dict[str, Any]]]
GenerateFn = Callable[[str, list[dict[str, Any]]], str]


class AskState(TypedDict, total=False):
	session_id: str
	question: str
	library_id: str | None
	history: list[dict[str, str]]
	rewritten_question: str
	citations: list[dict[str, Any]]
	answer: str
	refused: bool
	refuse_reason: str | None
	retrieval_attempts: int
	judgement: dict[str, Any]
	retrieval_debug: dict[str, Any]


STUB_CITATIONS: list[dict[str, Any]] = [
	{
		"id": "c1",
		"index": 1,
		"title": "员工手册-休假篇",
		"page": "p.12",
		"snippet": "病假须于返岗后三个工作日内补交证明材料，并由直属主管确认。",
		"score": 0.91,
		"text": "病假须于返岗后三个工作日内补交证明材料，并由直属主管确认。",
		"doc_id": "doc-hr-leave",
		"chunk_index": 0,
		"filename": "员工手册-休假篇.pdf",
	},
	{
		"id": "c2",
		"index": 2,
		"title": "考勤管理细则",
		"page": "§3.2",
		"snippet": "未能按期提交病假证明的，人力资源部有权按事假或旷工规则核算。",
		"score": 0.78,
		"text": "未能按期提交病假证明的，人力资源部有权按事假或旷工规则核算。",
		"doc_id": "doc-hr-attendance",
		"chunk_index": 0,
		"filename": "考勤管理细则.docx",
	},
]


def _to_citation_models(raw_citations: list[dict[str, Any]]) -> list[Citation]:
	models: list[Citation] = []
	for item in raw_citations:
		full_text = str(item.get("text") or item.get("snippet") or "")
		snippet = str(item.get("snippet") or full_text[:280])
		models.append(
			Citation.model_validate(
				{
					"id": item["id"],
					"index": item["index"],
					"title": item["title"],
					"page": item.get("page"),
					"snippet": snippet,
					"text": full_text,
					"score": item["score"],
					"doc_id": item.get("doc_id"),
					"chunk_index": item.get("chunk_index"),
					"filename": item.get("filename"),
				}
			)
		)
	return models


def _to_citation_dicts(raw_citations: list[dict[str, Any]]) -> list[dict[str, Any]]:
	return [item.model_dump() for item in _to_citation_models(raw_citations)]


def _persist_turn(
	*,
	session_id: str,
	library_id: str | None,
	question: str,
	answer: str,
	citations: list[Citation],
	mode: str,
	refused: bool,
	refuse_reason: str | None,
) -> dict[str, Any]:
	try:
		from app.services.metadata import get_metadata_store

		get_metadata_store().create_turn(
			session_id=session_id,
			library_id=library_id,
			question=question,
			answer=answer,
			citations=[item.model_dump() for item in citations],
			mode=mode,
			refused=refused,
			refuse_reason=refuse_reason,
		)
		return {"persisted": True, "persist_error": None}
	except Exception as exc:
		logger.exception("ask.persist_turn_failed session_id=%s", session_id)
		return {"persisted": False, "persist_error": str(exc)}


def _retrieval_visibility(debug: dict[str, Any]) -> dict[str, Any]:
	hybrid_failed = bool(debug.get("hybrid_failed") or debug.get("hybrid_error"))
	rerank_failed = bool(debug.get("rerank_failed"))
	retrieval_mode = str(debug.get("retrieval_mode") or ("hybrid" if debug.get("used_hybrid") else "dense"))
	return {
		"hybrid_failed": hybrid_failed,
		"rerank_failed": rerank_failed,
		"retrieval_mode": retrieval_mode,
	}


def _library_label(library_id: str | None) -> str:
	if not library_id:
		return "当前文库"
	return library_id


def rewrite_with_history(question: str, history: list[dict[str, str]] | None) -> tuple[str, str]:
	"""Return (rewritten_query, rewrite_mode). Lightweight QueryNest-style follow-up rewrite."""
	q = question.strip()
	if not history:
		return q, "passthrough"
	previous_questions = [
		item["content"]
		for item in reversed(history)
		if item.get("role") == "user" and (item.get("content") or "").strip()
	]
	if not previous_questions:
		return q, "passthrough"
	prev = previous_questions[0].strip()
	# Pronoun / short follow-ups benefit most from prior turn context.
	needs_context = len(q) <= 24 or any(
		token in q for token in ("它", "这个", "那个", "上述", "刚才", "还有", "呢", "吗")
	)
	if not needs_context:
		return q, "passthrough"
	return f"上一轮用户问题：{prev}\n当前追问：{q}", "history"


def stub_retrieve(query: str, library_id: str | None, _top_k: int) -> list[dict[str, Any]]:
	"""Deterministic stub hits; special queries exercise refuse paths in tests."""
	normalized = query.strip().lower()
	if "无命中" in query or normalized.startswith("__no_hit__"):
		return []
	if "弱相关" in query or normalized.startswith("__weak__"):
		return [
			{
				"id": "weak-1",
				"index": 1,
				"title": "无关附录.pdf",
				"page": "p.99",
				"snippet": "本附录仅作排版示例，不含人事制度条款。",
				"score": 0.11,
				"text": "本附录仅作排版示例，不含人事制度条款。",
				"used_rerank": False,
			}
		]
	_ = library_id
	hits = [dict(item) for item in STUB_CITATIONS]
	for item in hits:
		item["used_rerank"] = False
	return hits


def stub_generate(question: str, citations: list[dict[str, Any]]) -> str:
	_ = question, citations
	return (
		"根据现行人事制度，病假须于返岗后三个工作日内补交证明材料，并由直属主管确认。"
		"逾期未补交的，可按事假或旷工规则处理（以制度原文为准）。"
		"\n\n（当前为 stub 路径：未调用真实 LLM。）"
	)


def _format_context(citations: list[dict[str, Any]]) -> str:
	blocks: list[str] = []
	for item in citations:
		idx = item.get("index", len(blocks) + 1)
		title = item.get("title") or "资料"
		text = item.get("text") or item.get("snippet") or ""
		blocks.append(f"[{idx}] {title}\n{text}")
	return "\n\n".join(blocks)


def _merge_debug(state: AskState, **extra: Any) -> dict[str, Any]:
	debug = dict(state.get("retrieval_debug") or {})
	debug.update(extra)
	return debug


def build_ask_graph(
	*,
	settings: Settings,
	retrieve_fn: RetrieveFn,
	generate_fn: GenerateFn,
	mode: str,
):
	min_score = float(settings.answer_min_score)
	max_retries = max(0, int(settings.max_retrieve_retries))

	def rewrite_node(state: AskState) -> AskState:
		question = state["question"].strip()
		history = state.get("history") or []
		rewritten, rewrite_mode = rewrite_with_history(question, history)
		return {
			"rewritten_question": rewritten,
			"retrieval_attempts": 0,
			"refused": False,
			"refuse_reason": None,
			"retrieval_debug": _merge_debug(
				state,
				rewrite=rewrite_mode,
				history_turns=len(history),
				mode=mode,
				answer_min_score=min_score,
				rerank_enabled=bool(settings.rerank_enabled),
			),
		}

	def retrieve_node(state: AskState) -> AskState:
		query = state.get("rewritten_question") or state["question"]
		attempts = int(state.get("retrieval_attempts") or 0) + 1
		citations = retrieve_fn(query, state.get("library_id"), settings.retrieve_top_k)
		top_score = float(citations[0]["score"]) if citations else None
		used_rerank = bool(citations and citations[0].get("used_rerank"))
		return {
			"citations": citations,
			"retrieval_attempts": attempts,
			"retrieval_debug": _merge_debug(
				state,
				retrieve=mode,
				library_id=state.get("library_id"),
				hit_count=len(citations),
				top_score=top_score,
				used_rerank=used_rerank,
				retrieval_attempts=attempts,
				query=query,
			),
		}

	def judge_node(state: AskState) -> AskState:
		citations = state.get("citations") or []
		attempts = int(state.get("retrieval_attempts") or 0)
		library_name = _library_label(state.get("library_id"))

		if not citations:
			can_retry = attempts <= max_retries
			judgement = {
				"sufficient": False,
				"action": "retry" if can_retry else "refuse",
				"reason": "no_hit",
				"can_retry": can_retry,
			}
		else:
			top_score = float(citations[0].get("score") or 0.0)
			weak = min_score > 0 and top_score < min_score
			if weak:
				can_retry = attempts <= max_retries
				judgement = {
					"sufficient": False,
					"action": "retry" if can_retry else "refuse",
					"reason": "weak_match",
					"top_score": top_score,
					"min_score": min_score,
					"can_retry": can_retry,
				}
			else:
				judgement = {
					"sufficient": True,
					"action": "generate",
					"reason": "ok",
					"top_score": top_score,
					"min_score": min_score,
				}

		# Attach human-facing refuse reason early for refuse path.
		refuse_reason = None
		if judgement["action"] == "refuse":
			refuse_reason = judgement["reason"]

		return {
			"judgement": judgement,
			"refuse_reason": refuse_reason,
			"retrieval_debug": _merge_debug(state, judgement=judgement, library_name=library_name),
		}

	def route_after_judge(state: AskState) -> Literal["retry", "generate", "refuse"]:
		action = (state.get("judgement") or {}).get("action") or "generate"
		if action == "retry":
			return "retry"
		if action == "refuse":
			return "refuse"
		return "generate"

	def retry_node(state: AskState) -> AskState:
		"""Broaden query once, then re-enter retrieve."""
		base = state.get("rewritten_question") or state["question"]
		reason = (state.get("judgement") or {}).get("reason")
		if reason == "weak_match":
			broadened = f"{base} 相关制度 条款 规定"
		else:
			broadened = f"{base} 关键词 概要"
		return {
			"rewritten_question": broadened,
			"retrieval_debug": _merge_debug(
				state,
				retry={"from": base, "to": broadened, "reason": reason},
			),
		}

	def refuse_node(state: AskState) -> AskState:
		reason = (state.get("judgement") or {}).get("reason") or state.get("refuse_reason") or "no_hit"
		library_name = _library_label(state.get("library_id"))
		if reason == "weak_match":
			answer = weak_match_answer(library_name=library_name)
			# Keep weak citations for transparency (DustyKB behavior).
			citations = state.get("citations") or []
		else:
			answer = no_match_answer(library_name=library_name)
			citations = []
		return {
			"answer": answer,
			"citations": citations,
			"refused": True,
			"refuse_reason": reason,
			"retrieval_debug": _merge_debug(state, generate="refuse", refuse_reason=reason),
		}

	def generate_node(state: AskState) -> AskState:
		citations = state.get("citations") or []
		answer = generate_fn(state["question"], citations)
		return {
			"answer": answer,
			"refused": False,
			"refuse_reason": None,
			"retrieval_debug": _merge_debug(state, generate=mode),
		}

	graph: StateGraph[AskState] = StateGraph(AskState)
	graph.add_node("rewrite", rewrite_node)
	graph.add_node("retrieve", retrieve_node)
	graph.add_node("judge", judge_node)
	graph.add_node("retry", retry_node)
	graph.add_node("generate", generate_node)
	graph.add_node("refuse", refuse_node)
	graph.set_entry_point("rewrite")
	graph.add_edge("rewrite", "retrieve")
	graph.add_edge("retrieve", "judge")
	graph.add_conditional_edges(
		"judge",
		route_after_judge,
		{"retry": "retry", "generate": "generate", "refuse": "refuse"},
	)
	graph.add_edge("retry", "retrieve")
	graph.add_edge("generate", END)
	graph.add_edge("refuse", END)
	return graph.compile()


class AskGraphService:
	"""rewrite → retrieve → judge → (retry) → generate | refuse."""

	def __init__(
		self,
		settings: Settings | None = None,
		*,
		capability: RuntimeCapability | None = None,
		retrieve_fn: RetrieveFn | None = None,
		generate_fn: GenerateFn | None = None,
		session_memory: SessionMemory | None = None,
		retrieval_service: RetrievalService | None = None,
	) -> None:
		self.settings = settings or get_settings()
		self.capability = capability or resolve_runtime(self.settings)
		self.mode = self.capability.effective_mode
		self.session_memory = session_memory or default_session_memory
		self._retrieval_service = retrieval_service
		self._chat: ChatService | None = None

		if retrieve_fn is not None:
			self._retrieve = retrieve_fn
		elif self.mode == "live":
			retrieval = retrieval_service or RetrievalService(self.settings)
			self._retrieval_service = retrieval

			def live_retrieve(query: str, library_id: str | None, top_k: int) -> list[dict[str, Any]]:
				if not library_id or not str(library_id).strip():
					raise ValueError("library_id is required for live retrieval")
				return retrieval.search(query=query, library_id=library_id, top_k=top_k)

			self._retrieve = live_retrieve
		else:
			self._retrieve = stub_retrieve

		if generate_fn is not None:
			self._generate = generate_fn
		elif self.mode == "live":
			self._chat = ChatService(self.settings)

			def live_generate(question: str, citations: list[dict[str, Any]]) -> str:
				assert self._chat is not None
				return self._chat.answer(question=question, context=_format_context(citations))

			self._generate = live_generate
		else:
			self._generate = stub_generate

		self._graph = build_ask_graph(
			settings=self.settings,
			retrieve_fn=self._retrieve,
			generate_fn=self._generate,
			mode=self.mode,
		)

	def _merge_retrieval_debug(self, debug: dict[str, Any]) -> dict[str, Any]:
		merged = dict(debug)
		if self._retrieval_service is not None and getattr(self._retrieval_service, "last_debug", None):
			merged.update(self._retrieval_service.last_debug)
		return merged

	def ask(
		self,
		*,
		question: str,
		library_id: str | None = None,
		session_id: str | None = None,
	) -> AskResponse:
		resolved_session = session_id or str(uuid.uuid4())
		history: list[dict[str, str]] = []
		if self.settings.session_memory_enabled:
			history = self.session_memory.load(
				resolved_session,
				limit=self.settings.session_memory_max_turns * 2,
			)

		state = self._graph.invoke(
			{
				"session_id": resolved_session,
				"question": question,
				"library_id": library_id,
				"history": history,
				"retrieval_debug": {
					"requested_mode": self.capability.requested_mode,
					"effective_mode": self.capability.effective_mode,
					"degraded": self.capability.degraded,
					"reasons": list(self.capability.reasons),
					"session_memory": self.settings.session_memory_enabled,
					"hybrid_enabled": self.settings.hybrid_enabled,
				},
			}
		)

		if self.settings.session_memory_enabled:
			self.session_memory.append(resolved_session, "user", question)
			self.session_memory.append(resolved_session, "assistant", state.get("answer") or "")

		raw_citations = state.get("citations") or []
		citations = _to_citation_models(raw_citations)
		persist = _persist_turn(
			session_id=resolved_session,
			library_id=library_id,
			question=question,
			answer=state["answer"],
			citations=citations,
			mode=self.mode,
			refused=bool(state.get("refused")),
			refuse_reason=state.get("refuse_reason"),
		)
		debug = self._merge_retrieval_debug(state.get("retrieval_debug") or {})
		visibility = _retrieval_visibility(debug)
		return AskResponse(
			session_id=resolved_session,
			question=question,
			answer=state["answer"],
			citations=citations,
			mode=self.mode,
			refused=bool(state.get("refused")),
			refuse_reason=state.get("refuse_reason"),
			retrieval_debug=debug,
			persisted=bool(persist["persisted"]),
			persist_error=persist.get("persist_error"),
			hybrid_failed=bool(visibility["hybrid_failed"]),
			rerank_failed=bool(visibility["rerank_failed"]),
			retrieval_mode=str(visibility["retrieval_mode"]),
		)

	def iter_ask_events(
		self,
		*,
		question: str,
		library_id: str | None = None,
		session_id: str | None = None,
	):
		"""Yield SSE-friendly dicts: meta → citations → token* → done | error."""
		resolved_session = session_id or str(uuid.uuid4())
		history: list[dict[str, str]] = []
		if self.settings.session_memory_enabled:
			history = self.session_memory.load(
				resolved_session,
				limit=self.settings.session_memory_max_turns * 2,
			)

		held: dict[str, Any] = {"citations": [], "question": question}

		def capture_generate(q: str, citations: list[dict[str, Any]]) -> str:
			held["citations"] = citations
			held["question"] = q
			return ""

		graph = build_ask_graph(
			settings=self.settings,
			retrieve_fn=self._retrieve,
			generate_fn=capture_generate,
			mode=self.mode,
		)
		state = graph.invoke(
			{
				"session_id": resolved_session,
				"question": question,
				"library_id": library_id,
				"history": history,
				"retrieval_debug": {
					"requested_mode": self.capability.requested_mode,
					"effective_mode": self.capability.effective_mode,
					"degraded": self.capability.degraded,
					"reasons": list(self.capability.reasons),
					"session_memory": self.settings.session_memory_enabled,
					"hybrid_enabled": self.settings.hybrid_enabled,
					"stream": True,
				},
			}
		)
		debug = self._merge_retrieval_debug(state.get("retrieval_debug") or {})
		visibility = _retrieval_visibility(debug)
		refused = bool(state.get("refused"))
		raw_citations = state.get("citations") or held.get("citations") or []
		citations = _to_citation_dicts(raw_citations)
		citation_models = _to_citation_models(raw_citations)

		yield {
			"event": "meta",
			"data": {
				"session_id": resolved_session,
				"mode": self.mode,
				"refused": refused,
				"refuse_reason": state.get("refuse_reason"),
				"hybrid_failed": visibility["hybrid_failed"],
				"rerank_failed": visibility["rerank_failed"],
				"retrieval_mode": visibility["retrieval_mode"],
			},
		}
		yield {"event": "citations", "data": citations}

		if refused:
			answer = state.get("answer") or ""
			step = 12 if len(answer) > 24 else max(1, len(answer) or 1)
			for offset in range(0, len(answer), step):
				yield {"event": "token", "data": answer[offset : offset + step]}
		elif self.mode == "live" and self._chat is not None and raw_citations:
			parts: list[str] = []
			try:
				for token in self._chat.stream_answer(
					question=question,
					context=_format_context(raw_citations),
				):
					parts.append(token)
					yield {"event": "token", "data": token}
			except Exception as exc:
				logger.exception("ask.stream.llm_failed")
				yield {"event": "error", "data": {"message": f"流式生成失败：{exc}"}}
				return
			answer = "".join(parts).strip()
			state["answer"] = answer
		else:
			answer = self._generate(question, raw_citations)
			state["answer"] = answer
			step = 12 if len(answer) > 24 else max(1, len(answer) or 1)
			for offset in range(0, len(answer), step):
				yield {"event": "token", "data": answer[offset : offset + step]}

		answer = state.get("answer") or ""
		if self.settings.session_memory_enabled:
			self.session_memory.append(resolved_session, "user", question)
			self.session_memory.append(resolved_session, "assistant", answer)

		persist = _persist_turn(
			session_id=resolved_session,
			library_id=library_id,
			question=question,
			answer=answer,
			citations=citation_models,
			mode=self.mode,
			refused=refused,
			refuse_reason=state.get("refuse_reason"),
		)

		yield {
			"event": "done",
			"data": {
				"session_id": resolved_session,
				"question": question,
				"answer": answer,
				"citations": citations,
				"mode": self.mode,
				"refused": refused,
				"refuse_reason": state.get("refuse_reason"),
				"retrieval_debug": debug,
				"persisted": bool(persist["persisted"]),
				"persist_error": persist.get("persist_error"),
				"hybrid_failed": visibility["hybrid_failed"],
				"rerank_failed": visibility["rerank_failed"],
				"retrieval_mode": visibility["retrieval_mode"],
			},
		}

