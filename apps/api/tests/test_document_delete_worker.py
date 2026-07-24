from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.repositories.job_repository import (
	DocumentDeleteCompletion,
	DocumentDeleteContext,
	JobLease,
	JobStage,
	JobStatus,
)
from app.settings import Settings
from app.workers.document_delete import DocumentDeleteProcessor


class FakeProgress:
	def __init__(self) -> None:
		self.events: list[tuple[JobStage, int]] = []

	def checkpoint(
		self,
		stage: JobStage,
		progress: int,
		*,
		current: int | None = None,
		total: int | None = None,
	) -> None:
		self.events.append((stage, progress))


class FakeRepository:
	def __init__(self, context: DocumentDeleteContext) -> None:
		self.context = context
		self.completed: dict[str, object] | None = None
		self.failure: dict[str, object] | None = None

	def load_document_delete_context(self, _lease: JobLease) -> DocumentDeleteContext:
		return self.context

	def complete_document_delete(
		self,
		_lease: JobLease,
		_context: DocumentDeleteContext,
		*,
		result: dict[str, object] | None = None,
	) -> DocumentDeleteCompletion:
		self.completed = result or {}
		return DocumentDeleteCompletion(library_finalized=False)

	def fail_leased_job(self, _lease: JobLease, **values: object) -> None:
		self.failure = values


class FakeStore:
	def __init__(self) -> None:
		self.generations: list[str] = []
		self.docs: list[tuple[str, str | None]] = []

	def delete_by_generation(self, *, generation_id: str, access_scope=None) -> None:
		self.generations.append(generation_id)

	def delete_by_doc_id(
		self,
		*,
		doc_id: str,
		library_id: str | None = None,
		access_scope=None,
	) -> None:
		self.docs.append((doc_id, library_id))


class FakeStorage:
	def __init__(self) -> None:
		self.deleted: list[str] = []

	def delete(self, key: str) -> None:
		self.deleted.append(key)


class FakeMeta:
	def __init__(self) -> None:
		self.deleted: list[str] = []

	def delete_document(self, doc_id: str, *, scope) -> bool:
		self.deleted.append(doc_id)
		return True


class FakeIngest:
	def delete_document_chunks(self, *, doc_id: str, library_id: str | None = None) -> None:
		return None


def _lease() -> JobLease:
	return JobLease(
		id=uuid4(),
		organization_id=uuid4(),
		workspace_id=uuid4(),
		document_version_id=None,
		type="document.delete",
		status=JobStatus.RUNNING,
		stage=JobStage.CLEANUP,
		attempt=1,
		max_attempts=5,
		lease_token=uuid4(),
		lease_expires_at=datetime.now(timezone.utc),
		payload={},
	)


def test_document_delete_processor_cleans_qdrant_storage_and_metadata(monkeypatch):
	gen_a = uuid4()
	gen_b = uuid4()
	context = DocumentDeleteContext(
		job_id=uuid4(),
		organization_id=uuid4(),
		workspace_id=uuid4(),
		library_id=uuid4(),
		document_id=uuid4(),
		rag_document_id="rag-doc-1",
		rag_library_id="rag-lib-1",
		library_status="ready",
		library_delete=False,
		storage_keys=("ten/a.md", "ten/b.md"),
		generation_ids=(gen_a, gen_b),
		principal_id=None,
	)
	repo = FakeRepository(context)
	store = FakeStore()
	storage = FakeStorage()
	meta = FakeMeta()
	settings = Settings(
		ask_mode="stub",
		document_storage_root="/tmp/meriknow-test-storage",
		worker_database_url="postgresql://unused",
	)
	processor = DocumentDeleteProcessor(
		settings,
		repo,  # type: ignore[arg-type]
		storage=storage,  # type: ignore[arg-type]
		qdrant_store_factory=lambda: store,
		metadata_store_factory=lambda: meta,
		ingest_service_factory=lambda _scope: FakeIngest(),
	)
	monkeypatch.setattr(
		"app.workers.document_delete.get_bm25_cache",
		lambda: type("C", (), {"invalidate": staticmethod(lambda *_a, **_k: None)})(),
	)
	result = processor.process(_lease(), FakeProgress())
	assert result.rag_document_id == "rag-doc-1"
	assert result.storage_deleted == 2
	assert result.generations_deleted == 2
	assert store.generations == [str(gen_a), str(gen_b)]
	assert storage.deleted == ["ten/a.md", "ten/b.md"]
	assert meta.deleted == ["rag-doc-1"]
	assert repo.completed is not None
	assert repo.failure is None


def test_document_delete_processor_marks_retryable_failure(monkeypatch):
	context = DocumentDeleteContext(
		job_id=uuid4(),
		organization_id=uuid4(),
		workspace_id=uuid4(),
		library_id=uuid4(),
		document_id=uuid4(),
		rag_document_id="rag-doc-2",
		rag_library_id="rag-lib-2",
		library_status="ready",
		library_delete=False,
		storage_keys=("missing.md",),
		generation_ids=(),
		principal_id=None,
	)
	repo = FakeRepository(context)

	class BoomStorage:
		def delete(self, key: str) -> None:
			raise RuntimeError("disk full")

	settings = Settings(
		ask_mode="stub",
		document_storage_root="/tmp/meriknow-test-storage",
		worker_database_url="postgresql://unused",
	)
	processor = DocumentDeleteProcessor(
		settings,
		repo,  # type: ignore[arg-type]
		storage=BoomStorage(),  # type: ignore[arg-type]
		qdrant_store_factory=lambda: FakeStore(),
		metadata_store_factory=lambda: FakeMeta(),
		ingest_service_factory=lambda _scope: FakeIngest(),
	)
	monkeypatch.setattr(
		"app.workers.document_delete.get_bm25_cache",
		lambda: type("C", (), {"invalidate": staticmethod(lambda *_a, **_k: None)})(),
	)
	with pytest.raises(RuntimeError, match="disk full"):
		processor.process(_lease(), FakeProgress())
	assert repo.failure is not None
	assert repo.failure["retryable"] is True
	assert repo.failure["error_code"] == "document_delete_failed"
