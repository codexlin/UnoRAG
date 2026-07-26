from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any
from uuid import uuid4

from qdrant_client.http import models as qm

from app.services.chunking import chunk_text
from app.services.documents import infer_page_label
from app.services.hybrid import fuse_dense_and_bm25, get_bm25_cache
from app.security.access_scope import AccessScope, resolve_access_scope
from app.services.active_generations import (
	ActiveGenerationResolver,
	ActiveGenerationResolverProtocol,
	ActiveGenerationSnapshot,
)
from app.services.ingest.ir import Chunk as IRChunk
from app.services.ingest.pipeline import chunks_to_payloads
from app.services.llm import EmbeddingService
from app.services.qdrant_store import QdrantStore
from app.services.ask_defaults import ASK_DEFAULTS
from app.services.rerank import RerankClient
from app.services.retrieval_plan_contract import EXECUTABLE_PLAN_FILTER_KEYS
from app.settings import Settings

logger = logging.getLogger(__name__)

# 除 record_type 外、由 filters dict 组装进 Qdrant must 的字段
_METADATA_FILTER_KEYS: tuple[str, ...] = ("doc_id", "table_id", "document_version_id")

# ask 双路伪类型：dense/hybrid 允许的真实 record_type 集合（缺省点视为 chunk）
_PSEUDO_RECORD_TYPE_ALLOWLIST: dict[str, frozenset[str]] = {
	"chunk+table_summary": frozenset({"chunk", "table_summary"}),
}


def _clamp_score(score: float) -> float:
	return max(0.0, min(1.0, float(score)))


def allowed_record_types_for_filter(record_type: str | None) -> frozenset[str] | None:
	"""计划 record_type → 命中允许集合；伪类型展开为多值。"""
	if record_type is None:
		return None
	text = str(record_type).strip()
	if not text:
		return None
	if text in _PSEUDO_RECORD_TYPE_ALLOWLIST:
		return _PSEUDO_RECORD_TYPE_ALLOWLIST[text]
	return frozenset({text})


def filters_to_extra_must(filters: dict[str, Any] | None) -> list[qm.Condition]:
	"""将结构化 RetrievalPlan 的可执行 metadata filter 转为 Qdrant must 条件。

	``record_type`` / ``library_id`` 仍由 ``QdrantStore.search`` 专用参数处理。
	"""
	if not filters:
		return []
	must: list[qm.Condition] = []
	for key in _METADATA_FILTER_KEYS:
		if key not in EXECUTABLE_PLAN_FILTER_KEYS:
			continue
		raw = filters.get(key)
		if raw is None:
			continue
		value = str(raw).strip()
		if not value:
			continue
		must.append(
			qm.FieldCondition(key=key, match=qm.MatchValue(value=value))
		)
	return must


def hit_matches_plan_filters(
	hit: dict[str, Any],
	filters: dict[str, Any] | None,
) -> bool:
	"""Hybrid/BM25 后置过滤：与 dense extra_must + record_type 语义对齐。"""
	if not filters:
		return True
	for key in _METADATA_FILTER_KEYS:
		want = filters.get(key)
		if want is None or not str(want).strip():
			continue
		if str(hit.get(key) or "").strip() != str(want).strip():
			return False
	want_rt = filters.get("record_type")
	if want_rt is not None and str(want_rt).strip():
		allowed = allowed_record_types_for_filter(str(want_rt).strip())
		hit_rt = str(hit.get("record_type") or "chunk").strip() or "chunk"
		if allowed is not None and hit_rt not in allowed:
			return False
	return True

