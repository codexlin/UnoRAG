from __future__ import annotations

import json

from app.graph.ask_graph import (
	AskGraphService,
	build_generate_messages,
	history_for_generate,
	question_with_working_memory,
	rewrite_with_history,
	stub_generate,
)
from app.services.ask_overrides import effective_ask_settings
from app.services.retrieval import RetrievalService
from app.services.runtime import RuntimeCapability
from app.services.session_memory import WORKING_MEMORY_MAX_TURNS, SessionMemory
from app.settings import Settings


class _FakeReranker:
	def rerank(self, *, query: str, documents: list[str], top_n: int) -> list[tuple[int, float]]:
		_ = query
		# Prefer the second document when present.
		order = list(range(len(documents)))
		if len(order) >= 2:
			order = [1, 0, *order[2:]]
		return [(idx, 0.95 - i * 0.1) for i, idx in enumerate(order[:top_n])]


class _BoomReranker:
	def rerank(self, *, query: str, documents: list[str], top_n: int) -> list[tuple[int, float]]:
		_ = query, documents, top_n
		raise RuntimeError("rerank unavailable")


def test_rewrite_with_history_followup() -> None:
	rewritten, mode = rewrite_with_history(
		"那逾期呢？",
		[{"role": "user", "content": "病假证明几天内补交？"}, {"role": "assistant", "content": "三个工作日"}],
	)
	assert mode == "history"
	# Coref must use prior *answer*, not only prior question.
	assert "三个工作日" in rewritten
	assert "病假证明几天内补交" in rewritten
	assert "那逾期呢" in rewritten


def test_rewrite_resolves_pronoun_with_prior_answer() -> None:
	"""「那它的价格是多少」+ 上轮答「边缘计算网关」→ rewrite 含实体名。"""
	history = [
		{"role": "user", "content": "序号为1的设备名是什么"},
		{"role": "assistant", "content": "边缘计算网关"},
	]
	rewritten, mode = rewrite_with_history("那它的价格是多少", history)
	assert mode == "history"
	assert "边缘计算网关" in rewritten
	assert "价格" in rewritten

	# 无历史时保持含糊，不得臆造实体。
	bare, bare_mode = rewrite_with_history("那它的价格是多少", [])
	assert bare_mode == "passthrough"
	assert bare == "那它的价格是多少"
	assert "边缘计算网关" not in bare


def test_build_generate_messages_includes_multi_turn_history() -> None:
	history = [
		{"role": "user", "content": "序号为1的设备名是什么"},
		{"role": "assistant", "content": "边缘计算网关"},
		{"role": "user", "content": "功率呢"},
		{"role": "assistant", "content": "约 45W"},
	]
	messages = build_generate_messages(
		question="那它的价格是多少",
		context="[1] 报价表\n边缘计算网关 单价 12800",
		history=history,
	)
	assert messages[0]["role"] == "system"
	# Full prior turns as user/assistant, not a one-line「上一轮」hint.
	roles = [m["role"] for m in messages[1:-1]]
	assert roles == ["user", "assistant", "user", "assistant"]
	assert messages[1]["content"] == "序号为1的设备名是什么"
	assert messages[2]["content"] == "边缘计算网关"
	assert "约 45W" in messages[4]["content"]
	assert messages[-1]["role"] == "user"
	assert "那它的价格是多少" in messages[-1]["content"]
	assert "资料：" in messages[-1]["content"]
	assert "12800" in messages[-1]["content"]
	# Current question must not be baked into history as a short working-memory line.
	joined_history = "\n".join(m["content"] for m in messages[1:-1])
	assert "上一轮" not in joined_history


def test_history_for_generate_drops_oldest_when_over_budget() -> None:
	history = [
		{"role": "user", "content": "q1-" + ("a" * 100)},
		{"role": "assistant", "content": "a1-" + ("b" * 100)},
		{"role": "user", "content": "q2-" + ("c" * 100)},
		{"role": "assistant", "content": "a2-" + ("d" * 100)},
	]
	trimmed = history_for_generate(history, max_turns=10, max_chars=250)
	assert len(trimmed) == 2
	assert trimmed[0]["content"].startswith("q2-")
	assert trimmed[1]["content"].startswith("a2-")


