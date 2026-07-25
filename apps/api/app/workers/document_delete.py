"""Async document.delete cleanup: Qdrant, objects, RAG metadata, tombstone."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol

from app.repositories.job_repository import (
	DocumentDeleteContext,
	JobLease,
	JobRepository,
	JobStage,
	LostJobLeaseError,
)
from app.security.access_scope import AccessScope
from app.services.hybrid import get_bm25_cache
from app.services.metadata import get_metadata_store
from app.services.qdrant_store import QdrantStore
from app.services.retrieval import IngestService
from app.services.source_object_storage import LocalSourceObjectStorage
from app.settings import Settings

logger = logging.getLogger(__name__)


class ProgressReporter(Protocol):
	def checkpoint(
		self,
		stage: JobStage,
		progress: int,
		*,
		current: int | None = None,
		total: int | None = None,
	) -> None: ...


@dataclass(frozen=True)
class DeleteProcessResult:
	job_id: str
	document_id: str
	rag_document_id: str
	library_finalized: bool
	storage_deleted: int
	generations_deleted: int


class DocumentDeleteProcessor:
	def __init__(
		self,
		settings: Settings,
		repository: JobRepository,
		*,
		storage: LocalSourceObjectStorage | None = None,
		qdrant_store_factory=None,
		metadata_store_factory=None,
		ingest_service_factory=None,
	) -> None:
		self.settings = settings
		self.repository = repository
		root = settings.resolved_document_storage
		self.storage = storage or LocalSourceObjectStorage(
			root,
			max_bytes=settings.max_upload_bytes,
		)
		self._qdrant_store_factory = qdrant_store_factory or (
			lambda: QdrantStore(settings)
		)
		self._metadata_store_factory = metadata_store_factory or (
			lambda: get_metadata_store(settings)
		)
		self._ingest_service_factory = ingest_service_factory or (
			lambda scope: IngestService(settings, access_scope=scope)
		)

	def process(
		self,
		lease: JobLease,
		progress: ProgressReporter,
	) -> DeleteProcessResult:
		context = self.repository.load_document_delete_context(lease)
		scope = AccessScope(
			tenant_id=str(context.organization_id),
			workspace_id=str(context.workspace_id),
			principal_id=str(context.principal_id or context.organization_id),
		)
		try:
			progress.checkpoint(JobStage.CLEANUP, 10)
			store = self._qdrant_store_factory()
			generations_deleted = 0
			for generation_id in context.generation_ids:
				try:
					store.delete_by_generation(
						generation_id=str(generation_id),
						access_scope=scope,
					)
					generations_deleted += 1
				except Exception:
					logger.warning(
						"document_delete.generation_cleanup_failed generation_id=%s",
						generation_id,
						exc_info=True,
					)
					raise
			progress.checkpoint(JobStage.CLEANUP, 40)
			try:
				self._ingest_service_factory(scope).delete_document_chunks(
					doc_id=context.rag_document_id,
					library_id=context.rag_library_id,
				)
			except Exception:
				# Prefer generation deletes; fallback by doc_id is best-effort.
				logger.warning(
					"document_delete.doc_chunks_failed doc_id=%s",
					context.rag_document_id,
					exc_info=True,
				)
				store.delete_by_doc_id(
					doc_id=context.rag_document_id,
					library_id=context.rag_library_id,
					access_scope=scope,
				)

			progress.checkpoint(JobStage.CLEANUP, 60)
			storage_deleted = 0
			for key in context.storage_keys:
				try:
					self.storage.delete(key)
					storage_deleted += 1
				except Exception:
					logger.warning(
						"document_delete.storage_failed key=%s",
						key,
						exc_info=True,
					)
					raise

			progress.checkpoint(JobStage.CLEANUP, 80)
			try:
				self._metadata_store_factory().delete_document(
					context.rag_document_id,
					scope=scope,
				)
			except Exception:
				logger.warning(
					"document_delete.metadata_failed doc_id=%s",
					context.rag_document_id,
					exc_info=True,
				)
				raise

			get_bm25_cache().invalidate(context.rag_library_id)
			progress.checkpoint(JobStage.CLEANUP, 95)
			completion = self.repository.complete_document_delete(
				lease,
				context,
				result={
					"storage_deleted": storage_deleted,
					"generations_deleted": generations_deleted,
				},
			)
			logger.info(
				"document_delete.completed job_id=%s document_id=%s "
				"library_finalized=%s",
				lease.id,
				context.document_id,
				completion.library_finalized,
			)
			return DeleteProcessResult(
				job_id=str(lease.id),
				document_id=str(context.document_id),
				rag_document_id=context.rag_document_id,
				library_finalized=completion.library_finalized,
				storage_deleted=storage_deleted,
				generations_deleted=generations_deleted,
			)
		except LostJobLeaseError:
			raise
		except Exception as exc:
			retryable = not isinstance(exc, (ValueError, TypeError))
			self.repository.fail_leased_job(
				lease,
				error_code="document_delete_failed",
				error=str(exc) or exc.__class__.__name__,
				retryable=retryable,
			)
			raise
