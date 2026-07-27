from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol

from app.repositories.job_repository import (
	ActivationResult,
	CancelRequestedError,
	DocumentIngestContext,
	JobLease,
	JobRepository,
	JobStage,
	LostJobLeaseError,
	StaleDocumentVersionError,
)
from app.security.access_scope import AccessScope
from app.services.hybrid import get_bm25_cache
from app.services.ingest.backends.mineru import MinerUClientError, MinerUPendingError
from app.services.ingest.backends.mineru_observability import redact_provider_task_id
from app.services.ingest.pipeline import prepare_ingest
from app.services.ingest.queue_class import resolve_queue_class_after_probe
from app.services.policy_profiles import resolve_document_policy
from app.services.qdrant_store import QdrantStore
from app.services.retrieval import IngestService
from app.services.source_object_storage import (
	LocalSourceObjectStorage,
	SourceObjectError,
)
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
class ProcessResult:
	job_id: str
	document_version_id: str
	generation_id: str
	point_count: int
	activated: bool
	superseded: bool


class DocumentIngestProcessor:
	def __init__(
		self,
		settings: Settings,
		repository: JobRepository,
		*,
		storage: LocalSourceObjectStorage | None = None,
		ingest_service_factory=None,
		qdrant_store_factory=None,
	) -> None:
		self.settings = settings
		self.repository = repository
		self.storage = storage or LocalSourceObjectStorage(
			settings.document_storage_root,
			max_bytes=settings.max_upload_bytes,
		)
		self._ingest_service_factory = ingest_service_factory or (
			lambda scope: IngestService(settings, access_scope=scope)
		)
		self._qdrant_store_factory = qdrant_store_factory or (
			lambda: QdrantStore(settings)
		)

	def process(
		self, lease: JobLease, progress: ProgressReporter
	) -> ProcessResult | None:
		"""Process ingest. Returns ``None`` when re-queued for a different slot class."""
		context = self.repository.load_document_ingest_context(lease)
		scope = self._access_scope(context)
		indexed = context.version_status in {"indexed", "activating"}
		point_count = int(context.point_count or 0)
		provider_state_local: dict[str, object] = dict(
			(lease.payload or {}).get("mineru_provider_state") or {}
		)
		try:
			store = None
			if indexed:
				store = self._qdrant_store_factory()
				actual_count = store.count_generation(
					generation_id=str(context.generation_id),
					access_scope=scope,
				)
				if point_count <= 0 or actual_count != point_count:
					indexed = False
			if not indexed:
				progress.checkpoint(JobStage.DOWNLOADING, 5)
				content = self.storage.read_bytes(
					context.storage_key,
					expected_hash=context.content_hash,
				)
				# Resolve the enqueue-time policy before queue routing. A strict
				# text-only document must not consume a MinerU slot.
				doc_policy = resolve_document_policy(
					document_profile=context.document_profile,
					scan_handling=context.scan_handling,
				)

				# Probe → mark queue_class; mineru jobs requeue onto mineru slot
				# so a running MinerU parse does not block local/docx claims.
				resolved_class = (
					resolve_queue_class_after_probe(
						filename=context.filename,
						content_type=context.content_type,
						content=content,
						mineru_enabled=bool(self.settings.mineru_enabled),
					)
					if doc_policy.enhanced_parser_allowed
					else "local"
				)
				current_class = str(
					(lease.payload or {}).get("queue_class") or "local"
				).strip().lower()
				if resolved_class == "mineru" and current_class != "mineru":
					logger.info(
						"document_ingest.requeue_mineru job_id=%s filename=%s",
						lease.id,
						context.filename,
					)
					self.repository.requeue_for_queue_class(
						job_id=lease.id,
						lease_token=lease.lease_token,
						queue_class="mineru",
					)
					return None
				if resolved_class != current_class:
					self.repository.patch_job_payload(
						job_id=lease.id,
						lease_token=lease.lease_token,
						patch={"queue_class": resolved_class},
					)

				self.repository.begin_document_ingest(lease, context)
				progress.checkpoint(JobStage.PARSING, 15)

				def check_parse_cancelled() -> None:
					if self.repository.cancellation_requested(lease):
						raise CancelRequestedError(
							f"job cancellation requested: {lease.id}"
						)

				def report_parse_progress(
					_phase: str,
					current: int | None,
					total: int | None,
				) -> None:
					parse_progress = 15
					if current is not None and total:
						parse_progress = min(
							34,
							15 + int(19 * current / total),
						)
					progress.checkpoint(
						JobStage.PARSING,
						parse_progress,
						current=current,
						total=total,
					)

				def persist_provider_state(state: dict[str, object]) -> None:
					provider_state_local.clear()
					provider_state_local.update(state)
					self.repository.patch_job_payload(
						job_id=lease.id,
						lease_token=lease.lease_token,
						patch={"mineru_provider_state": state},
					)

				provider_state_local.clear()
				provider_state_local.update(
					dict((lease.payload or {}).get("mineru_provider_state") or {})
				)
				prepared = prepare_ingest(
					settings=self.settings,
					filename=context.filename,
					content=content,
					library_id=context.rag_library_id,
					display_name=context.title,
					doc_id=context.rag_document_id,
					content_type=context.content_type,
					parser_progress_callback=report_parse_progress,
					cancel_check=check_parse_cancelled,
					chunking_profile=doc_policy.chunk_profile,
					semantic_enabled=doc_policy.semantic_enabled,
					ocr_enabled=doc_policy.ocr_enabled,
					enhanced_parser_allowed=doc_policy.enhanced_parser_allowed,
					provider_state=dict(provider_state_local),
					provider_state_callback=persist_provider_state,
					job_id=str(lease.id),
					trace_id=str(
						(lease.payload or {}).get("trace_id")
						or (lease.payload or {}).get("request_id")
						or ""
					)
					or None,
				)
				progress.checkpoint(
					JobStage.CHUNKING,
					35,
					current=len(prepared.chunks),
					total=len(prepared.chunks),
				)

				acl_scope = (
					"restricted"
					if context.allowed_principal_ids or context.allowed_group_ids
					else "workspace"
				)
				service = self._ingest_service_factory(scope)
				store = service.store

				def report_index_stage(stage: str, current: int, total: int) -> None:
					if stage == "embedding":
						progress.checkpoint(
							JobStage.EMBEDDING,
							45,
							current=current,
							total=total,
						)
					else:
						progress.checkpoint(
							JobStage.INDEXING,
							75,
							current=current,
							total=total,
						)

				report = prepared.parser_report.to_public_dict()
				report["ingest_policy"] = {
					"ingest_policy_version": int(
						context.ingest_policy_version or 1
					),
					"document_profile": doc_policy.document_profile,
					"scan_handling": doc_policy.scan_handling,
					"chunk_profile": doc_policy.chunk_profile,
				}
				result = service.ingest_ir_chunks(
					library_id=context.rag_library_id,
					title=prepared.title,
					chunks=prepared.chunks,
					doc_id=context.rag_document_id,
					filename=prepared.filename,
					parser_report=report,
					document_version_id=str(context.document_version_id),
					generation_id=str(context.generation_id),
					lifecycle_visibility="staging",
					acl_scope=acl_scope,
					allowed_principal_ids=tuple(
						str(value) for value in context.allowed_principal_ids
					),
					allowed_group_ids=tuple(
						str(value) for value in context.allowed_group_ids
					),
					progress_callback=report_index_stage,
				)
				progress.checkpoint(
					JobStage.VALIDATING,
					90,
					current=int(result["point_count"]),
					total=int(result["point_count"]),
				)
				actual_count = store.count_generation(
					generation_id=str(context.generation_id),
					access_scope=scope,
				)
				if actual_count != int(result["point_count"]):
					raise RuntimeError(
						f"generation validation mismatch: expected {result['point_count']}, "
						f"found {actual_count}"
					)
				point_count = actual_count
				progress.checkpoint(
					JobStage.AWAITING_ACTIVATION,
					94,
					current=actual_count,
					total=actual_count,
				)
				parser_backend = str(
					report.get("backend") or report.get("parser") or prepared.pipeline
				)
				self.repository.complete_indexing(
					lease,
					context,
					parser_backend=parser_backend,
					chunk_profile=doc_policy.chunk_profile,
					parser_report=report,
					point_count=actual_count,
					chunk_count=int(result["chunk_count"]),
					section_count=int(result["section_count"]),
					table_count=int(result["table_count"]),
				)
				# Deprecated library-level hint only; requires_reindex uses
				# per-version snapshots (do not treat this as "whole library applied").
				self.repository.mark_library_document_profile_applied(
					library_id=context.library_id,
					document_profile=doc_policy.document_profile,
				)
				indexed = True

			if store is None:
				raise RuntimeError("generation store was not initialized")
			activation = self._activate_generation(
				lease=lease,
				context=context,
				progress=progress,
				store=store,
				scope=scope,
			)
			return ProcessResult(
				job_id=str(lease.id),
				document_version_id=str(context.document_version_id),
				generation_id=str(context.generation_id),
				point_count=point_count,
				activated=activation.activated,
				superseded=activation.superseded,
			)
		except MinerUPendingError as exc:
			self.repository.defer_leased_job(
				job_id=lease.id,
				lease_token=lease.lease_token,
				delay_seconds=exc.retry_after_s,
			)
			logger.info(
				"document_ingest.mineru_pending job_id=%s document_id=%s "
				"provider_task_id=%s poll_count=%s wait_s=%s retry_after_s=%s",
				lease.id,
				context.rag_document_id,
				redact_provider_task_id(str(provider_state_local.get("task_id") or "")),
				provider_state_local.get("poll_count"),
				provider_state_local.get("wait_s"),
				exc.retry_after_s,
			)
			return None
		except CancelRequestedError:
			self._delete_staging_generation(context)
			self.repository.acknowledge_cancel(
				lease,
				context,
				result={"generation_id": str(context.generation_id)},
			)
			raise
		except LostJobLeaseError:
			raise
		except Exception as exc:
			if not indexed:
				self._delete_staging_generation(context)
			retryable, error_code = classify_ingest_error(exc)
			retry_delay = mineru_job_retry_delay_seconds(
				self.settings,
				error_code=error_code,
				attempt=lease.attempt,
			)
			timeout_kind = getattr(exc, "timeout_kind", None)
			logger.warning(
				"lifecycle_worker.ingest_failed job_id=%s error_code=%s "
				"retryable=%s timeout_kind=%s attempt=%s retry_delay_s=%s",
				lease.id,
				error_code,
				retryable,
				timeout_kind,
				lease.attempt,
				retry_delay,
			)
			self.repository.fail(
				lease,
				context,
				error_code=error_code,
				error=str(exc) or exc.__class__.__name__,
				retryable=retryable,
				retry_delay_seconds=retry_delay,
				parser_report=getattr(exc, "parser_report", None),
			)
			raise

	def _activate_generation(
		self,
		*,
		lease: JobLease,
		context: DocumentIngestContext,
		progress: ProgressReporter,
		store: QdrantStore,
		scope: AccessScope,
	) -> ActivationResult:
		progress.checkpoint(
			JobStage.ACTIVATING,
			96,
			current=int(context.point_count or 0) or None,
			total=int(context.point_count or 0) or None,
		)
		preparation = self.repository.prepare_activation(lease, context)
		if not preparation.should_activate:
			try:
				store.set_generation_visibility(
					generation_id=str(context.generation_id),
					visibility="inactive",
					access_scope=scope,
				)
			except Exception:
				logger.warning(
					"lifecycle_worker.superseded_hint_cleanup_failed generation_id=%s",
					context.generation_id,
					exc_info=True,
				)
			return ActivationResult(activated=False, superseded=True)

		store.set_generation_visibility(
			generation_id=str(context.generation_id),
			visibility="active",
			access_scope=scope,
		)
		try:
			activation = self.repository.activate_generation(lease, context)
		except Exception:
			# If commit outcome is known to be negative, compensate the hint.
			# If the DB itself is unreachable, leave the hint active: the
			# authoritative DB gate still excludes it and retry is safe.
			try:
				is_active = self.repository.is_generation_active(context)
			except Exception:
				is_active = None
			if is_active is False:
				try:
					store.set_generation_visibility(
						generation_id=str(context.generation_id),
						visibility="staging",
						access_scope=scope,
					)
				except Exception:
					logger.warning(
						"lifecycle_worker.activation_compensation_failed generation_id=%s",
						context.generation_id,
						exc_info=True,
					)
			else:
				if is_active is True:
					return ActivationResult(activated=True, superseded=False)
			raise

		if not activation.activated:
			try:
				store.set_generation_visibility(
					generation_id=str(context.generation_id),
					visibility="inactive",
					access_scope=scope,
				)
			except Exception:
				logger.warning(
					"lifecycle_worker.superseded_hint_cleanup_failed generation_id=%s",
					context.generation_id,
					exc_info=True,
				)
			return activation
		get_bm25_cache().invalidate(context.rag_library_id)
		if activation.previous_generation_id is not None:
			try:
				store.set_generation_visibility(
					generation_id=str(activation.previous_generation_id),
					visibility="inactive",
					access_scope=scope,
				)
				self.repository.mark_cleanup_hint(
					generation_id=activation.previous_generation_id,
					applied=True,
				)
			except Exception as exc:
				logger.warning(
					"lifecycle_worker.old_hint_cleanup_failed generation_id=%s",
					activation.previous_generation_id,
					exc_info=True,
				)
				try:
					self.repository.mark_cleanup_hint(
						generation_id=activation.previous_generation_id,
						applied=False,
						error=str(exc),
					)
				except Exception:
					logger.warning(
						"lifecycle_worker.cleanup_status_write_failed generation_id=%s",
						activation.previous_generation_id,
						exc_info=True,
					)
		return activation

	@staticmethod
	def _access_scope(context: DocumentIngestContext) -> AccessScope:
		return AccessScope(
			tenant_id=str(context.organization_id),
			workspace_id=str(context.workspace_id),
			principal_id=str(context.principal_id or context.organization_id),
		)

	def _delete_staging_generation(self, context: DocumentIngestContext) -> None:
		try:
			scope = AccessScope(
				tenant_id=str(context.organization_id),
				workspace_id=str(context.workspace_id),
				principal_id=str(context.principal_id or context.organization_id),
			)
			self._qdrant_store_factory().delete_by_generation(
				generation_id=str(context.generation_id),
				access_scope=scope,
			)
		except Exception:
			logger.warning(
				"lifecycle_worker.staging_cleanup_failed generation_id=%s",
				context.generation_id,
				exc_info=True,
			)


def classify_ingest_error(error: Exception) -> tuple[bool, str]:
	if isinstance(error, SourceObjectError):
		return False, "source_object_invalid"
	if isinstance(error, StaleDocumentVersionError):
		return False, "stale_document_version"
	if isinstance(error, MinerUClientError):
		return error.retryable, error.code
	if isinstance(error, ValueError):
		return False, "invalid_document"
	if isinstance(error, RuntimeError) and "validation mismatch" in str(error):
		return True, "generation_validation_failed"
	return True, "ingest_transient"


_MINERU_LONG_BACKOFF_CODES = frozenset({"mineru_rate_limited", "mineru_soft_timeout"})


def mineru_job_retry_delay_seconds(
	settings: Settings,
	*,
	error_code: str,
	attempt: int,
) -> int | None:
	"""Longer backoff for soft-timeout / 429; None keeps default job delay."""
	if error_code not in _MINERU_LONG_BACKOFF_CODES:
		return None
	base = max(1.0, float(settings.mineru_retry_base_s))
	cap = max(base, float(settings.mineru_retry_max_s))
	delay = base * (2 ** max(0, int(attempt) - 1))
	return int(min(cap, delay))
