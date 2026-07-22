from __future__ import annotations

import logging
from typing import Any
from uuid import uuid4

from qdrant_client import QdrantClient
from qdrant_client.http import models as qm

from app.settings import Settings

logger = logging.getLogger(__name__)


class QdrantStore:
	def __init__(self, settings: Settings, *, client: QdrantClient | None = None) -> None:
		self.settings = settings
		self.client = client or QdrantClient(
			url=settings.qdrant_url,
			timeout=settings.qdrant_timeout_s,
			check_compatibility=False,
		)
		self.collection = settings.qdrant_collection
		self._ensure_collection()

	def _ensure_collection(self) -> None:
		names = {item.name for item in self.client.get_collections().collections}
		if self.collection in names:
			return
		self.client.create_collection(
			collection_name=self.collection,
			vectors_config=qm.VectorParams(
				size=self.settings.embedding_dim,
				distance=qm.Distance.COSINE,
			),
		)
		logger.info(
			"qdrant.collection.create collection=%s dim=%s",
			self.collection,
			self.settings.embedding_dim,
		)

	def upsert_chunks(
		self,
		*,
		library_id: str,
		doc_id: str,
		title: str,
		chunks: list[dict[str, Any]],
		vectors: list[list[float]],
	) -> int:
		if len(chunks) != len(vectors):
			raise ValueError("chunks and vectors length mismatch")

		points: list[qm.PointStruct] = []
		for chunk, vector in zip(chunks, vectors, strict=True):
			payload: dict[str, Any] = {
				"library_id": library_id,
				"doc_id": doc_id,
				"title": title,
				"chunk_index": int(chunk["chunk_index"]),
				"text": chunk["text"],
			}
			if chunk.get("page") is not None:
				payload["page"] = chunk["page"]
			points.append(
				qm.PointStruct(
					id=str(uuid4()),
					vector=vector,
					payload=payload,
				)
			)
		if points:
			self.client.upsert(collection_name=self.collection, points=points)
		logger.info(
			"qdrant.upsert library_id=%s doc_id=%s points=%s",
			library_id,
			doc_id,
			len(points),
		)
		return len(points)

	def search(
		self,
		*,
		vector: list[float],
		library_id: str | None,
		top_k: int,
	) -> list[dict[str, Any]]:
		query_filter = None
		if library_id:
			query_filter = qm.Filter(
				must=[
					qm.FieldCondition(
						key="library_id",
						match=qm.MatchValue(value=library_id),
					)
				]
			)
		# Prefer query_points (newer client); fall back to search.
		try:
			response = self.client.query_points(
				collection_name=self.collection,
				query=vector,
				query_filter=query_filter,
				limit=top_k,
				with_payload=True,
			)
			points = response.points
		except AttributeError:
			points = self.client.search(
				collection_name=self.collection,
				query_vector=vector,
				query_filter=query_filter,
				limit=top_k,
				with_payload=True,
			)

		hits: list[dict[str, Any]] = []
		for point in points:
			payload = dict(point.payload or {})
			score = float(getattr(point, "score", 0.0) or 0.0)
			# Cosine similarity may be slightly outside [0, 1]; clamp for API schema.
			score = max(0.0, min(1.0, score))
			hits.append(
				{
					"id": str(point.id),
					"score": score,
					"title": str(payload.get("title") or "未命名文档"),
					"page": str(payload["page"]) if payload.get("page") is not None else None,
					"snippet": str(payload.get("text") or "")[:280],
					"library_id": payload.get("library_id"),
					"doc_id": payload.get("doc_id"),
					"chunk_index": payload.get("chunk_index"),
					"text": str(payload.get("text") or ""),
				}
			)
		return hits


def probe_qdrant(settings: Settings) -> bool:
	try:
		client = QdrantClient(
			url=settings.qdrant_url,
			timeout=settings.qdrant_timeout_s,
			check_compatibility=False,
		)
		client.get_collections()
		return True
	except Exception:
		logger.debug("qdrant.probe.failed url=%s", settings.qdrant_url, exc_info=True)
		return False