def test_question_with_working_memory_includes_prior_answer() -> None:
	"""Compat helper still works; ask path uses build_generate_messages instead."""
	prompt = question_with_working_memory(
		"那它的价格是多少",
		[
			{"role": "user", "content": "序号为1的设备名是什么"},
			{"role": "assistant", "content": "边缘计算网关"},
		],
	)
	assert "边缘计算网关" in prompt
	assert "那它的价格是多少" in prompt
	assert question_with_working_memory("那它的价格是多少", []) == "那它的价格是多少"


def test_rewrite_passthrough_without_history() -> None:
	rewritten, mode = rewrite_with_history("病假证明几天内补交？", [])
	assert mode == "passthrough"
	assert rewritten == "病假证明几天内补交？"


def test_working_memory_constant_is_effect_first_window() -> None:
	assert WORKING_MEMORY_MAX_TURNS >= 8
	assert WORKING_MEMORY_MAX_TURNS <= 12


def test_session_memory_rewrite_on_followup() -> None:
	memory = SessionMemory(max_turns=4)
	settings = Settings(ask_mode="stub", max_retrieve_retries=0)
	seen: dict[str, str] = {}
	gen_seen: dict[str, object] = {}

	def capture_retrieve(
		query: str,
		_library_id: str | None,
		_top_k: int,
		_filters: dict | None = None,
	):
		seen["query"] = query
		return [
			{
				"id": "ok",
				"index": 1,
				"title": "制度.pdf",
				"page": "1",
				"snippet": "三个工作日",
				"score": 0.9,
				"text": "病假三个工作日内补交证明",
				"used_rerank": False,
			}
		]

	def capture_generate(messages: list[dict[str, str]], citations: list) -> str:
		gen_seen["messages"] = messages
		return stub_generate(messages, citations)

	service = AskGraphService(
		settings,
		retrieve_fn=capture_retrieve,
		generate_fn=capture_generate,
		session_memory=memory,
	)
	first = service.ask(question="病假证明几天内补交？", session_id="s-mem-1")
	assert first.retrieval_debug.get("rewrite") == "passthrough"

	second = service.ask(question="那逾期呢？", session_id="s-mem-1")
	assert second.retrieval_debug.get("rewrite") == "history"
	assert "病假证明几天内补交" in seen["query"]
	assert "那逾期呢" in seen["query"]
	# Prior stub answer first-line snippet must appear in retrieval rewrite.
	assert "三个工作日" in seen["query"] or "病假" in seen["query"]
	messages = gen_seen["messages"]
	assert isinstance(messages, list)
	assert any(m.get("role") == "user" and "病假证明几天内补交" in m.get("content", "") for m in messages)
	assert any(m.get("role") == "assistant" for m in messages)
	assert any(
		m.get("role") == "user" and "那逾期呢" in m.get("content", "") for m in messages
	)
	assert second.retrieval_debug.get("generate_history_turns", 0) >= 2
	assert second.session_id == "s-mem-1"


