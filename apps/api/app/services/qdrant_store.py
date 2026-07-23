from __future__ import annotations

import logging
from typing import Any
from uuid import uuid4

from qdrant_client import QdrantClient
from qdrant_client.http import models as qm

from app.security.access_scope import AclScope, AccessScope, resolve_access_scope
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
		access_scope: AccessScope | None = None,
		acl_scope: AclScope = "workspace",
		allowed_principal_ids: tuple[str, ...] = (),
		allowed_group_ids: tuple[str, ...] = (),
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
			"chunk_policy_version",
			"chunk_profile",
			"split_reason",
			"target_chars",
			"max_chars",
			"table_rows_per_record",
			"table_tokens_per_record",
			"semantic_distance_threshold",
			"semantic_unit_count",
			"semantic_fallback",
			"source_format",
			"content_hash",
			"document_version_id",
				"tenant_id",
				"workspace_id",
				"acl_scope",
				"acl_principal_ids",
				"acl_group_ids",
			"record_type",
			"record_id",
			"parent_record_id",
			"source_chunk_ids",
			"source_node_ids",
			"headers",
			"rows",
			"row_start",
			"row_end",
			"table_row_count",
			"table_caption",
			"table_quality",
			"summary_rows",
			"footnotes",
			"header_rows",
			"table_columns",
			"cell_rows",
		)
		from app.services.versioning import derive_document_version_id

		scope = resolve_access_scope(self.settings, access_scope)
		for chunk, vector in zip(chunks, vectors, strict=True):
			payload: dict[str, Any] = {
				"library_id": library_id,
				"doc_id": doc_id,
				"title": title,
				"chunk_index": int(chunk["chunk_index"]),
				# text = body（展示/BM25）；向量在 ingest 侧用 embed_text 生成
				"text": chunk.get("body") or chunk["text"],
				**scope.payload(
					acl_scope=acl_scope,
					allowed_principal_ids=allowed_principal_ids,
					allowed_group_ids=allowed_group_ids,
				),
			}
			for key in _optional_keys:
				if chunk.get(key) is not None:
					payload[key] = chunk[key]
			# Request scope is authoritative; parser/chunk payload may not override it.
			payload.update(
				scope.payload(
					acl_scope=acl_scope,
					allowed_principal_ids=allowed_principal_ids,
					allowed_group_ids=allowed_group_ids,
				)
			)
			# 无完整 version 表时保留派生版本 stub。
			if not payload.get("document_version_id"):
				payload["document_version_id"] = derive_document_version_id(
					doc_id,
					content_hash=str(chunk.get("content_hash") or "") or None,
				)
			# 缺省视为 chunk，兼容旧点
			if not payload.get("record_type"):
				payload["record_type"] = "chunk"
			resolved_filename = chunk.get("filename") or filename
			if resolved_filename:
				payload["filename"] = resolved_filename
			point_id = chunk.get("_point_id") or str(uuid4())
			points.append(
				qm.PointStruct(
					id=point_id,
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

	def delete_by_doc_id(
		self,
		*,
		doc_id: str,
		library_id: str | None = None,
		access_scope: AccessScope | None = None,
	) -> None:
		"""删除某文档在 collection 中的全部向量点（覆盖重传 / 删文档前调用）。"""
		scope = resolve_access_scope(self.settings, access_scope)
		must: list[qm.Condition] = [
			*scope.qdrant_conditions()[:2],
			qm.FieldCondition(key="doc_id", match=qm.MatchValue(value=doc_id)),
		]
		if library_id:
			must.append(
				qm.FieldCondition(
					key="library_id",
					match=qm.MatchValue(value=library_id),
				)
			)
		self.client.delete(
			collection_name=self.collection,
			points_selector=qm.FilterSelector(filter=qm.Filter(must=must)),
		)
		logger.info(
			"qdrant.delete_by_doc_id library_id=%s doc_id=%s",
			library_id,
			doc_id,
		)

	def search(
		self,
		*,
		vector: list[float],
		library_id: str | None,
		top_k: int,
		record_type: str | None = None,
		extra_must: list[qm.Condition] | None = None,
		access_scope: AccessScope | None = None,
	) -> list[dict[str, Any]]:
		scope = resolve_access_scope(self.settings, access_scope)
		must: list[qm.Condition] = list(scope.qdrant_conditions())
		if library_id:
			must.append(
				qm.FieldCondition(
					key="library_id",
					match=qm.MatchValue(value=library_id),
				)
			)
		# fact：只要 chunk；兼容旧点（无 record_type）
		if record_type == "chunk":
			must.append(
				qm.Filter(
					should=[
						qm.FieldCondition(
							key="record_type",
							match=qm.MatchValue(value="chunk"),
						),
						qm.IsNullCondition(is_null=qm.PayloadField(key="record_type")),
					]
				)
			)
		elif record_type:
			must.append(
				qm.FieldCondition(
					key="record_type",
					match=qm.MatchValue(value=record_type),
				)
			)
		if extra_must:
			must.extend(extra_must)
		query_filter = qm.Filter(must=must) if must else None
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
			score = float(getattr(point, "score", 0.0) or 0.0)
			hits.append(self._payload_to_hit(point, score=score))
		return hits

	def _payload_to_hit(self, point: Any, *, score: float = 0.0) -> dict[str, Any]:
		payload = dict(getattr(point, "payload", None) or {})
		body = str(payload.get("body") or payload.get("text") or "")
		clamped = max(0.0, min(1.0, float(score)))
		return {
			"id": str(point.id),
			"score": clamped,
			"title": str(payload.get("title") or "未命名文档"),
			"page": str(payload["page"]) if payload.get("page") is not None else None,
			"page_start": payload.get("page_start"),
			"page_end": payload.get("page_end"),
			"section_path": payload.get("section_path"),
			"preamble": payload.get("preamble"),
			"table_id": payload.get("table_id"),
			"headers": payload.get("headers") or [],
			"rows": payload.get("rows") or [],
			"row_start": payload.get("row_start"),
			"row_end": payload.get("row_end"),
			"table_row_count": payload.get("table_row_count"),
			"table_caption": payload.get("table_caption"),
			"table_quality": payload.get("table_quality") or {},
			"summary_rows": payload.get("summary_rows") or [],
			"footnotes": payload.get("footnotes") or [],
			"header_rows": payload.get("header_rows") or [],
			"table_columns": payload.get("table_columns") or [],
			"cell_rows": payload.get("cell_rows") or [],
			"snippet": body[:280],
			"library_id": payload.get("library_id"),
			"doc_id": payload.get("doc_id"),
			"chunk_index": payload.get("chunk_index"),
			"filename": payload.get("filename"),
			"document_version_id": payload.get("document_version_id"),
				"tenant_id": payload.get("tenant_id"),
				"workspace_id": payload.get("workspace_id"),
				"acl_scope": payload.get("acl_scope"),
			"record_type": payload.get("record_type") or "chunk",
			"record_id": payload.get("record_id"),
			"source_chunk_ids": payload.get("source_chunk_ids") or [],
			"source_node_ids": payload.get("source_node_ids") or [],
			"text": body,
			"body": body,
		}

	def scroll_table_groups(
		self,
		*,
		doc_id: str,
		table_id: str,
		document_version_id: str | None = None,
		library_id: str | None = None,
		access_scope: AccessScope | None = None,
		limit: int = 10_000,
	) -> list[dict[str, Any]]:
		"""按表实例键拉取全部 table 行组（非向量 top_k），供全表聚合。"""
		scope = resolve_access_scope(self.settings, access_scope)
		must: list[qm.Condition] = [
			*scope.qdrant_conditions(),
			qm.FieldCondition(key="record_type", match=qm.MatchValue(value="table")),
			qm.FieldCondition(key="doc_id", match=qm.MatchValue(value=doc_id)),
			qm.FieldCondition(key="table_id", match=qm.MatchValue(value=table_id)),
		]
		if document_version_id:
			must.append(
				qm.FieldCondition(
					key="document_version_id",
					match=qm.MatchValue(value=document_version_id),
				)
			)
		if library_id:
			must.append(
				qm.FieldCondition(
					key="library_id",
					match=qm.MatchValue(value=library_id),
				)
			)
		query_filter = qm.Filter(must=must)
		hits: list[dict[str, Any]] = []
		offset = None
		while len(hits) < limit:
			points, offset = self.client.scroll(
				collection_name=self.collection,
				scroll_filter=query_filter,
				limit=min(256, limit - len(hits)),
				offset=offset,
				with_payload=True,
				with_vectors=False,
			)
			for point in points:
				hits.append(self._payload_to_hit(point, score=0.0))
			if offset is None:
				break
		hits.sort(
			key=lambda h: (
				int(h["row_start"]) if h.get("row_start") is not None else 10**9,
				int(h["row_end"]) if h.get("row_end") is not None else 10**9,
			)
		)
		return hits

	def list_chunks(
		self,
		*,
		library_id: str | None = None,
		limit: int = 10_000,
		record_type: str | None = "chunk",
		access_scope: AccessScope | None = None,
	) -> list[dict[str, Any]]:
		"""Scroll payload chunks for BM25 corpus building（默认仅 chunk 粒度）。"""
		scope = resolve_access_scope(self.settings, access_scope)
		must: list[qm.Condition] = list(scope.qdrant_conditions())
		if library_id:
			must.append(
				qm.FieldCondition(
					key="library_id",
					match=qm.MatchValue(value=library_id),
				)
			)
		if record_type == "chunk":
			must.append(
				qm.Filter(
					should=[
						qm.FieldCondition(
							key="record_type",
							match=qm.MatchValue(value="chunk"),
						),
						qm.IsNullCondition(is_null=qm.PayloadField(key="record_type")),
					]
				)
			)
		elif record_type:
			must.append(
				qm.FieldCondition(
					key="record_type",
					match=qm.MatchValue(value=record_type),
				)
			)
		query_filter = qm.Filter(must=must) if must else None
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
						"document_version_id": payload.get("document_version_id"),
							"tenant_id": payload.get("tenant_id"),
							"workspace_id": payload.get("workspace_id"),
							"acl_scope": payload.get("acl_scope"),
						"record_type": payload.get("record_type") or "chunk",
						"record_id": payload.get("record_id"),
						"source_chunk_ids": payload.get("source_chunk_ids") or [],
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
