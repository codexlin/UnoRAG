"""Ask 编排图（Data Plane）。

输入：有效 Ask 请求 + effective settings（含 ask_overrides / policy snapshot）
输出：AskResponse（答案、引用、trace/debug）
不变量：产品 knobs 不读 HYBRID_ENABLED 等 env；门禁与检索计划走既有合同
所有者：Data Plane / Ask
"""

from __future__ import annotations

import logging
import time
from typing import Any

from app.graph.lifecycle import (
	append_temp_session_memory,
	history_from_thread,
	load_request_history,
	memory_session_id,
	resolve_request_ids,
)
from app.graph.messages import (
	build_generate_messages,
	history_for_generate,
	question_with_working_memory,
	rewrite_with_history,
)
from app.graph.persistence import persist_turn, single_document_version_id
from app.graph.context import AskGraphContext, build_ask_graph_context
from app.graph.nodes import (
	build_decision_nodes,
	build_generation_nodes,
	build_retrieval_nodes,
	build_rewrite_nodes,
	build_routing_nodes,
	build_table_nodes,
)
from app.graph.nodes.common import (  # noqa: F401 — re-export for tests / monkeypatch
	_library_label,
	_merge_debug,
	_renumber_citation_indexes,
)
from app.graph.nodes.generation import (  # noqa: F401 — re-export helpers used by tests/service
	_finalize_generation_output,
	_format_context,
	_format_generate_context,
	_format_table_generate_context,
	_table_execution_context_block,
	_to_citation_models,
)
from app.graph.nodes.rewrite import (  # noqa: F401 — monkeypatch target for live plan tests
	_request_structured_retrieval_plan_json,
)
from app.graph.state import AskState, GenerateFn, LoadTableGroupsFn, RetrieveFn
from app.graph.stubs import (
	STUB_CITATIONS,
	stub_generate,
	stub_load_table_groups,
	stub_retrieve,
)
from app.graph.topology import compile_ask_topology
from app.security.access_scope import AccessScope, resolve_access_scope
from app.schemas import AskResponse, Citation
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

# Re-export extracted symbols so existing `from app.graph.ask_graph import …` keeps working.
# Underscore aliases keep monkeypatches on ask_graph._persist_turn / _history_from_thread working.
_persist_turn = persist_turn
_history_from_thread = history_from_thread
_single_document_version_id = single_document_version_id

__all__ = [
	"AskGraphContext",
	"AskGraphService",
	"AskState",
	"GenerateFn",
	"LoadTableGroupsFn",
	"RetrieveFn",
	"STUB_CITATIONS",
	"build_ask_graph_context",
	"append_temp_session_memory",
	"build_ask_graph",
	"build_generate_messages",
	"history_for_generate",
	"history_from_thread",
	"load_request_history",
	"memory_session_id",
	"persist_turn",
	"question_with_working_memory",
	"resolve_request_ids",
	"rewrite_with_history",
	"single_document_version_id",
	"stub_generate",
	"stub_load_table_groups",
	"stub_retrieve",
]


def _retrieval_visibility(debug: dict[str, Any]) -> dict[str, Any]:
	hybrid_failed = bool(debug.get("hybrid_failed") or debug.get("hybrid_error"))
	rerank_failed = bool(debug.get("rerank_failed"))
	retrieval_mode = str(debug.get("retrieval_mode") or ("hybrid" if debug.get("used_hybrid") else "dense"))
	return {
		"hybrid_failed": hybrid_failed,
		"rerank_failed": rerank_failed,
		"retrieval_mode": retrieval_mode,
	}


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


