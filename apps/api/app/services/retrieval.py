from __future__ import annotations

import logging
from typing import Any
from uuid import uuid4

from app.services.chunking import chunk_text
from app.services.llm import EmbeddingService
from app.services.qdrant_store import QdrantStore
from app.services.rerank import RerankClient
from app.settings import Settings

logger = logging.getLogger(__name__)


def _clamp_score(score: float) -> float:
	return max(0.0, min(1.0, float(score)))


class IngestService:
	def __init__(
		self,
		settings: Settings,
		*,
		embeddings: EmbeddingService | None = None,
		store: QdrantStore | None = None,
	) -> None:
		self.settings = settings
		self.embeddings = embeddings or EmbeddingService(settings)
		self.store = store or QdrantStore(settings)

	def ingest_text(
		self,
		*,
		library_id: str,
		title: str,
		text: str,
		doc_id: str | None = None,
	) -> dict[str, Any]:
		resolved_doc_id = doc_id or str(uuid4())
		pieces = chunk_text(
			text,
			chunk_size=self.settings.chunk_size,
			chunk_overlap=self.settings.chunk_overlap,
		)
		if not pieces:
			raise ValueError("text is empty after cleaning")

		chunks = [{"chunk_index": piece.index, "text": piece.text} for piece in pieces]
		vectors = self.embeddings.embed_texts([piece.text for piece in pieces])
		count = self.store.upsert_chunks(
			library_id=library_id,
			doc_id=resolved_doc_id,
			title=title,
			chunks=chunks,
			vectors=vectors,
		)
		logger.info(
			"ingest.done library_id=%s doc_id=%s chunks=%s",
			library_id,
			resolved_doc_id,
			count,
		)
		return {
			"library_id": library_id,
			"doc_id": resolved_doc_id,
			"title": title,
			"chunk_count": count,
		}


class RetrievalService:
	def __init__(
		self,
		settings: Settings,
		*,
		embeddings: EmbeddingService | None = None,
		store: QdrantStore | None = None,
		reranker: RerankClient | None = None,
	) -> None:
		self.settings = settings
		self.embeddings = embeddings or EmbeddingService(settings)
		self.store = store or QdrantStore(settings)
		if reranker is not None:
			self.reranker = reranker
		elif settings.rerank_enabled and settings.has_llm_key:
			self.reranker = RerankClient(settings)
		else:
			self.reranker = None

	def search(self, *, query: str, library_id: str | None, top_k: int | None = None) -> list[dict[str, Any]]:
		limit = top_k or self.settings.retrieve_top_k
		# Pull a slightly wider dense pool when rerank will trim.
		dense_k = max(limit, self.settings.rerank_top_k) if self.reranker else limit
		vector = self.embeddings.embed_query(query)
		hits = self.store.search(
			vector=vector,
			library_id=library_id,
			top_k=dense_k,
		)
		citations: list[dict[str, Any]] = []
		for index, hit in enumerate(hits, start=1):
			citations.append(
				{
					"id": hit["id"],
					"index": index,
					"title": hit["title"],
					"page": hit.get("page"),
					"snippet": hit["snippet"],
					"score": _clamp_score(hit["score"]),
					"dense_score": float(hit["score"]),
					"text": hit.get("text") or hit["snippet"],
				}
			)
		return self._maybe_rerank(query=query, citations=citations, top_k=limit)

	def _maybe_rerank(
		self,
		*,
		query: str,
		citations: list[dict[str, Any]],
		top_k: int,
	) -> list[dict[str, Any]]:
		if self.reranker is None or len(citations) <= 1:
			trimmed = citations[:top_k]
			for index, item in enumerate(trimmed, start=1):
				item["index"] = index
				item["used_rerank"] = False
			return trimmed

		documents = [str(item.get("text") or item.get("snippet") or "") for item in citations]
		try:
			ranked = self.reranker.rerank(
				query=query,
				documents=documents,
				top_n=min(self.settings.rerank_top_k, top_k, len(citations)),
			)
		except Exception:
			logger.exception("retrieval.rerank_failed fallback_top_k=%s", top_k)
			trimmed = citations[:top_k]
			for index, item in enumerate(trimmed, start=1):
				item["index"] = index
				item["used_rerank"] = False
				item["rerank_error"] = True
			return trimmed

		reranked: list[dict[str, Any]] = []
		for original_index, rerank_score in ranked:
			if original_index < 0 or original_index >= len(citations):
				continue
			item = dict(citations[original_index])
			item["dense_score"] = float(item.get("dense_score", item.get("score") or 0.0))
			item["score"] = _clamp_score(rerank_score)
			item["used_rerank"] = True
			reranked.append(item)

		final = (reranked or citations)[:top_k]
		for index, item in enumerate(final, start=1):
			item["index"] = index
			item.setdefault("used_rerank", bool(reranked))
		return final
