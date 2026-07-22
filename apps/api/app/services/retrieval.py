from __future__ import annotations

import logging
from typing import Any
from uuid import uuid4

from app.services.chunking import chunk_text
from app.services.documents import infer_page_label
from app.services.hybrid import fuse_dense_and_bm25, get_bm25_cache
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
		self._embeddings = embeddings
		self._store = store

	@property
	def embeddings(self) -> EmbeddingService:
		if self._embeddings is None:
			self._embeddings = EmbeddingService(self.settings)
		return self._embeddings

	@property
	def store(self) -> QdrantStore:
		if self._store is None:
			self._store = QdrantStore(self.settings)
		return self._store

	def ingest_text(
		self,
		*,
		library_id: str,
		title: str,
		text: str,
		doc_id: str | None = None,
		filename: str | None = None,
	) -> dict[str, Any]:
		resolved_doc_id = doc_id or str(uuid4())
		pieces = chunk_text(
			text,
			chunk_size=self.settings.chunk_size,
			chunk_overlap=self.settings.chunk_overlap,
		)
		if not pieces:
			raise ValueError("text is empty after cleaning")

		chunks = []
		for piece in pieces:
			chunk: dict[str, Any] = {"chunk_index": piece.index, "text": piece.text}
			page = infer_page_label(piece.text)
			if page:
				chunk["page"] = page
			if filename:
				chunk["filename"] = filename
			chunks.append(chunk)
		vectors = self.embeddings.embed_texts([piece.text for piece in pieces])
		count = self.store.upsert_chunks(
			library_id=library_id,
			doc_id=resolved_doc_id,
			title=title,
			chunks=chunks,
			vectors=vectors,
			filename=filename,
		)
		get_bm25_cache().invalidate(library_id)
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

	def simulate_ingest(
		self,
		*,
		library_id: str,
		title: str,
		text: str,
		doc_id: str | None = None,
	) -> dict[str, Any]:
		"""Stub-mode path: chunk only, no embed / Qdrant."""
		resolved_doc_id = doc_id or str(uuid4())
		pieces = chunk_text(
			text,
			chunk_size=self.settings.chunk_size,
			chunk_overlap=self.settings.chunk_overlap,
		)
		if not pieces:
			raise ValueError("text is empty after cleaning")
		return {
			"library_id": library_id,
			"doc_id": resolved_doc_id,
			"title": title,
			"chunk_count": len(pieces),
			"simulated": True,
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
		self.last_debug: dict[str, Any] = {}

	def search(self, *, query: str, library_id: str | None, top_k: int | None = None) -> list[dict[str, Any]]:
		limit = top_k or self.settings.retrieve_top_k
		# Pull a slightly wider dense pool when rerank / hybrid will trim.
		dense_k = max(limit, self.settings.rerank_top_k, self.settings.bm25_top_k)
		vector = self.embeddings.embed_query(query)
		dense_hits = self.store.search(
			vector=vector,
			library_id=library_id,
			top_k=dense_k,
		)
		hits = dense_hits
		used_hybrid = False
		hybrid_error: str | None = None

		if self.settings.hybrid_enabled and library_id:
			try:
				hits = self._hybrid_fuse(
					query=query,
					library_id=library_id,
					dense_hits=dense_hits,
					limit=dense_k,
				)
				used_hybrid = True
			except Exception as exc:
				hybrid_error = str(exc)
				logger.exception("retrieval.hybrid_failed fallback=dense library_id=%s", library_id)
				hits = dense_hits

		citations: list[dict[str, Any]] = []
		for index, hit in enumerate(hits, start=1):
			score = float(hit.get("score") or 0.0)
			# RRF scores are small; keep relative ordering but clamp for schema.
			if used_hybrid and hit.get("rrf_score") is not None:
				score = _clamp_score(float(hit["rrf_score"]) * 10.0)
			else:
				score = _clamp_score(score)
			citations.append(
				{
					"id": hit["id"],
					"index": index,
					"title": hit["title"],
					"page": hit.get("page"),
					"snippet": hit.get("snippet") or str(hit.get("text") or "")[:280],
					"score": score,
					"dense_score": hit.get("dense_score", hit.get("score")),
					"bm25_score": hit.get("bm25_score"),
					"rrf_score": hit.get("rrf_score"),
					"text": hit.get("text") or hit.get("snippet") or "",
					"doc_id": hit.get("doc_id"),
					"chunk_index": hit.get("chunk_index"),
					"filename": hit.get("filename"),
				}
			)
		final = self._maybe_rerank(query=query, citations=citations, top_k=limit)
		self.last_debug = {
			"used_hybrid": used_hybrid,
			"hybrid_enabled": self.settings.hybrid_enabled,
			"hybrid_error": hybrid_error,
			"dense_hit_count": len(dense_hits),
			"fusion": "rrf" if used_hybrid else "dense",
			"rrf_k": self.settings.rrf_k if used_hybrid else None,
		}
		for item in final:
			item["used_hybrid"] = used_hybrid
		return final

	def _hybrid_fuse(
		self,
		*,
		query: str,
		library_id: str,
		dense_hits: list[dict[str, Any]],
		limit: int,
	) -> list[dict[str, Any]]:
		cache = get_bm25_cache()
		index = cache.get_or_build(
			library_id,
			lambda: self.store.list_chunks(library_id=library_id),
		)
		bm25_hits = index.search(query, top_k=self.settings.bm25_top_k)
		if not bm25_hits:
			return dense_hits[:limit]
		if not dense_hits:
			return bm25_hits[:limit]
		return fuse_dense_and_bm25(
			dense_hits=dense_hits,
			bm25_hits=bm25_hits,
			rrf_k=self.settings.rrf_k,
			limit=limit,
		)

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