class AskGraphService:
	"""query_router → plan → rewrite → retrieve → judge → (retry) → generate | refuse | clarify."""

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
		previous_retrieval_settings = self._apply_retrieval_settings(ask_settings)
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

		try:
			graph = (
				self._graph
				if ask_settings is self._default_ask_settings
				else self._graph_for_settings(ask_settings)
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
				stream=False,
			)
			debug_seed["rerank_enabled"] = bool(ask_settings.rerank_enabled)
			debug_seed["ask_policy"] = policy_snapshot
			state = graph.invoke(
				{
					"session_id": resolved_session,
					"question": question,
					"library_id": library_id,
					"history": history,
					"trace_id": resolved_trace,
					"retrieval_debug": debug_seed,
				}
			)
		finally:
			if previous_retrieval_settings is not None and self._retrieval_service is not None:
				self._retrieval_service.settings = previous_retrieval_settings

		raw_citations = state.get("citations") or []
		debug = self._merge_retrieval_debug(state.get("retrieval_debug") or {})
		debug.setdefault("trace_id", resolved_trace)
		debug.setdefault("question_hash", question_hash(question))
		debug.setdefault("library_id", library_id)
		debug.setdefault("ask_policy", policy_snapshot)
		debug["hybrid_enabled"] = bool(ask_settings.hybrid_enabled)
		debug["rerank_enabled"] = bool(ask_settings.rerank_enabled)
		answer, citations = _finalize_generation_output(
			answer=state.get("answer") or "",
			raw_citations=raw_citations,
			allowed_hits=raw_citations,
			debug=debug,
		)
		append_temp_session_memory(
			thread_id=resolved_thread,
			session_memory_enabled=ask_settings.session_memory_enabled,
			session_memory=self.session_memory,
			memory_session=memory_session,
			question=question,
			answer=answer,
		)
		judge = state.get("judgement") or debug.get("judgement")
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
		query_type = state.get("query_type") or debug.get("query_type")
		rewrite_mode = debug.get("rewrite")
		finalize_ask_debug(debug, started_at=started_at, truncated=False)
		persist = _persist_turn(
			session_id=resolved_session,
			thread_id=resolved_thread,
			library_id=library_id,
			question=question,
			answer=answer,
			citations=citations,
			mode=self.mode,
			refused=bool(state.get("refused")),
			refuse_reason=state.get("refuse_reason"),
			query_type=str(query_type) if query_type else None,
			retrieval_plan=plan if isinstance(plan, dict) else None,
			retrieval_debug=debug,
			rewrite=str(rewrite_mode) if rewrite_mode else None,
			rewritten_query=state.get("rewritten_question"),
			judge=judge if isinstance(judge, dict) else None,
			document_version_id=_single_document_version_id(citations),
			tenant_id=self.access_scope.tenant_id,
			workspace_id=self.access_scope.workspace_id,
			principal_id=self.access_scope.principal_id,
		)
		emit_ask_trace(debug)
		visibility = _retrieval_visibility(debug)
		return AskResponse(
			session_id=resolved_session,
			thread_id=resolved_thread,
			question=question,
			answer=answer,
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
		thread_id: str | None = None,
		trace_id: str | None = None,
		ask_overrides: dict[str, Any] | None = None,
	):
		"""Yield SSE-friendly dicts: meta → citations → token* → done | error."""
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
		previous_retrieval_settings = self._apply_retrieval_settings(ask_settings)
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

		try:
			graph = self._graph_for_settings(ask_settings, generate_fn=capture_generate)
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
				stream=True,
			)
			debug_seed["rerank_enabled"] = bool(ask_settings.rerank_enabled)
			debug_seed["ask_policy"] = policy_snapshot
			state = graph.invoke(
				{
					"session_id": resolved_session,
					"question": question,
					"library_id": library_id,
					"history": history,
					"trace_id": resolved_trace,
					"retrieval_debug": debug_seed,
				}
			)
		finally:
			if previous_retrieval_settings is not None and self._retrieval_service is not None:
				self._retrieval_service.settings = previous_retrieval_settings
		debug = self._merge_retrieval_debug(state.get("retrieval_debug") or {})
		debug.setdefault("trace_id", resolved_trace)
		debug.setdefault("question_hash", question_hash(question))
		debug.setdefault("library_id", library_id)
		debug.setdefault("ask_policy", policy_snapshot)
		debug["hybrid_enabled"] = bool(ask_settings.hybrid_enabled)
		debug["rerank_enabled"] = bool(ask_settings.rerank_enabled)
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
			# 流式生成可能改写 answer；若日后结构化 JSON，出口再对账一次
			answer, citation_models = _finalize_generation_output(
				answer=answer,
				raw_citations=raw_citations,
				allowed_hits=raw_citations,
				debug=debug,
			)
			citations = [item.model_dump() for item in citation_models]
			finalize_ask_debug(debug, started_at=started_at, truncated=mark_truncated)
			judge = state.get("judgement") or debug.get("judgement")
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
			query_type_final = state.get("query_type") or debug.get("query_type")
			rewrite_mode = debug.get("rewrite")
			persist = _persist_turn(
				session_id=resolved_session,
				thread_id=resolved_thread,
				library_id=library_id,
				question=question,
				answer=answer,
				citations=citation_models,
				mode=self.mode,
				refused=refused,
				refuse_reason=state.get("refuse_reason"),
				query_type=str(query_type_final) if query_type_final else None,
				retrieval_plan=plan if isinstance(plan, dict) else None,
				retrieval_debug=debug,
				rewrite=str(rewrite_mode) if rewrite_mode else None,
				rewritten_query=state.get("rewritten_question"),
				judge=judge if isinstance(judge, dict) else None,
				document_version_id=_single_document_version_id(citation_models),
				tenant_id=self.access_scope.tenant_id,
				workspace_id=self.access_scope.workspace_id,
				principal_id=self.access_scope.principal_id,
			)
			emit_ask_trace(debug)

		try:
			yield {
				"event": "meta",
				"data": {
					"session_id": resolved_session,
					"thread_id": resolved_thread,
					"mode": self.mode,
					"refused": refused,
					"refuse_reason": state.get("refuse_reason"),
					"trace_id": resolved_trace,
					"hybrid_failed": visibility["hybrid_failed"],
					"rerank_failed": visibility["rerank_failed"],
					"retrieval_mode": visibility["retrieval_mode"],
				},
			}
			yield {"event": "citations", "data": citations}

			execution = state.get("table_execution") or debug.get("table_execution") or {}
			tq = state.get("table_query_plan") or debug.get("table_query_plan") or {}
			query_type = str(state.get("query_type") or debug.get("query_type") or "")
			gen_history = history_for_generate(history)
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
				thread_id=resolved_thread,
				session_memory_enabled=ask_settings.session_memory_enabled,
				session_memory=self.session_memory,
				memory_session=memory_session,
				question=question,
				answer=answer,
			)

			yield {
				"event": "done",
				"data": {
					"session_id": resolved_session,
					"thread_id": resolved_thread,
					"question": question,
					"answer": answer,
					"citations": citations,
					"mode": self.mode,
					"refused": refused,
					"refuse_reason": state.get("refuse_reason"),
					"trace_id": resolved_trace,
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
