from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from app.repositories.job_repository import GenerationCleanupClaim
from app.settings import Settings
from app.workers.generation_cleanup import GenerationCleanupSweeper


class FakeRepository:
	def __init__(self, claims: list[GenerationCleanupClaim] | None = None) -> None:
		self.claims = list(claims or [])
		self.swept: list[object] = []
		self.errors: list[tuple[object, str]] = []

	def claim_cleanup_due(self, *, capacity: int) -> list[GenerationCleanupClaim]:
		assert capacity >= 1
		claimed = self.claims[:capacity]
		self.claims = self.claims[capacity:]
		return claimed

	def mark_cleanup_swept(self, *, generation_id: object) -> None:
		self.swept.append(generation_id)

	def mark_cleanup_sweep_error(self, *, generation_id: object, error: str) -> None:
		self.errors.append((generation_id, error))


class FakeStore:
	def __init__(self, *, fail_ids: set[str] | None = None) -> None:
		self.deleted: list[str] = []
		self.fail_ids = fail_ids or set()

	def delete_by_generation(
		self,
		*,
		generation_id: str,
		access_scope: object,
	) -> None:
		assert access_scope is not None
		if generation_id in self.fail_ids:
			raise RuntimeError("qdrant unavailable")
		self.deleted.append(generation_id)


def _claim(generation_id=None) -> GenerationCleanupClaim:
	return GenerationCleanupClaim(
		generation_id=generation_id or uuid4(),
		organization_id=uuid4(),
		workspace_id=uuid4(),
		library_id=uuid4(),
		document_id=uuid4(),
		document_version_id=uuid4(),
		delete_after=datetime.now(timezone.utc),
		hint_status="applied",
		sweep_attempts=1,
	)


def test_sweeper_deletes_due_generations_and_marks_status() -> None:
	first = _claim()
	second = _claim()
	repository = FakeRepository([first, second])
	store = FakeStore()
	sweeper = GenerationCleanupSweeper(
		Settings(lifecycle_cleanup_batch_size=10),
		repository,  # type: ignore[arg-type]
		qdrant_store_factory=lambda: store,
	)

	result = sweeper.run_once()

	assert result.claimed == 2
	assert result.deleted == 2
	assert result.errors == 0
	assert store.deleted == [str(first.generation_id), str(second.generation_id)]
	assert repository.swept == [first.generation_id, second.generation_id]
	assert repository.errors == []


def test_sweeper_records_errors_without_stopping_batch() -> None:
	ok = _claim()
	bad = _claim()
	repository = FakeRepository([ok, bad])
	store = FakeStore(fail_ids={str(bad.generation_id)})
	sweeper = GenerationCleanupSweeper(
		Settings(),
		repository,  # type: ignore[arg-type]
		qdrant_store_factory=lambda: store,
	)

	result = sweeper.run_once(capacity=5)

	assert result.claimed == 2
	assert result.deleted == 1
	assert result.errors == 1
	assert store.deleted == [str(ok.generation_id)]
	assert repository.swept == [ok.generation_id]
	assert repository.errors == [(bad.generation_id, "qdrant unavailable")]


def test_sweeper_noop_when_queue_empty() -> None:
	repository = FakeRepository([])
	store = FakeStore()
	sweeper = GenerationCleanupSweeper(
		Settings(),
		repository,  # type: ignore[arg-type]
		qdrant_store_factory=lambda: store,
	)

	result = sweeper.run_once()

	assert result.claimed == 0
	assert result.deleted == 0
	assert result.errors == 0
	assert store.deleted == []