def test_session_memory_device_price_coref() -> None:
	"""Temp session: Q2「那它的价格」rewrite 含实体；generate messages 含完整上轮 Q+A。"""
	memory = SessionMemory(max_turns=4)
	settings = Settings(ask_mode="stub", max_retrieve_retries=0)
	seen: dict[str, str] = {}
	gen_seen: dict[str, object] = {}

	def capture_retrieve(
		query: str,
		_library_id: str | None,
		_top_k: int,
		_filters: dict | None = None,
	):
		seen["query"] = query
		return [
			{
				"id": "quote-big",
				"index": 1,
				"title": "报价表.pdf",
				"page": "1",
				"snippet": "边缘计算网关 单价 12800",
				"score": 0.92,
				"text": "序号1 边缘计算网关 单价 12800",
				"used_rerank": False,
			}
		]

	def capture_generate(messages: list[dict[str, str]], citations: list) -> str:
		gen_seen["messages"] = messages
		blob = "\n".join(m.get("content", "") for m in messages)
		if "边缘计算网关" in blob and "价格" in blob:
			return "边缘计算网关的价格是 12800。"
		return stub_generate(messages, citations)

	service = AskGraphService(
		settings,
		retrieve_fn=capture_retrieve,
		generate_fn=capture_generate,
		session_memory=memory,
	)
	# Seed memory as if Q1 already answered (bypass stub answer text).
	memory.append(
		service._memory_session_id("s-device-1"),
		"user",
		"序号为1的设备名是什么",
	)
	memory.append(
		service._memory_session_id("s-device-1"),
		"assistant",
		"边缘计算网关",
	)

	follow = service.ask(question="那它的价格是多少", session_id="s-device-1")
	assert follow.retrieval_debug.get("rewrite") == "history"
	assert "边缘计算网关" in seen["query"]
	assert "价格" in seen["query"]
	messages = gen_seen["messages"]
	assert isinstance(messages, list)
	# Rewrite query ≠ generate history: history keeps full prior answer text.
	assert any(
		m.get("role") == "assistant" and m.get("content") == "边缘计算网关" for m in messages
	)
	assert any(
		m.get("role") == "user" and "那它的价格是多少" in m.get("content", "") for m in messages
	)
	assert "12800" in follow.answer


def test_live_structured_plan_keeps_history_rewrite_query(monkeypatch) -> None:
	"""Live plan 成功时：filters 用 plan；检索 query 仍为 history rewrite，不丢上下文。"""
	memory = SessionMemory(max_turns=4)
	settings = Settings(
		ask_mode="live",
		openai_api_key="test-key",
		max_retrieve_retries=0,
	)
	capability = RuntimeCapability(
		requested_mode="live",
		effective_mode="live",
		graph="ask_v1",
		degraded=False,
		has_llm_key=True,
		qdrant_ok=True,
	)
	seen: dict[str, object] = {}

	def capture_retrieve(
		query: str,
		_library_id: str | None,
		_top_k: int,
		_filters: dict | None = None,
	):
		seen["query"] = query
		seen["filters"] = dict(_filters or {})
		return [
			{
				"id": "ok",
				"index": 1,
				"title": "报价表.pdf",
				"page": "1",
				"snippet": "边缘计算网关 单价 12800",
				"score": 0.9,
				"text": "边缘计算网关 单价 12800",
				"record_type": "chunk",
				"used_rerank": False,
			}
		]

	def fake_plan_json(settings_obj, *, question: str, fallback_semantic_query: str) -> str:
		_ = settings_obj, question, fallback_semantic_query
		# 故意返回短 semantic_query（丢实体），验证不得覆盖 history rewrite
		return json.dumps(
			{
				"semantic_query": "那它的价格是多少",
				"filters": {"record_type": "chunk", "doc_id": "doc-quote"},
			},
			ensure_ascii=False,
		)

	monkeypatch.setattr(
		"app.graph.nodes.rewrite._request_structured_retrieval_plan_json",
		fake_plan_json,
	)

	service = AskGraphService(
		settings,
		capability=capability,
		retrieve_fn=capture_retrieve,
		generate_fn=stub_generate,
		session_memory=memory,
	)
	memory.append(
		service._memory_session_id("s-live-plan-1"),
		"user",
		"序号为1的设备名是什么",
	)
	memory.append(
		service._memory_session_id("s-live-plan-1"),
		"assistant",
		"边缘计算网关",
	)

	result = service.ask(
		question="那它的价格是多少",
		session_id="s-live-plan-1",
		library_id="lib-live-plan",
	)
	assert result.retrieval_debug.get("rewrite") == "history"
	assert result.retrieval_debug.get("retrieval_query_source") == "history_rewrite"
	query = str(seen["query"])
	assert "边缘计算网关" in query
	assert "价格" in query
	# plan 短句不得成为检索 query
	assert query != "那它的价格是多少"
	assert result.retrieval_debug.get("plan_semantic_query") == "那它的价格是多少"
	srp = result.retrieval_debug.get("structured_retrieval_plan") or {}
	assert srp.get("degraded") is False
	assert srp.get("filters", {}).get("doc_id") == "doc-quote"
	# ask fast 双路仍可能拆 filters；至少 plan 合并后应保留 doc_id
	plan_filters = (result.retrieval_debug.get("retrieval_plan") or {}).get("filters") or {}
	assert plan_filters.get("doc_id") == "doc-quote"


