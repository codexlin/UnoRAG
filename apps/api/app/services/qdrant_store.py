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
		filename: str | None = None,
	) -> int:
		if len(chunks) != len(vectors):
			raise ValueError("chunks and vectors length mismatch")

		points: list[qm.PointStruct] = []
		# 可选 payload 字段：旧客户端忽略即可（向后兼容）
		_optional_keys = (
			"body",
			"preamble",
			"section_path",
			"heading_text",
			"page",
			"page_start",
			"page_end",
			"table_id",
			"figure_id",
			"node_ids",
			"split_strategy",
			"source_format",
			"content_hash",
		)
		for chunk, vector in zip(chunks, vectors, strict=True):
			payload: dict[str, Any] = {
				"library_id": library_id,
				"doc_id": doc_id,
				"title": title,
				"chunk_index": int(chunk["chunk_index"]),
				# text = body（展示/BM25）；向量在 ingest 侧用 embed_text 生成
				"text": chunk.get("body") or chunk["text"],
			}
			for key in _optional_keys:
				if chunk.get(key) is not None:
					payload[key] = chunk[key]
			resolved_filename = chunk.get("filename") or filename
			if resolved_filename:
				payload["filename"] = resolved_filename
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
			body = str(payload.get("body") or payload.get("text") or "")
			hits.append(
				{
					"id": str(point.id),
					"score": score,
					"title": str(payload.get("title") or "未命名文档"),
					"page": str(payload["page"]) if payload.get("page") is not None else None,
					"page_start": payload.get("page_start"),
					"page_end": payload.get("page_end"),
					"section_path": payload.get("section_path"),
					"preamble": payload.get("preamble"),
					"table_id": payload.get("table_id"),
					"snippet": body[:280],
					"library_id": payload.get("library_id"),
					"doc_id": payload.get("doc_id"),
					"chunk_index": payload.get("chunk_index"),
					"filename": payload.get("filename"),
					"text": body,
					"body": body,
				}
			)
		return hits

	def list_chunks(
		self,
		*,
		library_id: str | None = None,
		limit: int = 10_000,
	) -> list[dict[str, Any]]:
		"""Scroll payload chunks for BM25 corpus building."""
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
		chunks: list[dict[str, Any]] = []
		offset = None
		while len(chunks) < limit:
			points, offset = self.client.scroll(
				collection_name=self.collection,
				scroll_filter=query_filter,
				limit=min(256, limit - len(chunks)),
				offset=offset,
				with_payload=True,
				with_vectors=False,
			)
			for point in points:
				payload = dict(point.payload or {})
				doc_id = payload.get("doc_id")
				chunk_index = payload.get("chunk_index")
				if doc_id is None or chunk_index is None:
					continue
				body = str(payload.get("body") or payload.get("text") or "")
				chunks.append(
					{
						"id": str(point.id),
						"doc_id": str(doc_id),
						"chunk_index": int(chunk_index),
						"title": str(payload.get("title") or "未命名文档"),
						"page": str(payload["page"]) if payload.get("page") is not None else None,
						"page_start": payload.get("page_start"),
						"page_end": payload.get("page_end"),
						"section_path": payload.get("section_path"),
						"table_id": payload.get("table_id"),
						"text": body,
						"body": body,
						"snippet": body[:280],
						"library_id": payload.get("library_id"),
					}
				)
			if offset is None:
				break
		return chunks


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
