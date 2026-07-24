from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest

from app.repositories.job_repository import (
	ActivationPreparation,
	ActivationResult,
	CancelRequestedError,
	DocumentIngestContext,
	JobLease,
	JobStage,
	JobStatus,
)
from app.settings import Settings
from app.workers.document_ingest import (
	DocumentIngestProcessor,
	classify_ingest_error,
)
from app.services.ingest.backends.mineru import MinerUClientError
from app.services.source_object_storage import SourceObjectIntegrityError

TESTDATA = Path(__file__).resolve().parents[3] / "testdata"


class FakeRepository:
	def __init__(
		self,
		context: DocumentIngestContext,
		*,
		previous_generation_id=None,
		superseded: bool = False,
	) -> None:
		self.context = context
		self.previous_generation_id = previous_generation_id
		self.superseded = superseded
		self.began = False
		self.completed: dict[str, object] | None = None
		self.cancelled = False
		self.activation_prepared = False
		self.activated = False
		self.cleanup_hints: list[tuple[object, bool]] = []
		self.failure: dict[str, object] | None = None

	def load_document_ingest_context(self, _lease: JobLease) -> DocumentIngestContext:
		return self.context

	def begin_document_ingest(
		self,
		_lease: JobLease,
		_context: DocumentIngestContext,
	) -> None:
		self.began = True

	def cancellation_requested(self, _lease: JobLease) -> bool:
		return False

	def complete_indexing(
		self,
		_lease: JobLease,
		_context: DocumentIngestContext,
		**values: object,
	) -> None:
		self.completed = values

	def prepare_activation(
		self,
		_lease: JobLease,
		_context: DocumentIngestContext,
	) -> ActivationPreparation:
		self.activation_prepared = True
		return ActivationPreparation(
			should_activate=not self.superseded,
			superseded=self.superseded,
		)

	def activate_generation(
		self,
		_lease: JobLease,
		_context: DocumentIngestContext,
	) -> ActivationResult:
		self.activated = True
		return ActivationResult(
			activated=True,
			superseded=False,
			previous_generation_id=self.previous_generation_id,
		)

	def is_generation_active(self, _context: DocumentIngestContext) -> bool:
		return self.activated

	def mark_cleanup_hint(
		self,
		*,
		generation_id: object,
		applied: bool,
		**_values: object,
	) -> None:
		self.cleanup_hints.append((generation_id, applied))

	def acknowledge_cancel(
		self,
		_lease: JobLease,
		_context: DocumentIngestContext,
		*,
		result: dict[str, object] | None = None,
	) -> None:
		assert result is not None
		self.cancelled = True

	def fail(
		self,
		_lease: JobLease,
		_context: DocumentIngestContext,
		**values: object,
	) -> None:
		self.failure = values


class FakeStorage:
	def __init__(self, content: bytes) -> None:
		self.content = content

	def read_bytes(self, _key: str, *, expected_hash: str | None = None) -> bytes:
		assert expected_hash == f"sha256:{hashlib.sha256(self.content).hexdigest()}"
		return self.content


class RaisingStorage:
	def read_bytes(self, *_args: object, **_kwargs: object) -> bytes:
		raise AssertionError("indexed activation retry must not read source")


class FakeStore:
	def __init__(self) -> None:
		self.generation_id = ""
		self.point_count = 0
		self.visibility: list[tuple[str, str]] = []

	def count_generation(self, *, generation_id: str, access_scope: object) -> int:
		assert access_scope is not None
		assert generation_id == self.generation_id
		return self.point_count

	def set_generation_visibility(
		self,
		*,
		generation_id: str,
		visibility: str,
		access_scope: object,
	) -> None:
		assert access_scope is not None
		self.visibility.append((generation_id, visibility))


class FakeIngestService:
	def __init__(self) -> None:
		self.store = FakeStore()
		self.arguments: dict[str, object] = {}

	def ingest_ir_chunks(self, **values: object) -> dict[str, object]:
		self.arguments = values
		callback = values["progress_callback"]
		assert callable(callback)
		callback("embedding", 0, 2)
		callback("indexing", 2, 2)
		self.store.generation_id = str(values["generation_id"])
		self.store.point_count = 2
		return {
			"point_count": 2,
			"chunk_count": 1,
			"section_count": 1,
			"table_count": 0,
		}


