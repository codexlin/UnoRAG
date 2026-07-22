from __future__ import annotations

from app.graph.ask_graph import AskGraphService, rewrite_with_history, stub_generate
from app.services.retrieval import RetrievalService
from app.services.session_memory import SessionMemory
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
	assert "病假证明几天内补交" in rewritten
	assert "那逾期呢" in rewritten


def test_rewrite_passthrough_without_history() -> None:
	rewritten, mode = rewrite_with_history("病假证明几天内补交？", [])
	assert mode == "passthrough"
	assert rewritten == "病假证明几天内补交？"


def test_session_memory_rewrite_on_followup() -> None:
	memory = SessionMemory(max_turns=4)
	settings = Settings(ask_mode="stub", session_memory_enabled=True, max_retrieve_retries=0)
	seen: dict[str, str] = {}

	def capture_retrieve(query: str, _library_id: str | None, _top_k: int):
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

	service = AskGraphService(
		settings,
		retrieve_fn=capture_retrieve,
		generate_fn=stub_generate,
		session_memory=memory,
	)
	first = service.ask(question="病假证明几天内补交？", session_id="s-mem-1")
	assert first.retrieval_debug.get("rewrite") == "passthrough"

	second = service.ask(question="那逾期呢？", session_id="s-mem-1")
	assert second.retrieval_debug.get("rewrite") == "history"
	assert "病假证明几天内补交" in seen["query"]
	assert "那逾期呢" in seen["query"]
	assert second.session_id == "s-mem-1"


def test_rerank_reorders_hits() -> None:
	settings = Settings(ask_mode="stub", rerank_enabled=True, rerank_top_k=2, retrieve_top_k=2)

	class _Store:
		def search(self, *, vector, library_id, top_k):
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
	settings = Settings(ask_mode="stub", rerank_enabled=True, retrieve_top_k=2)

	class _Store:
		def search(self, *, vector, library_id, top_k):
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
	hits = svc.search(query="q", library_id=None, top_k=2)
	assert hits[0]["id"] == "a"
	assert hits[0]["used_rerank"] is False
	assert hits[0].get("rerank_error") is True
