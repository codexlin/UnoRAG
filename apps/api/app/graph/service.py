"""AskGraphService lifecycle: prepare_request → execute/stream → finalize.

Only this module (plus lifecycle/persistence) touches session, metadata, and
trace. Graph nodes continue to receive State + AskGraphContext only.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Iterator

from app.graph.builder import build_ask_graph
from app.graph.lifecycle import (
	append_temp_session_memory,
	load_request_history,
	memory_session_id,
	resolve_request_ids,
)
from app.graph.messages import build_generate_messages, history_for_generate
from app.graph.nodes.generation import (
	_finalize_generation_output,
	_format_generate_context,
)
from app.graph.persistence import persist_turn, single_document_version_id
from app.graph.state import GenerateFn, LoadTableGroupsFn, RetrieveFn
from app.graph.stubs import stub_generate, stub_load_table_groups, stub_retrieve
from app.security.access_scope import AccessScope, resolve_access_scope
from app.schemas import AskResponse, Citation
from app.services.answer_copy import answer_signals_no_coverage
from app.services.ask_trace import (
	append_stage,
	emit_ask_trace,
	finalize_ask_debug,
	initial_ask_debug,
	question_hash,
	resolve_trace_id,
)
from app.services.ask_overrides import (
	effective_ask_settings,
	extract_ask_policy_snapshot,
	has_ask_overrides,
)
from app.services.policy_profiles import resolve_ask_policy
from app.services.llm import ChatService
from app.services.retrieval import RetrievalService
from app.services.runtime import RuntimeCapability, resolve_runtime
from app.services.session_memory import (
	WORKING_MEMORY_MAX_TURNS,
	SessionMemory,
	default_session_memory,
)
from app.settings import Settings, get_settings

logger = logging.getLogger(__name__)


def _retrieval_visibility(debug: dict[str, Any]) -> dict[str, Any]:
	hybrid_failed = bool(debug.get("hybrid_failed") or debug.get("hybrid_error"))
	rerank_failed = bool(debug.get("rerank_failed"))
	retrieval_mode = str(debug.get("retrieval_mode") or ("hybrid" if debug.get("used_hybrid") else "dense"))
	return {
		"hybrid_failed": hybrid_failed,
		"rerank_failed": rerank_failed,
		"retrieval_mode": retrieval_mode,
	}


@dataclass
class PreparedAskRequest:
	"""Resolved ids / policy / history / graph input for one Ask call."""

	started_at: float
	question: str
	library_id: str | None
	resolved_trace: str
	resolved_session: str
	resolved_thread: str | None
	memory_session: str
	ask_settings: Any
	policy_snapshot: dict[str, Any]
	history: list[dict[str, str]]
	stream: bool
	graph_input: dict[str, Any] = field(default_factory=dict)


@dataclass
class FinalizedAskResult:
	"""Shared finalize contract for sync AskResponse and stream done event."""

	answer: str
	citations: list[Citation]
	debug: dict[str, Any]
	persist: dict[str, Any]
	visibility: dict[str, Any]
	refused: bool
	refuse_reason: Any


class AskGraphService:
	"""query_router → plan → rewrite → retrieve → judge → (retry) → generate | refuse | clarify.

	Public entrypoints orchestrate prepare → execute/stream → finalize.
	"""

	def __init__(
		self,
		settings: Settings | None = None,
		*,
		capability: RuntimeCapability | None = None,
		retrieve_fn: RetrieveFn | None = None,
		generate_fn: GenerateFn | None = None,
		session_memory: SessionMemory | None = None,
		retrieval_service: RetrievalService | None = None,
		access_scope: AccessScope | None = None,
		load_table_groups_fn: LoadTableGroupsFn | None = None,
	) -> None:
		self.settings = settings or get_settings()
		self.capability = capability or resolve_runtime(self.settings)
		self.mode = self.capability.effective_mode
		self.session_memory = session_memory or default_session_memory
		self.access_scope = resolve_access_scope(self.settings, access_scope)
		self._retrieval_service = retrieval_service
		self._chat: ChatService | None = None

		if retrieve_fn is not None:
			self._retrieve = retrieve_fn
		elif self.mode == "live":
			retrieval = retrieval_service or RetrievalService(
				self.settings,
				access_scope=self.access_scope,
			)
			self._retrieval_service = retrieval

			def live_retrieve(
				query: str,
				library_id: str | None,
				top_k: int,
				filters: dict[str, Any] | None = None,
			) -> list[dict[str, Any]]:
				if not library_id or not str(library_id).strip():
					raise ValueError("library_id is required for live retrieval")
				return retrieval.search(
					query=query,
					library_id=library_id,
					top_k=top_k,
					filters=filters,
					record_type=str((filters or {}).get("record_type") or "chunk"),
				)

			self._retrieve = live_retrieve
		else:
			self._retrieve = stub_retrieve

		if generate_fn is not None:
			self._generate = generate_fn
		elif self.mode == "live":
			self._chat = ChatService(self.settings)

			def live_generate(
				messages: list[dict[str, str]],
				citations: list[dict[str, Any]],
			) -> str:
				_ = citations
				assert self._chat is not None
				return self._chat.answer_messages(messages)

			self._generate = live_generate
		else:
			self._generate = stub_generate

		resolved_load_table_groups = load_table_groups_fn
		if resolved_load_table_groups is None and self._retrieval_service is not None:
			retrieval_for_table = self._retrieval_service

			def _load_table_groups(
				*,
				doc_id: str,
				table_id: str,
				document_version_id: str | None = None,
				library_id: str | None = None,
			) -> list[dict[str, Any]]:
				return retrieval_for_table.load_table_groups(
					doc_id=doc_id,
					table_id=table_id,
					document_version_id=document_version_id,
					library_id=library_id,
				)

			resolved_load_table_groups = _load_table_groups
		elif resolved_load_table_groups is None and self.mode != "live":
			# Stub retrieve returns table hits but has no Qdrant store; inject
			# in-memory groups so prepare_table_for_execute is not no_store_loader.
			resolved_load_table_groups = stub_load_table_groups

		# Keep for iter_ask_events — it rebuilds the graph with a capture generate_fn.
		self._load_table_groups_fn = resolved_load_table_groups

		self._default_ask_settings = effective_ask_settings(self.settings)
		self._graph = build_ask_graph(
			settings=self._default_ask_settings,
			retrieve_fn=self._retrieve,
			generate_fn=self._generate,
			mode=self.mode,
			load_table_groups_fn=resolved_load_table_groups,
			access_scope=self.access_scope,
		)

	def _merge_retrieval_debug(self, debug: dict[str, Any]) -> dict[str, Any]:
		merged = dict(debug)
		if self._retrieval_service is not None and getattr(self._retrieval_service, "last_debug", None):
			merged.update(self._retrieval_service.last_debug)
		return merged

	def _memory_session_id(self, session_id: str) -> str:
		return memory_session_id(self.access_scope.cache_key(), session_id)

	def _ask_settings_for_request(
		self,
		ask_overrides: dict[str, Any] | None,
		*,
		question: str | None = None,
	):
		if not has_ask_overrides(ask_overrides):
			return self._default_ask_settings
		return effective_ask_settings(
			self.settings,
			ask_overrides,
			question=question,
		)

	def _ask_policy_snapshot_for_request(
		self,
		ask_overrides: dict[str, Any] | None,
		*,
		question: str | None = None,
		ask_settings: Any,
	) -> dict[str, Any]:
		"""Public + resolved knobs for retrieval_debug / ask.trace."""
		injected = extract_ask_policy_snapshot(ask_overrides)
		if injected:
			# Refresh resolved hybrid/rerank from effective settings (auto heuristic).
			resolved = dict(injected.get("resolved") or {})
			resolved["hybrid_enabled"] = bool(ask_settings.hybrid_enabled)
			resolved["rerank_enabled"] = bool(ask_settings.rerank_enabled)
			return {
				**injected,
				"resolved": resolved,
				"retrieval_enhancement": (
					injected.get("retrieval_enhancement")
					or (injected.get("public") or {}).get("retrieval_enhancement")
				),
			}
		policy = resolve_ask_policy(
			ask_overrides if isinstance(ask_overrides, dict) else None,
			question=question,
		)
		return policy.snapshot()

	def _graph_for_settings(self, settings: Any, *, generate_fn: GenerateFn | None = None):
		return build_ask_graph(
			settings=settings,
			retrieve_fn=self._retrieve,
			generate_fn=generate_fn or self._generate,
			mode=self.mode,
			load_table_groups_fn=self._load_table_groups_fn,
			access_scope=self.access_scope,
		)

	def _apply_retrieval_settings(self, settings: Any):
		"""Temporarily point RetrievalService at effective ask settings for this request."""
		retrieval = self._retrieval_service
		if retrieval is None or not hasattr(retrieval, "settings"):
			return None
		previous = retrieval.settings
		retrieval.settings = settings
		# Lazily enable rerank client when override turns rerank on.
		if (
			bool(getattr(settings, "rerank_enabled", False))
			and retrieval.reranker is None
			and bool(getattr(settings, "has_llm_key", False))
		):
			from app.services.rerank import RerankClient

			retrieval.reranker = RerankClient(settings)
		return previous

	def _restore_retrieval_settings(self, previous: Any) -> None:
		if previous is not None and self._retrieval_service is not None:
			self._retrieval_service.settings = previous

	def prepare_request(
		self,
		*,
		question: str,
		library_id: str | None = None,
		session_id: str | None = None,
		thread_id: str | None = None,
		trace_id: str | None = None,
		ask_overrides: dict[str, Any] | None = None,
		stream: bool = False,
	) -> PreparedAskRequest:
		"""Resolve ids, history, and policy/settings once; build graph input."""
		started_at = time.perf_counter()
		resolved_trace = resolve_trace_id(request_id=trace_id)
		resolved_session, resolved_thread = resolve_request_ids(session_id, thread_id)
		memory_session = self._memory_session_id(resolved_session)
		ask_settings = self._ask_settings_for_request(
			ask_overrides,
			question=question,
		)
		policy_snapshot = self._ask_policy_snapshot_for_request(
			ask_overrides,
			question=question,
			ask_settings=ask_settings,
		)
		history = load_request_history(
			thread_id=resolved_thread,
			tenant_id=self.access_scope.tenant_id,
			workspace_id=self.access_scope.workspace_id,
			principal_id=self.access_scope.principal_id,
			session_memory=self.session_memory,
			memory_session=memory_session,
			session_memory_enabled=ask_settings.session_memory_enabled,
			max_turns=WORKING_MEMORY_MAX_TURNS,
		)
		debug_seed = initial_ask_debug(
			trace_id=resolved_trace,
			question=question,
			library_id=library_id,
			requested_mode=self.capability.requested_mode,
			effective_mode=self.capability.effective_mode,
			degraded=self.capability.degraded,
			reasons=list(self.capability.reasons),
			session_memory=bool(resolved_thread) or ask_settings.session_memory_enabled,
			hybrid_enabled=ask_settings.hybrid_enabled,
			stream=stream,
		)
		debug_seed["rerank_enabled"] = bool(ask_settings.rerank_enabled)
		debug_seed["ask_policy"] = policy_snapshot
		graph_input = {
			"session_id": resolved_session,
			"question": question,
			"library_id": library_id,
			"history": history,
			"trace_id": resolved_trace,
			"retrieval_debug": debug_seed,
		}
		return PreparedAskRequest(
			started_at=started_at,
			question=question,
			library_id=library_id,
			resolved_trace=resolved_trace,
			resolved_session=resolved_session,
			resolved_thread=resolved_thread,
			memory_session=memory_session,
			ask_settings=ask_settings,
			policy_snapshot=policy_snapshot,
			history=history,
			stream=stream,
			graph_input=graph_input,
		)

	def execute_graph(
		self,
		prepared: PreparedAskRequest,
		*,
		generate_fn: GenerateFn | None = None,
	) -> dict[str, Any]:
		"""Run the compiled Ask graph once; restore retrieval settings afterward."""
		previous_retrieval_settings = self._apply_retrieval_settings(prepared.ask_settings)
		try:
			if generate_fn is not None:
				graph = self._graph_for_settings(
					prepared.ask_settings,
					generate_fn=generate_fn,
				)
			elif prepared.ask_settings is self._default_ask_settings:
				graph = self._graph
			else:
				graph = self._graph_for_settings(prepared.ask_settings)
			return graph.invoke(prepared.graph_input)
		finally:
			self._restore_retrieval_settings(previous_retrieval_settings)

	def stream_graph(
		self,
		prepared: PreparedAskRequest,
		*,
		generate_fn: GenerateFn,
	) -> dict[str, Any]:
		"""Stream path graph run (capture generate_fn); same invoke contract as execute."""
		return self.execute_graph(prepared, generate_fn=generate_fn)

	def _enrich_debug(
		self,
		prepared: PreparedAskRequest,
		state: dict[str, Any],
	) -> dict[str, Any]:
		debug = self._merge_retrieval_debug(state.get("retrieval_debug") or {})
		debug.setdefault("trace_id", prepared.resolved_trace)
		debug.setdefault("question_hash", question_hash(prepared.question))
		debug.setdefault("library_id", prepared.library_id)
		debug.setdefault("ask_policy", prepared.policy_snapshot)
		debug["hybrid_enabled"] = bool(prepared.ask_settings.hybrid_enabled)
		debug["rerank_enabled"] = bool(prepared.ask_settings.rerank_enabled)
		return debug

	def _plan_for_persist(
		self,
		state: dict[str, Any],
		debug: dict[str, Any],
	) -> Any:
		plan = state.get("retrieval_plan") or debug.get("retrieval_plan")
		if isinstance(plan, dict):
			plan = dict(plan)
			if state.get("table_query_plan"):
				plan["table_query_plan"] = state["table_query_plan"]
			elif debug.get("table_query_plan"):
				plan["table_query_plan"] = debug["table_query_plan"]
			if state.get("table_execution"):
				plan["table_execution"] = state["table_execution"]
			elif debug.get("table_execution"):
				plan["table_execution"] = debug["table_execution"]
		return plan

	def _persist_and_trace(
		self,
		prepared: PreparedAskRequest,
		state: dict[str, Any],
		*,
		answer: str,
		citations: list[Citation],
		debug: dict[str, Any],
		refused: bool,
	) -> dict[str, Any]:
		judge = state.get("judgement") or debug.get("judgement")
		plan = self._plan_for_persist(state, debug)
		query_type = state.get("query_type") or debug.get("query_type")
		rewrite_mode = debug.get("rewrite")
		persist = persist_turn(
			session_id=prepared.resolved_session,
			thread_id=prepared.resolved_thread,
			library_id=prepared.library_id,
			question=prepared.question,
			answer=answer,
			citations=citations,
			mode=self.mode,
			refused=refused,
			refuse_reason=state.get("refuse_reason"),
			query_type=str(query_type) if query_type else None,
			retrieval_plan=plan if isinstance(plan, dict) else None,
			retrieval_debug=debug,
			rewrite=str(rewrite_mode) if rewrite_mode else None,
			rewritten_query=state.get("rewritten_question"),
			judge=judge if isinstance(judge, dict) else None,
			document_version_id=single_document_version_id(citations),
			tenant_id=self.access_scope.tenant_id,
			workspace_id=self.access_scope.workspace_id,
			principal_id=self.access_scope.principal_id,
		)
		emit_ask_trace(debug)
		return persist

	def finalize_result(
		self,
		prepared: PreparedAskRequest,
		state: dict[str, Any],
		*,
		answer: str | None = None,
		raw_citations: list[dict[str, Any]] | None = None,
		truncated: bool = False,
		append_memory: bool = True,
		debug: dict[str, Any] | None = None,
	) -> FinalizedAskResult:
		"""Persist turn, emit trace, optionally append temp session memory.

		Sync and stream share this contract; stream may call it from a finish
		hook after tokens (and may pass a pre-enriched debug / final answer).
		"""
		if debug is None:
			debug = self._enrich_debug(prepared, state)
		raw = raw_citations if raw_citations is not None else (state.get("citations") or [])
		final_answer = answer if answer is not None else (state.get("answer") or "")
		final_answer, citations = _finalize_generation_output(
			answer=final_answer,
			raw_citations=raw,
			allowed_hits=raw,
			debug=debug,
		)
		model_refused = answer_signals_no_coverage(final_answer)
		if model_refused and not state.get("refused"):
			state["refused"] = True
			state["refuse_reason"] = "model_no_coverage"
			debug["refuse_reason"] = "model_no_coverage"
			debug["retrieved_candidate_count"] = len(citations)
		if state.get("refused"):
			# Retrieved candidates are diagnostic data, not supporting citations.
			citations = []
		# Sync historical order: temp memory before debug finalize / persist.
		# Stream finish sets append_memory=False and appends after tokens.
		if append_memory:
			append_temp_session_memory(
				thread_id=prepared.resolved_thread,
				session_memory_enabled=prepared.ask_settings.session_memory_enabled,
				session_memory=self.session_memory,
				memory_session=prepared.memory_session,
				question=prepared.question,
				answer=final_answer,
			)
		finalize_ask_debug(debug, started_at=prepared.started_at, truncated=truncated)
		refused = bool(state.get("refused"))
		persist = self._persist_and_trace(
			prepared,
			state,
			answer=final_answer,
			citations=citations,
			debug=debug,
			refused=refused,
		)
		return FinalizedAskResult(
			answer=final_answer,
			citations=citations,
			debug=debug,
			persist=persist,
			visibility=_retrieval_visibility(debug),
			refused=refused,
			refuse_reason=state.get("refuse_reason"),
		)

	def ask(
		self,
		*,
		question: str,
		library_id: str | None = None,
		session_id: str | None = None,
		thread_id: str | None = None,
		trace_id: str | None = None,
		ask_overrides: dict[str, Any] | None = None,
	) -> AskResponse:
		prepared = self.prepare_request(
			question=question,
			library_id=library_id,
			session_id=session_id,
			thread_id=thread_id,
			trace_id=trace_id,
			ask_overrides=ask_overrides,
			stream=False,
		)
		state = self.execute_graph(prepared)
		finalized = self.finalize_result(prepared, state)
		return AskResponse(
			session_id=prepared.resolved_session,
			thread_id=prepared.resolved_thread,
			question=question,
			answer=finalized.answer,
			citations=finalized.citations,
			mode=self.mode,
			refused=finalized.refused,
			refuse_reason=finalized.refuse_reason,
			retrieval_debug=finalized.debug,
			persisted=bool(finalized.persist["persisted"]),
			persist_error=finalized.persist.get("persist_error"),
			hybrid_failed=bool(finalized.visibility["hybrid_failed"]),
			rerank_failed=bool(finalized.visibility["rerank_failed"]),
			retrieval_mode=str(finalized.visibility["retrieval_mode"]),
		)

	def iter_ask_events(
		self,
		*,
		question: str,
		library_id: str | None = None,
		session_id: str | None = None,
		thread_id: str | None = None,
		trace_id: str | None = None,
		ask_overrides: dict[str, Any] | None = None,
	) -> Iterator[dict[str, Any]]:
		"""Yield SSE-friendly dicts: meta → citations → token* → done | error."""
		prepared = self.prepare_request(
			question=question,
			library_id=library_id,
			session_id=session_id,
			thread_id=thread_id,
			trace_id=trace_id,
			ask_overrides=ask_overrides,
			stream=True,
		)

		held: dict[str, Any] = {"citations": [], "messages": [], "question": question}

		def capture_generate(
			messages: list[dict[str, str]],
			citations: list[dict[str, Any]],
		) -> str:
			held["citations"] = citations
			held["messages"] = messages
			# Last user content for table/stream alignment fallbacks.
			for item in reversed(messages):
				if item.get("role") == "user":
					held["question"] = item.get("content") or question
					break
			return ""

		state = self.stream_graph(prepared, generate_fn=capture_generate)
		debug = self._enrich_debug(prepared, state)
		visibility = _retrieval_visibility(debug)
		refused = bool(state.get("refused"))
		raw_citations = state.get("citations") or held.get("citations") or []
		# 流式路径 citations 先于 token 发出；对账在出口做一次，供 SSE + persist 同源
		answer, citation_models = _finalize_generation_output(
			answer=state.get("answer") or "",
			raw_citations=raw_citations,
			allowed_hits=raw_citations,
			debug=debug,
		)
		citations = [item.model_dump() for item in citation_models]
		truncated = False
		finished = False
		persist: dict[str, Any] = {"persisted": False, "persist_error": None}

		def _finish(*, mark_truncated: bool) -> None:
			nonlocal finished, debug, persist, answer, citation_models, citations
			if finished:
				return
			finished = True
			# Stream finish reuses finalize_result but keeps historical order:
			# generation reconcile → debug finalize → persist/trace; memory is
			# appended by the happy path after tokens (not inside finish).
			finalized = self.finalize_result(
				prepared,
				state,
				answer=answer,
				raw_citations=raw_citations,
				truncated=mark_truncated,
				append_memory=False,
				debug=debug,
			)
			answer = finalized.answer
			citation_models = finalized.citations
			citations = [item.model_dump() for item in citation_models]
			debug = finalized.debug
			persist = finalized.persist

		try:
			yield {
				"event": "meta",
				"data": {
					"session_id": prepared.resolved_session,
					"thread_id": prepared.resolved_thread,
					"mode": self.mode,
					"refused": refused,
					"refuse_reason": state.get("refuse_reason"),
					"trace_id": prepared.resolved_trace,
					"hybrid_failed": visibility["hybrid_failed"],
					"rerank_failed": visibility["rerank_failed"],
					"retrieval_mode": visibility["retrieval_mode"],
				},
			}
			yield {"event": "citations", "data": citations}

			execution = state.get("table_execution") or debug.get("table_execution") or {}
			tq = state.get("table_query_plan") or debug.get("table_query_plan") or {}
			query_type = str(state.get("query_type") or debug.get("query_type") or "")
			gen_history = history_for_generate(prepared.history)
			# 与 generate_node 对齐：多轮 history messages + 结构化 table 结果注入资料
			use_table_ctx = (
				query_type == "table"
				and isinstance(execution, dict)
				and execution.get("ok")
				and isinstance(tq, dict)
				and tq.get("confident")
				and execution.get("answer_text")
			)
			stream_messages = held.get("messages") or build_generate_messages(
				question=question,
				context=_format_generate_context(
					raw_citations,
					execution if use_table_ctx else None,
				),
				history=gen_history,
			)
			debug["generate_history_turns"] = len(gen_history)

			t_gen = time.perf_counter()
			if refused:
				answer = state.get("answer") or ""
				step = 12 if len(answer) > 24 else max(1, len(answer) or 1)
				for offset in range(0, len(answer), step):
					yield {"event": "token", "data": answer[offset : offset + step]}
			elif use_table_ctx and self.mode == "stub" and state.get("answer"):
				# Program answer already set in generate_node; don't re-run stub generate.
				answer = state.get("answer") or ""
				step = 12 if len(answer) > 24 else max(1, len(answer) or 1)
				for offset in range(0, len(answer), step):
					yield {"event": "token", "data": answer[offset : offset + step]}
			elif self.mode == "live" and self._chat is not None and raw_citations:
				parts: list[str] = []
				try:
					for token in self._chat.stream_messages(stream_messages):
						parts.append(token)
						yield {"event": "token", "data": token}
				except Exception as exc:
					logger.exception("ask.stream.llm_failed")
					append_stage(
						debug,
						name="generate",
						duration_ms=(time.perf_counter() - t_gen) * 1000,
						ok=False,
						detail={
							"mode": self.mode,
							"model": self.settings.chat_model,
							"input_tokens": None,
							"output_tokens": None,
						},
					)
					truncated = True
					_finish(mark_truncated=True)
					yield {"event": "error", "data": {"message": f"流式生成失败：{exc}"}}
					return
				answer = "".join(parts).strip()
				state["answer"] = answer
			else:
				answer = self._generate(stream_messages, raw_citations)
				state["answer"] = answer
				step = 12 if len(answer) > 24 else max(1, len(answer) or 1)
				for offset in range(0, len(answer), step):
					yield {"event": "token", "data": answer[offset : offset + step]}

			append_stage(
				debug,
				name="generate",
				duration_ms=(time.perf_counter() - t_gen) * 1000,
				detail={
					"mode": self.mode,
					"model": self.settings.chat_model if self.mode == "live" else None,
					"input_tokens": None,
					"output_tokens": None,
					"generate_history_turns": len(gen_history),
				},
			)

			answer = state.get("answer") or ""
			_finish(mark_truncated=False)
			append_temp_session_memory(
				thread_id=prepared.resolved_thread,
				session_memory_enabled=prepared.ask_settings.session_memory_enabled,
				session_memory=self.session_memory,
				memory_session=prepared.memory_session,
				question=question,
				answer=answer,
			)

			yield {
				"event": "done",
				"data": {
					"session_id": prepared.resolved_session,
					"thread_id": prepared.resolved_thread,
					"question": question,
					"answer": answer,
					"citations": citations,
					"mode": self.mode,
					"refused": refused,
					"refuse_reason": state.get("refuse_reason"),
					"trace_id": prepared.resolved_trace,
					"retrieval_debug": debug,
					"persisted": bool(persist["persisted"]),
					"persist_error": persist.get("persist_error"),
					"hybrid_failed": visibility["hybrid_failed"],
					"rerank_failed": visibility["rerank_failed"],
					"retrieval_mode": visibility["retrieval_mode"],
				},
			}
		except GeneratorExit:
			truncated = True
			_finish(mark_truncated=True)
			raise
		except Exception:
			truncated = True
			_finish(mark_truncated=True)
			raise
		finally:
			if not finished:
				_finish(mark_truncated=truncated)