class RecordingProgress:
	def __init__(self) -> None:
		self.stages: list[JobStage] = []

	def checkpoint(
		self,
		stage: JobStage,
		_progress: int,
		*,
		current: int | None = None,
		total: int | None = None,
	) -> None:
		if current is not None and total is not None:
			assert current <= total
		self.stages.append(stage)


class CancellingProgress(RecordingProgress):
	def checkpoint(
		self,
		stage: JobStage,
		progress: int,
		*,
		current: int | None = None,
		total: int | None = None,
	) -> None:
		super().checkpoint(stage, progress, current=current, total=total)
		if stage == JobStage.INDEXING:
			raise CancelRequestedError("cancel requested")


class FakeCleanupStore:
	def __init__(self) -> None:
		self.deleted: list[str] = []

	def delete_by_generation(
		self,
		*,
		generation_id: str,
		access_scope: object,
	) -> None:
		assert access_scope is not None
		self.deleted.append(generation_id)


def test_document_lifecycle_worker_indexes_real_version_as_staging() -> None:
	content = b"# Leave policy\n\nSubmit evidence within three working days.\n"
	organization_id = uuid4()
	workspace_id = uuid4()
	version_id = uuid4()
	generation_id = uuid4()
	job_id = uuid4()
	context = DocumentIngestContext(
		job_id=job_id,
		organization_id=organization_id,
		workspace_id=workspace_id,
		library_id=uuid4(),
		document_id=uuid4(),
		document_version_id=version_id,
		generation_id=generation_id,
		rag_document_id="document-a",
		rag_library_id="library-a",
		title="Leave policy",
		filename="leave.md",
		content_type="text/markdown",
		content_hash=f"sha256:{hashlib.sha256(content).hexdigest()}",
		storage_key="org/workspace/leave.md",
		pipeline_version="document-lifecycle-v2",
		version_status="pending",
		parser_backend=None,
		chunk_profile=None,
		parser_report=None,
		point_count=None,
		chunk_count=None,
		section_count=None,
		table_count=None,
		principal_id=uuid4(),
		allowed_principal_ids=(),
		allowed_group_ids=(),
	)
	lease = JobLease(
		id=job_id,
		organization_id=organization_id,
		workspace_id=workspace_id,
		document_version_id=version_id,
		type="document.ingest",
		status=JobStatus.RUNNING,
		stage=JobStage.ACCEPTED,
		attempt=1,
		max_attempts=5,
		lease_token=uuid4(),
		lease_expires_at=datetime.now(timezone.utc),
		payload={},
	)
	repository = FakeRepository(context)
	service = FakeIngestService()
	progress = RecordingProgress()
	processor = DocumentIngestProcessor(
		Settings(chunking_profile="balanced"),
		repository,  # type: ignore[arg-type]
		storage=FakeStorage(content),  # type: ignore[arg-type]
		ingest_service_factory=lambda _scope: service,
	)

	result = processor.process(lease, progress)

	assert repository.began is True
	assert repository.completed is not None
	assert repository.completed["point_count"] == 2
	assert repository.activation_prepared is True
	assert repository.activated is True
	assert service.arguments["document_version_id"] == str(version_id)
	assert service.arguments["generation_id"] == str(generation_id)
	assert service.arguments["lifecycle_visibility"] == "staging"
	assert progress.stages == [
		JobStage.DOWNLOADING,
		JobStage.PARSING,
		JobStage.CHUNKING,
		JobStage.EMBEDDING,
		JobStage.INDEXING,
		JobStage.VALIDATING,
		JobStage.AWAITING_ACTIVATION,
		JobStage.ACTIVATING,
	]
	assert result.point_count == 2
	assert result.activated is True
	assert result.superseded is False
	assert service.store.visibility == [(str(generation_id), "active")]