def test_rerank_reorders_hits() -> None:
	settings = effective_ask_settings(
		Settings(ask_mode="stub", rerank_top_k=2),
		{"rerank_enabled": True, "retrieve_top_k": 2},
	)

	class _Store:
		def search(self, *, vector, library_id, top_k, **_kwargs):
			_ = vector, library_id
			return [
				{
					"id": "a",
					"title": "low",
					"page": None,
					"snippet": "aaa",
					"score": 0.9,
					"text": "aaa",
				},
				{
					"id": "b",
					"title": "high-after-rerank",
					"page": None,
					"snippet": "bbb",
					"score": 0.5,
					"text": "bbb",
				},
			][:top_k]

	class _Emb:
		def embed_query(self, text: str):
			_ = text
			return [0.1, 0.2]

	svc = RetrievalService(
		settings,
		embeddings=_Emb(),  # type: ignore[arg-type]
		store=_Store(),  # type: ignore[arg-type]
		reranker=_FakeReranker(),  # type: ignore[arg-type]
	)
	hits = svc.search(query="q", library_id="lib-hr", top_k=2)
	assert hits[0]["id"] == "b"
	assert hits[0]["used_rerank"] is True
	assert hits[0]["score"] >= hits[1]["score"]


def test_rerank_fallback_on_error() -> None:
	settings = effective_ask_settings(
		Settings(ask_mode="stub"),
		{"rerank_enabled": True, "retrieve_top_k": 2},
	)

	class _Store:
		def search(self, *, vector, library_id, top_k, **_kwargs):
			_ = vector, library_id
			return [
				{
					"id": "a",
					"title": "keep",
					"page": None,
					"snippet": "aaa",
					"score": 0.8,
					"text": "aaa",
				},
				{
					"id": "b",
					"title": "also",
					"page": None,
					"snippet": "bbb",
					"score": 0.7,
					"text": "bbb",
				},
			][:top_k]

	class _Emb:
		def embed_query(self, text: str):
			_ = text
			return [0.1]

	svc = RetrievalService(
		settings,
		embeddings=_Emb(),  # type: ignore[arg-type]
		store=_Store(),  # type: ignore[arg-type]
		reranker=_BoomReranker(),  # type: ignore[arg-type]
	)
	hits = svc.search(query="q", library_id="lib-hr", top_k=2)
	assert hits[0]["id"] == "a"
	assert hits[0]["used_rerank"] is False
	assert hits[0].get("rerank_error") is True
	assert svc.last_debug.get("rerank_failed") is True
	assert svc.last_debug.get("retrieval_mode") == "dense"


def test_hybrid_failure_flags_dense_fallback() -> None:
	settings = effective_ask_settings(
		Settings(ask_mode="stub", bm25_top_k=1),
		{"hybrid_enabled": True, "retrieve_top_k": 1},
	)

	class _Store:
		def search(self, *, vector, library_id, top_k, **_kwargs):
			_ = vector, library_id
			return [
				{
					"id": "a",
					"title": "keep",
					"page": None,
					"snippet": "aaa",
					"score": 0.8,
					"text": "aaa",
					"doc_id": "d1",
					"chunk_index": 0,
				}
			][:top_k]

		def list_chunks(self, *, library_id, limit=10_000, **_kwargs):
			_ = library_id, limit
			raise RuntimeError("bm25 corpus unavailable")

	class _Emb:
		def embed_query(self, text: str):
			_ = text
			return [0.1]

	svc = RetrievalService(
		settings,
		embeddings=_Emb(),  # type: ignore[arg-type]
		store=_Store(),  # type: ignore[arg-type]
		reranker=None,
	)
	hits = svc.search(query="q", library_id="lib-hr", top_k=1)
	assert hits[0]["id"] == "a"
	assert svc.last_debug.get("hybrid_failed") is True
	assert svc.last_debug.get("used_hybrid") is False
	assert svc.last_debug.get("retrieval_mode") == "dense"


