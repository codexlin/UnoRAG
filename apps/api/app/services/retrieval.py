from __future__ import annotations

import logging
from typing import Any
from uuid import uuid4

from app.services.chunking import chunk_text
from app.services.llm import EmbeddingService
from app.services.qdrant_store import QdrantStore
from app.settings import Settings

logger = logging.getLogger(__name__)


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
	) -> None:
		self.settings = settings
		self.embeddings = embeddings or EmbeddingService(settings)
		self.store = store or QdrantStore(settings)

	def search(self, *, query: str, library_id: str | None, top_k: int | None = None) -> list[dict[str, Any]]:
		vector = self.embeddings.embed_query(query)
		hits = self.store.search(
			vector=vector,
			library_id=library_id,
			top_k=top_k or self.settings.retrieve_top_k,
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
					"score": hit["score"],
					"text": hit.get("text") or hit["snippet"],
				}
			)
		return citations