def test_document_lifecycle_worker_cleans_staging_when_cancelled() -> None:
	content = b"# Policy\n\nCancel this generation.\n"
	organization_id = uuid4()
	workspace_id = uuid4()
	version_id = uuid4()
	generation_id = uuid4()
	job_id = uuid4()
	context = DocumentIngestContext(
		job_id=job_id,
		organization_id=organization_id,
		workspace_id=workspace_id,
		library_id=uuid4(),
		document_id=uuid4(),
		document_version_id=version_id,
		generation_id=generation_id,
		rag_document_id="document-cancel",
		rag_library_id="library-a",
		title="Policy",
		filename="policy.md",
		content_type="text/markdown",
		content_hash=f"sha256:{hashlib.sha256(content).hexdigest()}",
		storage_key="org/workspace/policy.md",
		pipeline_version="document-lifecycle-v2",
		version_status="pending",
		parser_backend=None,
		chunk_profile=None,
		parser_report=None,
		point_count=None,
		chunk_count=None,
		section_count=None,
		table_count=None,
		principal_id=None,
		allowed_principal_ids=(),
		allowed_group_ids=(),
	)
	lease = JobLease(
		id=job_id,
		organization_id=organization_id,
		workspace_id=workspace_id,
		document_version_id=version_id,
		type="document.ingest",
		status=JobStatus.RUNNING,
		stage=JobStage.ACCEPTED,
		attempt=1,
		max_attempts=5,
		lease_token=uuid4(),
		lease_expires_at=datetime.now(timezone.utc),
		payload={},
	)
	repository = FakeRepository(context)
	service = FakeIngestService()
	cleanup = FakeCleanupStore()
	processor = DocumentIngestProcessor(
		Settings(),
		repository,  # type: ignore[arg-type]
		storage=FakeStorage(content),  # type: ignore[arg-type]
		ingest_service_factory=lambda _scope: service,
		qdrant_store_factory=lambda: cleanup,
	)

	with pytest.raises(CancelRequestedError):
		processor.process(lease, CancellingProgress())

	assert repository.cancelled is True
	assert cleanup.deleted == [str(generation_id)]


def test_indexed_job_resumes_at_activation_and_deactivates_previous_hint() -> None:
	organization_id = uuid4()
	workspace_id = uuid4()
	version_id = uuid4()
	generation_id = uuid4()
	previous_generation_id = uuid4()
	job_id = uuid4()
	context = DocumentIngestContext(
		job_id=job_id,
		organization_id=organization_id,
		workspace_id=workspace_id,
		library_id=uuid4(),
		document_id=uuid4(),
		document_version_id=version_id,
		generation_id=generation_id,
		rag_document_id="document-resume",
		rag_library_id="library-a",
		title="Policy",
		filename="policy.md",
		content_type="text/markdown",
		content_hash="sha256:already-indexed",
		storage_key="org/workspace/policy.md",
		pipeline_version="document-lifecycle-v2",
		version_status="indexed",
		parser_backend="markdown",
		chunk_profile="balanced",
		parser_report={"parser": "markdown"},
		point_count=2,
		chunk_count=1,
		section_count=1,
		table_count=0,
		principal_id=None,
		allowed_principal_ids=(),
		allowed_group_ids=(),
	)
	lease = JobLease(
		id=job_id,
		organization_id=organization_id,
		workspace_id=workspace_id,
		document_version_id=version_id,
		type="document.ingest",
		status=JobStatus.RUNNING,
		stage=JobStage.AWAITING_ACTIVATION,
		attempt=2,
		max_attempts=5,
		lease_token=uuid4(),
		lease_expires_at=datetime.now(timezone.utc),
		payload={},
	)
	repository = FakeRepository(
		context,
		previous_generation_id=previous_generation_id,
	)
	store = FakeStore()
	store.generation_id = str(generation_id)
	store.point_count = 2
	processor = DocumentIngestProcessor(
		Settings(),
		repository,  # type: ignore[arg-type]
		storage=RaisingStorage(),  # type: ignore[arg-type]
		ingest_service_factory=lambda _scope: (_ for _ in ()).throw(
			AssertionError("indexed activation retry must not create ingest service")
		),
		qdrant_store_factory=lambda: store,
	)

	result = processor.process(lease, RecordingProgress())

	assert repository.began is False
	assert result.activated is True
	assert store.visibility == [
		(str(generation_id), "active"),
		(str(previous_generation_id), "inactive"),
	]
	assert repository.cleanup_hints == [(previous_generation_id, True)]


