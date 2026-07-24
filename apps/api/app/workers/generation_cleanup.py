"""Delayed Qdrant point deletion for superseded generations.

Consumes ``rag.generation_cleanup_queue`` rows whose ``delete_after`` has
passed. Safe to run from the lifecycle worker loop or as a one-shot ops
entrypoint: ``uv run python -m app.generation_cleanup_sweeper``.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass

from app.repositories.job_repository import (
	GenerationCleanupClaim,
	JobRepository,
)
from app.security.access_scope import AccessScope
from app.services.qdrant_store import QdrantStore
from app.settings import Settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SweepBatchResult:
	claimed: int
	deleted: int
	errors: int


class GenerationCleanupSweeper:
	def __init__(
		self,
		settings: Settings,
		repository: JobRepository,
		*,
		qdrant_store_factory: Callable[[], QdrantStore] | None = None,
	) -> None:
		self.settings = settings
		self.repository = repository
		self._qdrant_store_factory = qdrant_store_factory or (
			lambda: QdrantStore(settings)
		)

	def run_once(self, *, capacity: int | None = None) -> SweepBatchResult:
		batch_size = (
			self.settings.lifecycle_cleanup_batch_size
			if capacity is None
			else capacity
		)
		if batch_size < 1:
			raise ValueError("capacity must be positive")
		claims = self.repository.claim_cleanup_due(capacity=batch_size)
		if not claims:
			return SweepBatchResult(claimed=0, deleted=0, errors=0)

		store = self._qdrant_store_factory()
		deleted = 0
		errors = 0
		for claim in claims:
			if self._sweep_one(store, claim):
				deleted += 1
			else:
				errors += 1
		return SweepBatchResult(
			claimed=len(claims),
			deleted=deleted,
			errors=errors,
		)

	def _sweep_one(
		self,
		store: QdrantStore,
		claim: GenerationCleanupClaim,
	) -> bool:
		scope = AccessScope(
			tenant_id=str(claim.organization_id),
			workspace_id=str(claim.workspace_id),
			principal_id=str(claim.organization_id),
		)
		try:
			store.delete_by_generation(
				generation_id=str(claim.generation_id),
				access_scope=scope,
			)
			self.repository.mark_cleanup_swept(generation_id=claim.generation_id)
			logger.info(
				"generation_cleanup.deleted generation_id=%s document_id=%s "
				"attempts=%s",
				claim.generation_id,
				claim.document_id,
				claim.sweep_attempts,
			)
			return True
		except Exception as exc:
			logger.warning(
				"generation_cleanup.failed generation_id=%s document_id=%s",
				claim.generation_id,
				claim.document_id,
				exc_info=True,
			)
			try:
				self.repository.mark_cleanup_sweep_error(
					generation_id=claim.generation_id,
					error=str(exc) or exc.__class__.__name__,
				)
			except Exception:
				logger.warning(
					"generation_cleanup.status_write_failed generation_id=%s",
					claim.generation_id,
					exc_info=True,
				)
			return False