class IngestService:
	def __init__(
		self,
		settings: Settings,
		*,
		embeddings: EmbeddingService | None = None,
		store: QdrantStore | None = None,
		access_scope: AccessScope | None = None,
	) -> None:
		self.settings = settings
		self._embeddings = embeddings
		self._store = store
		self.access_scope = resolve_access_scope(settings, access_scope)

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
		"""Legacy flat-text ingest（字窗）。新上传请走 ingest_prepared / prepare_ingest。"""
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
		# 同 doc_id 覆盖写入前先清旧点，避免重传叠向量
		self.delete_document_chunks(doc_id=resolved_doc_id, library_id=library_id)
		vectors = self.embeddings.embed_texts([piece.text for piece in pieces])
		count = self.store.upsert_chunks(
			library_id=library_id,
			doc_id=resolved_doc_id,
			title=title,
			chunks=chunks,
			vectors=vectors,
			filename=filename,
			access_scope=self.access_scope,
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

	def ingest_ir_chunks(
		self,
		*,
		library_id: str,
		title: str,
		chunks: list[IRChunk],
		doc_id: str | None = None,
		filename: str | None = None,
		parser_report: dict[str, Any] | None = None,
		document_version_id: str | None = None,
		generation_id: str | None = None,
		lifecycle_visibility: str | None = None,
		acl_scope: str = "workspace",
		allowed_principal_ids: tuple[str, ...] = (),
		allowed_group_ids: tuple[str, ...] = (),
		progress_callback: Callable[[str, int, int], None] | None = None,
	) -> dict[str, Any]:
		"""IR chunks → embed(preamble+body) → Qdrant；payload 含 section/page 新字段。"""
		resolved_doc_id = doc_id or str(uuid4())
		if not chunks:
			raise ValueError("no chunks to ingest")
		payloads = chunks_to_payloads(
			chunks,
			filename=filename,
			doc_id=resolved_doc_id,
			library_id=library_id,
			document_version_id=document_version_id,
			generation_id=generation_id,
			lifecycle_visibility=lifecycle_visibility,
			tenant_id=self.access_scope.tenant_id,
			workspace_id=self.access_scope.workspace_id,
		)
		embed_inputs = [str(item.get("embed_text") or item.get("text") or "") for item in payloads]
		if progress_callback is not None:
			progress_callback("embedding", 0, len(embed_inputs))
		vectors = self.embeddings.embed_texts(embed_inputs)
		if progress_callback is not None:
			progress_callback("indexing", len(vectors), len(embed_inputs))
		if generation_id:
			self.store.delete_by_generation(
				generation_id=generation_id,
				access_scope=self.access_scope,
			)
		else:
			self.delete_document_chunks(doc_id=resolved_doc_id, library_id=library_id)
		count = self.store.upsert_chunks(
			library_id=library_id,
			doc_id=resolved_doc_id,
			title=title,
			chunks=payloads,
			vectors=vectors,
			filename=filename,
			access_scope=self.access_scope,
			acl_scope=acl_scope,  # type: ignore[arg-type]
			allowed_principal_ids=allowed_principal_ids,
			allowed_group_ids=allowed_group_ids,
		)
		chunk_only = sum(1 for item in payloads if item.get("record_type", "chunk") == "chunk")
		section_only = sum(1 for item in payloads if item.get("record_type") == "section")
		table_only = sum(1 for item in payloads if item.get("record_type") == "table")
		get_bm25_cache().invalidate(library_id)
		logger.info(
			"ingest.ir.done library_id=%s doc_id=%s points=%s chunks=%s sections=%s tables=%s",
			library_id,
			resolved_doc_id,
			count,
			chunk_only,
			section_only,
			table_only,
		)
		result: dict[str, Any] = {
			"library_id": library_id,
			"doc_id": resolved_doc_id,
			"title": title,
			"chunk_count": chunk_only,
			"section_count": section_only,
			"table_count": table_only,
			"point_count": count,
		}
		if document_version_id:
			result["document_version_id"] = document_version_id
		if generation_id:
			result["generation_id"] = generation_id
			result["visibility"] = lifecycle_visibility or "staging"
		if parser_report is not None:
			result["parser_report"] = parser_report
		return result

	def delete_document_chunks(self, *, doc_id: str, library_id: str | None = None) -> None:
		"""按文档清除向量；删元数据或同名覆盖上传前调用。"""
		try:
			self.store.delete_by_doc_id(
				doc_id=doc_id,
				library_id=library_id,
				access_scope=self.access_scope,
			)
		except Exception:
			logger.exception(
				"ingest.delete_chunks_failed doc_id=%s library_id=%s",
				doc_id,
				library_id,
			)
			raise
		if library_id:
			get_bm25_cache().invalidate(library_id)

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
		access_scope: AccessScope | None = None,
		active_generation_resolver: ActiveGenerationResolverProtocol | None = None,
	) -> None:
		self.settings = settings
		self.embeddings = embeddings or EmbeddingService(settings)
		self.store = store or QdrantStore(settings)
		self.access_scope = resolve_access_scope(settings, access_scope)
		self.active_generation_resolver = active_generation_resolver
		if (
			self.active_generation_resolver is None
			and settings.active_generation_gate_enabled
		):
			self.active_generation_resolver = ActiveGenerationResolver(settings)
		if reranker is not None:
			self.reranker = reranker
		elif (
			bool(getattr(settings, "rerank_enabled", ASK_DEFAULTS.rerank_enabled))
			and settings.has_llm_key
		):
			self.reranker = RerankClient(settings)
		else:
			self.reranker = None
		self.last_debug: dict[str, Any] = {}

	def search(
		self,
		*,
		query: str,
		library_id: str | None,
		top_k: int | None = None,
		record_type: str | None = "chunk",
		filters: dict[str, Any] | None = None,
	) -> list[dict[str, Any]]:
		if not library_id or not str(library_id).strip():
			raise ValueError("library_id is required for retrieval")
		resolved_library = str(library_id).strip()
		active_snapshot = self._resolve_active_generations(resolved_library)
		limit = top_k or int(
			getattr(self.settings, "retrieve_top_k", ASK_DEFAULTS.retrieve_top_k)
		)
		# Pull a slightly wider dense pool when rerank / hybrid will trim.
		dense_k = max(limit, self.settings.rerank_top_k, self.settings.bm25_top_k)
		resolved_type = None
		if filters and filters.get("record_type"):
			resolved_type = str(filters["record_type"])
		elif record_type:
			resolved_type = str(record_type)
		# chunk+table_summary：store 侧 MatchAny(chunk|table_summary)；勿降成无过滤
		store_record_type = resolved_type
		allowed_types = allowed_record_types_for_filter(resolved_type)
		extra_must = filters_to_extra_must(filters)
		vector = self.embeddings.embed_query(query)
		dense_hits = self.store.search(
			vector=vector,
			library_id=resolved_library,
			top_k=dense_k,
			record_type=store_record_type,
			extra_must=extra_must or None,
			access_scope=self.access_scope,
			active_generation_ids=(
				active_snapshot.generation_ids if active_snapshot is not None else None
			),
		)
		hits = dense_hits
		used_hybrid = False
		hybrid_error: str | None = None
		hybrid_on = bool(
			getattr(self.settings, "hybrid_enabled", ASK_DEFAULTS.hybrid_enabled)
		)

		if hybrid_on:
			try:
				hits = self._hybrid_fuse(
					query=query,
					library_id=resolved_library,
					dense_hits=dense_hits,
					limit=dense_k,
					record_type=store_record_type or "chunk",
					active_snapshot=active_snapshot,
				)
				used_hybrid = True
			except Exception as exc:
				hybrid_error = str(exc)
				logger.exception(
					"retrieval.hybrid_failed fallback=dense library_id=%s",
					resolved_library,
				)
				hits = dense_hits

		# BM25 语料可能未带全量 filter；融合后按计划 metadata + record_type 收紧
		if filters:
			hits = [hit for hit in hits if hit_matches_plan_filters(hit, filters)]

		citations: list[dict[str, Any]] = []
		for index, hit in enumerate(hits, start=1):
			score = float(hit.get("score") or 0.0)
			# RRF scores are small; keep relative ordering but clamp for schema.
			if used_hybrid and hit.get("rrf_score") is not None:
				score = _clamp_score(float(hit["rrf_score"]) * 10.0)
			else:
				score = _clamp_score(score)
			# UI/LLM 优先 body；旧 payload 无 body 时回退 text
			body = str(hit.get("body") or hit.get("text") or hit.get("snippet") or "")
			hit_record_type = hit.get("record_type")
			if not hit_record_type:
				# 伪类型缺省视为 chunk，避免把 citation 标成 chunk+table_summary
				hit_record_type = (
					"chunk"
					if resolved_type == "chunk+table_summary"
					else (resolved_type or "chunk")
				)
			citations.append(
				{
					"id": hit["id"],
					"index": index,
					"title": hit["title"],
					"page": hit.get("page"),
					"page_start": hit.get("page_start"),
					"page_end": hit.get("page_end"),
					"section_path": hit.get("section_path"),
					"preamble": hit.get("preamble"),
					"table_id": hit.get("table_id"),
					"headers": hit.get("headers") or [],
					"rows": hit.get("rows") or [],
					"row_start": hit.get("row_start"),
					"row_end": hit.get("row_end"),
					"table_row_count": hit.get("table_row_count"),
					"snippet": hit.get("snippet") or body[:280],
					"score": score,
					"dense_score": hit.get("dense_score", hit.get("score")),
					"bm25_score": hit.get("bm25_score"),
					"rrf_score": hit.get("rrf_score"),
					"text": body,
					"body": body,
					"doc_id": hit.get("doc_id"),
					"chunk_index": hit.get("chunk_index"),
					"filename": hit.get("filename"),
					"document_version_id": hit.get("document_version_id"),
					"generation_id": hit.get("generation_id"),
					"tenant_id": hit.get("tenant_id"),
					"record_type": hit_record_type,
					"record_id": hit.get("record_id"),
					"source_chunk_ids": hit.get("source_chunk_ids") or [],
					"source_node_ids": hit.get("source_node_ids") or [],
				}
			)
		final = self._maybe_rerank(query=query, citations=citations, top_k=limit)
		rerank_failed = any(bool(item.get("rerank_error")) for item in final)
		used_rerank = any(bool(item.get("used_rerank")) for item in final)
		retrieval_mode = "hybrid" if used_hybrid else "dense"
		self.last_debug = {
			"used_hybrid": used_hybrid,
			"hybrid_enabled": hybrid_on,
			"hybrid_error": hybrid_error,
			"hybrid_failed": hybrid_error is not None,
			"rerank_failed": rerank_failed,
			"used_rerank": used_rerank,
			"retrieval_mode": retrieval_mode,
			"dense_hit_count": len(dense_hits),
			"fusion": "rrf" if used_hybrid else "dense",
			"rrf_k": self.settings.rrf_k if used_hybrid else None,
			"record_type": resolved_type,
			"allowed_record_types": (
				sorted(allowed_types) if allowed_types is not None else None
			),
			"filters": dict(filters or {}),
			"extra_must_keys": [
				key
				for key in _METADATA_FILTER_KEYS
				if filters and filters.get(key)
			],
			"active_generation_gate": active_snapshot is not None,
			"active_generation_count": (
				len(active_snapshot.generation_ids)
				if active_snapshot is not None
				else None
			),
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
		record_type: str = "chunk",
		active_snapshot: ActiveGenerationSnapshot | None = None,
	) -> list[dict[str, Any]]:
		cache = get_bm25_cache()
		index = cache.get_or_build(
				(
					f"{self.access_scope.cache_key()}:{library_id}:{record_type}:"
					f"{active_snapshot.cache_key if active_snapshot else 'ungated'}"
				),
				lambda: self.store.list_chunks(
					library_id=library_id,
					record_type=record_type,
					access_scope=self.access_scope,
					active_generation_ids=(
						active_snapshot.generation_ids
						if active_snapshot is not None
						else None
					),
				),
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
			raw_dense = item.get("dense_score")
			if raw_dense is None:
				raw_dense = item.get("score")
			item["dense_score"] = float(raw_dense or 0.0)
			item["score"] = _clamp_score(rerank_score)
			item["used_rerank"] = True
			reranked.append(item)

		final = (reranked or citations)[:top_k]
		for index, item in enumerate(final, start=1):
			item["index"] = index
			item.setdefault("used_rerank", bool(reranked))
		return final

	def load_table_groups(
		self,
		*,
		doc_id: str,
		table_id: str,
		document_version_id: str | None = None,
		library_id: str | None = None,
	) -> list[dict[str, Any]]:
		"""按表实例键从 Qdrant 拉取全部行组（全表聚合用，不受 retrieve top_k 限制）。"""
		if self.active_generation_resolver is not None and not library_id:
			raise ValueError("library_id is required by active generation gate")
		active_snapshot = (
			self._resolve_active_generations(library_id)
			if library_id
			else None
		)
		return self.store.scroll_table_groups(
			doc_id=doc_id,
			table_id=table_id,
			document_version_id=document_version_id,
			library_id=library_id,
			access_scope=self.access_scope,
			active_generation_ids=(
				active_snapshot.generation_ids if active_snapshot is not None else None
			),
		)

	def list_chunks(
		self,
		*,
		library_id: str,
		record_type: str | None = "chunk",
		limit: int = 10_000,
	) -> list[dict[str, Any]]:
		active_snapshot = self._resolve_active_generations(library_id)
		return self.store.list_chunks(
			library_id=library_id,
			limit=limit,
			record_type=record_type,
			access_scope=self.access_scope,
			active_generation_ids=(
				active_snapshot.generation_ids if active_snapshot is not None else None
			),
		)

	def _resolve_active_generations(
		self,
		library_id: str,
	) -> ActiveGenerationSnapshot | None:
		if self.active_generation_resolver is None:
			return None
		return self.active_generation_resolver.resolve(
			scope=self.access_scope,
			library_id=library_id,
		)