def test_retrieval_requires_library_id() -> None:
	settings = Settings(ask_mode="stub")

	class _Store:
		def search(self, *, vector, library_id, top_k, **_kwargs):
			_ = vector, library_id, top_k
			raise AssertionError("search must not run without library_id")

	class _Emb:
		def embed_query(self, text: str):
			_ = text
			return [0.1]

	svc = RetrievalService(
		settings,
		embeddings=_Emb(),  # type: ignore[arg-type]
		store=_Store(),  # type: ignore[arg-type]
		reranker=None,
	)
	try:
		svc.search(query="q", library_id=None, top_k=1)
		raise AssertionError("expected ValueError")
	except ValueError as exc:
		assert "library_id" in str(exc)


def test_chunk_plus_table_summary_filters_record_types() -> None:
	"""chunk+table_summary：dense/hybrid 不得混入 section/table/document。"""
	settings = effective_ask_settings(
		Settings(ask_mode="stub", bm25_top_k=4),
		{"hybrid_enabled": True, "retrieve_top_k": 4, "rerank_enabled": False},
	)
	seen_rt: dict[str, str | None] = {}

	class _Store:
		def search(self, *, vector, library_id, top_k, record_type=None, **_kwargs):
			_ = vector, library_id
			seen_rt["dense"] = record_type
			return [
				{
					"id": "c1",
					"title": "chunk",
					"page": "1",
					"snippet": "chunk body",
					"score": 0.9,
					"text": "chunk body",
					"doc_id": "d1",
					"chunk_index": 0,
					"record_type": "chunk",
				},
				{
					"id": "s1",
					"title": "summary",
					"page": "1",
					"snippet": "table summary",
					"score": 0.85,
					"text": "table summary",
					"doc_id": "d1",
					"chunk_index": 0,
					"record_type": "table_summary",
				},
				# 若 store 未过滤，section 会混入；后置 filter 应剔除
				{
					"id": "sec1",
					"title": "section",
					"page": "1",
					"snippet": "section body",
					"score": 0.95,
					"text": "section body",
					"doc_id": "d1",
					"chunk_index": 1,
					"record_type": "section",
				},
			][:top_k]

		def list_chunks(self, *, library_id, record_type="chunk", limit=10_000, **_kwargs):
			_ = library_id, limit
			seen_rt["bm25"] = record_type
			return [
				{
					"id": "c1",
					"doc_id": "d1",
					"chunk_index": 0,
					"title": "chunk",
					"text": "chunk body keyword",
					"body": "chunk body keyword",
					"record_type": "chunk",
				},
				{
					"id": "s1",
					"doc_id": "d1",
					"chunk_index": 0,
					"title": "summary",
					"text": "table summary keyword",
					"body": "table summary keyword",
					"record_type": "table_summary",
				},
				{
					"id": "sec1",
					"doc_id": "d1",
					"chunk_index": 1,
					"title": "section",
					"text": "section body keyword",
					"body": "section body keyword",
					"record_type": "section",
				},
			]

	class _Emb:
		def embed_query(self, text: str):
			_ = text
			return [0.1]

	svc = RetrievalService(
		settings,
		embeddings=_Emb(),  # type: ignore[arg-type]
		store=_Store(),  # type: ignore[arg-type]
		reranker=None,
	)
	hits = svc.search(
		query="keyword",
		library_id="lib-cts",
		top_k=4,
		filters={"record_type": "chunk+table_summary"},
	)
	assert seen_rt["dense"] == "chunk+table_summary"
	assert seen_rt["bm25"] == "chunk+table_summary"
	types = {str(h.get("record_type")) for h in hits}
	assert types <= {"chunk", "table_summary"}
	assert "section" not in types
	assert svc.last_debug.get("allowed_record_types") == ["chunk", "table_summary"]