def test_source_integrity_errors_are_permanent() -> None:
	retryable, code = classify_ingest_error(SourceObjectIntegrityError("bad hash"))
	assert retryable is False
	assert code == "source_object_invalid"


@pytest.mark.parametrize(
	("error", "retryable", "code"),
	[
		(
			MinerUClientError("timeout", code="mineru_timeout"),
			True,
			"mineru_timeout",
		),
		(
			MinerUClientError(
				"bad request",
				code="mineru_request_rejected",
				retryable=False,
			),
			False,
			"mineru_request_rejected",
		),
	],
)
def test_mineru_error_classification(
	error: MinerUClientError,
	retryable: bool,
	code: str,
) -> None:
	assert classify_ingest_error(error) == (retryable, code)


@pytest.mark.parametrize(
	("relative_path", "settings"),
	[
		("txt/plain.txt", Settings()),
		("docx/policy-headings.docx", Settings()),
		("pdf/leave-digital.pdf", Settings()),
		(
			"pdf/leave-scanned.pdf",
			Settings(mineru_enabled=True, mineru_use_fake=True),
		),
	],
)
def test_real_files_run_through_lifecycle_v2(
	relative_path: str,
	settings: Settings,
) -> None:
	source = TESTDATA / relative_path
	if not source.is_file():
		pytest.skip(f"fixture missing: {source}")
	content = source.read_bytes()
	organization_id = uuid4()
	workspace_id = uuid4()
	version_id = uuid4()
	generation_id = uuid4()
	job_id = uuid4()
	context = DocumentIngestContext(
		job_id=job_id,
		organization_id=organization_id,
		workspace_id=workspace_id,
		library_id=uuid4(),
		document_id=uuid4(),
		document_version_id=version_id,
		generation_id=generation_id,
		rag_document_id=f"document-{source.stem}",
		rag_library_id="library-real-files",
		title=source.stem,
		filename=source.name,
		content_type="application/octet-stream",
		content_hash=f"sha256:{hashlib.sha256(content).hexdigest()}",
		storage_key=f"fixtures/{source.name}",
		pipeline_version="document-lifecycle-v2",
		version_status="pending",
		parser_backend=None,
		chunk_profile=None,
		parser_report=None,
		point_count=None,
		chunk_count=None,
		section_count=None,
		table_count=None,
		principal_id=uuid4(),
		allowed_principal_ids=(),
		allowed_group_ids=(),
	)
	lease = JobLease(
		id=job_id,
		organization_id=organization_id,
		workspace_id=workspace_id,
		document_version_id=version_id,
		type="document.ingest",
		status=JobStatus.RUNNING,
		stage=JobStage.ACCEPTED,
		attempt=1,
		max_attempts=5,
		lease_token=uuid4(),
		lease_expires_at=datetime.now(timezone.utc),
		payload={},
	)
	repository = FakeRepository(context)
	service = FakeIngestService()
	progress = RecordingProgress()
	processor = DocumentIngestProcessor(
		settings,
		repository,  # type: ignore[arg-type]
		storage=FakeStorage(content),  # type: ignore[arg-type]
		ingest_service_factory=lambda _scope: service,
	)

	result = processor.process(lease, progress)

	assert result.activated is True
	assert repository.completed is not None
	report = repository.completed["parser_report"]
	assert isinstance(report, dict)
	assert report["parser"]
	assert service.arguments["lifecycle_visibility"] == "staging"
	assert JobStage.PARSING in progress.stages
	assert JobStage.ACTIVATING in progress.stages
