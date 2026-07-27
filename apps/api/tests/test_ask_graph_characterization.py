"""Characterization — AskGraph topology + stub paths (no behavior change).

Locks Step 2 AskGraph 提交 1: fixed node topology, stub ask / refuse / retry /
table, and sync vs stream finalize contract. Prefer direct service/graph calls.
"""

from __future__ import annotations

from app.graph.ask_graph import AskGraphService, build_ask_graph, stub_generate
from app.settings import Settings

# Stable topology snapshot (LangGraph compile nodes / edges).
_EXPECTED_NODES = frozenset(
	{
		"query_router",
		"build_retrieval_plan",
		"clarify",
		"build_table_plan",
		"table_retrieve",
		"table_execute",
		"rewrite",
		"retrieve",
		"judge",
		"retry",
		"generate",
		"refuse",
	}
)

# (source, target) — ignore LangGraph edge `data` labels; conditional vs fixed both count.
_EXPECTED_EDGES = frozenset(
	{
		("__start__", "query_router"),
		("query_router", "build_retrieval_plan"),
		("build_retrieval_plan", "clarify"),
		("build_retrieval_plan", "rewrite"),
		("clarify", "__end__"),
		("rewrite", "retrieve"),
		("rewrite", "build_table_plan"),
		("build_table_plan", "table_retrieve"),
		("table_retrieve", "table_execute"),
		("table_execute", "judge"),
		("table_execute", "__end__"),
		("retrieve", "build_table_plan"),
		("retrieve", "judge"),
		("judge", "retry"),
		("judge", "generate"),
		("judge", "refuse"),
		("retry", "retrieve"),
		("retry", "table_retrieve"),
		("generate", "__end__"),
		("refuse", "__end__"),
	}
)


def _stub_service(**settings_kwargs) -> AskGraphService:
	return AskGraphService(
		Settings(ask_mode="stub", internal_auth_enabled=False, **settings_kwargs)
	)


def _citation_fingerprint(citations) -> list[tuple]:
	out: list[tuple] = []
	for item in citations:
		if hasattr(item, "model_dump"):
			data = item.model_dump()
		elif isinstance(item, dict):
			data = item
		else:
			data = dict(item)
		out.append(
			(
				data.get("id"),
				data.get("index"),
				round(float(data.get("score") or 0.0), 4),
				(data.get("text") or data.get("snippet") or "")[:80],
			)
		)
	return out


def test_ask_graph_topology_nodes_and_edges_fixed() -> None:
	graph = build_ask_graph(
		settings=Settings(ask_mode="stub", internal_auth_enabled=False),
		retrieve_fn=lambda *_a, **_k: [],
		generate_fn=stub_generate,
		mode="stub",
	)
	nodes = {name for name in graph.nodes if not str(name).startswith("__")}
	assert nodes == _EXPECTED_NODES

	edges = frozenset((edge.source, edge.target) for edge in graph.get_graph().edges)
	assert edges == _EXPECTED_EDGES


def test_ask_stub_ordinary_qa() -> None:
	service = _stub_service()
	result = service.ask(
		question="病假需要在几天内补交证明？",
		library_id="lib-char-ask",
		session_id="char-ask-1",
	)
	assert result.refused is False
	assert result.refuse_reason is None
	assert result.mode == "stub"
	assert "三个工作日" in result.answer
	assert len(result.citations) >= 1
	assert (result.retrieval_debug or {}).get("judgement", {}).get("action") == "generate"


def test_ask_stub_refuse_no_hit() -> None:
	service = _stub_service()
	result = service.ask(
		question="无命中：火星上的年假怎么算？",
		library_id="lib-char-refuse",
		session_id="char-refuse-1",
	)
	assert result.refused is True
	assert result.refuse_reason == "no_hit"
	assert result.citations == []
	assert "没有找到" in result.answer


def test_ask_stub_retry_then_generate() -> None:
	calls = {"n": 0}

	def flaky_retrieve(
		_query: str,
		_library_id: str | None,
		_top_k: int,
		_filters: dict | None = None,
	):
		calls["n"] += 1
		if calls["n"] == 1:
			return []
		return [
			{
				"id": "ok",
				"index": 1,
				"title": "制度.pdf",
				"page": "1",
				"snippet": "三个工作日",
				"score": 0.9,
				"text": "病假三个工作日内补交证明",
			}
		]

	service = AskGraphService(
		Settings(
			ask_mode="stub",
			internal_auth_enabled=False,
			max_retrieve_retries=1,
		),
		retrieve_fn=flaky_retrieve,
		generate_fn=stub_generate,
	)
	result = service.ask(
		question="病假几天？",
		library_id="lib-char-retry",
		session_id="char-retry-1",
	)
	assert result.refused is False
	assert calls["n"] == 2
	assert "三个工作日" in result.answer


def test_ask_stub_table_precise_path() -> None:
	service = _stub_service(max_retrieve_retries=0)
	result = service.ask(
		question="表格里最低报价是多少？",
		library_id="lib-char-table",
		session_id="char-table-1",
	)
	assert result.refused is False
	debug = result.retrieval_debug or {}
	assert debug.get("path") == "precise"
	assert debug.get("route") == "precise_table"
	assert debug.get("query_type") == "table"
	assert "80000" in result.answer


def test_ask_sync_and_stream_finalize_consistent() -> None:
	"""Sync ask() and stream done payload share finalize contract fields."""
	question = "病假需要在几天内补交证明？"
	library_id = "lib-char-sync-stream"
	service = _stub_service()

	sync = service.ask(
		question=question,
		library_id=library_id,
		session_id="char-sync-1",
	)
	events = list(
		service.iter_ask_events(
			question=question,
			library_id=library_id,
			session_id="char-stream-1",
		)
	)
	assert [e["event"] for e in events[:2]] == ["meta", "citations"]
	assert any(e["event"] == "token" for e in events)
	done = next(e for e in events if e["event"] == "done")["data"]

	assert sync.answer == done["answer"]
	assert sync.refused == done["refused"]
	assert sync.refuse_reason == done.get("refuse_reason")
	assert sync.mode == done["mode"]
	assert sync.retrieval_mode == done["retrieval_mode"]
	assert _citation_fingerprint(sync.citations) == _citation_fingerprint(
		done["citations"]
	)

	# Refuse path: same finalize fields.
	service_r = _stub_service()
	sync_r = service_r.ask(
		question="无命中：火星年假？",
		library_id=library_id,
		session_id="char-sync-r",
	)
	done_r = next(
		e["data"]
		for e in service_r.iter_ask_events(
			question="无命中：火星年假？",
			library_id=library_id,
			session_id="char-stream-r",
		)
		if e["event"] == "done"
	)
	assert sync_r.refused is True
	assert sync_r.answer == done_r["answer"]
	assert sync_r.refuse_reason == done_r["refuse_reason"]
	assert _citation_fingerprint(sync_r.citations) == _citation_fingerprint(
		done_r["citations"]
	)
