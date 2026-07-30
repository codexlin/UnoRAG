from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any, Iterator, Sequence
from uuid import UUID

from psycopg import Connection
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    RETRY = "retry"
    CANCELLING = "cancelling"
    CANCELLED = "cancelled"
    COMPLETED = "completed"
    FAILED = "failed"
    DEAD = "dead"


class JobStage(StrEnum):
    ACCEPTED = "accepted"
    DOWNLOADING = "downloading"
    PARSING = "parsing"
    CHUNKING = "chunking"
    EMBEDDING = "embedding"
    INDEXING = "indexing"
    VALIDATING = "validating"
    AWAITING_ACTIVATION = "awaiting_activation"
    ACTIVATING = "activating"
    CLEANUP = "cleanup"
    DONE = "done"


class LostJobLeaseError(RuntimeError):
    pass


class CancelRequestedError(RuntimeError):
    pass


class StaleDocumentVersionError(RuntimeError):
    pass


@dataclass(frozen=True)
class JobLease:
    id: UUID
    organization_id: UUID
    workspace_id: UUID
    document_version_id: UUID | None
    type: str
    status: JobStatus
    stage: JobStage
    attempt: int
    max_attempts: int
    lease_token: UUID
    lease_expires_at: datetime
    payload: dict[str, Any]


@dataclass(frozen=True)
class DocumentIngestContext:
    job_id: UUID
    organization_id: UUID
    workspace_id: UUID
    library_id: UUID
    document_id: UUID
    document_version_id: UUID
    generation_id: UUID
    rag_document_id: str
    rag_library_id: str
    title: str
    filename: str
    content_type: str
    content_hash: str
    storage_key: str
    pipeline_version: str
    version_status: str
    parser_backend: str | None
    chunk_profile: str | None
    # Ingest policy snapshot from enqueue (document_version / job.payload).
    document_profile: str | None
    scan_handling: str | None
    parse_preference: str | None
    ingest_policy_version: int | None
    parser_report: dict[str, Any] | None
    point_count: int | None
    chunk_count: int | None
    section_count: int | None
    table_count: int | None
    principal_id: UUID | None
    allowed_principal_ids: tuple[UUID, ...]
    allowed_group_ids: tuple[UUID, ...]


@dataclass(frozen=True)
class JobFailureResult:
    status: JobStatus
    next_attempt_at: datetime | None


@dataclass(frozen=True)
class ActivationPreparation:
    should_activate: bool
    superseded: bool


@dataclass(frozen=True)
class ActivationResult:
    activated: bool
    superseded: bool
    previous_document_version_id: UUID | None = None
    previous_generation_id: UUID | None = None


@dataclass(frozen=True)
class GenerationCleanupClaim:
    generation_id: UUID
    organization_id: UUID
    workspace_id: UUID
    library_id: UUID
    document_id: UUID
    document_version_id: UUID
    delete_after: datetime
    hint_status: str
    sweep_attempts: int


@dataclass(frozen=True)
class DocumentDeleteContext:
    job_id: UUID
    organization_id: UUID
    workspace_id: UUID
    library_id: UUID
    document_id: UUID
    rag_document_id: str
    rag_library_id: str
    library_status: str
    library_delete: bool
    storage_keys: tuple[str, ...]
    generation_ids: tuple[UUID, ...]
    principal_id: UUID | None


@dataclass(frozen=True)
class DocumentDeleteCompletion:
    library_finalized: bool


class JobRepository:
    """The only Python write boundary for app.jobs scheduling fields."""

    def __init__(self, connection: Connection[Any]) -> None:
        self._connection = connection

    @contextmanager
    def document_write_fence(
        self,
        lease: JobLease,
        context: DocumentIngestContext,
    ) -> Iterator[None]:
        """Serialize the final Qdrant write against document deletion."""
        locked = False
        try:
            with self._connection.cursor() as cursor:
                cursor.execute("SET lock_timeout = '30s'")
                cursor.execute(
                    """
                    SELECT pg_advisory_lock(
                        hashtextextended(%(document_id)s::text, 0)
                    )
                    """,
                    {"document_id": context.document_id},
                )
                locked = True
            with self._connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT 1
                    FROM app.jobs AS job
                    JOIN app.document_versions AS version
                      ON version.id = job.document_version_id
                    JOIN app.documents AS document
                      ON document.id = version.document_id
                    WHERE job.id = %(job_id)s
                      AND job.lease_token = %(lease_token)s
                      AND job.status = 'running'
                      AND job.lease_expires_at > now()
                      AND version.id = %(version_id)s
                      AND version.generation_id = %(generation_id)s
                      AND document.id = %(document_id)s
                      AND document.desired_version_id = version.id
                      AND document.status NOT IN ('deleting', 'deleted')
                    """,
                    {
                        "job_id": lease.id,
                        "lease_token": lease.lease_token,
                        "version_id": context.document_version_id,
                        "generation_id": context.generation_id,
                        "document_id": context.document_id,
                    },
                )
                if cursor.fetchone() is None:
                    raise LostJobLeaseError(
                        f"document write fence rejected job {lease.id}"
                    )
            yield
        finally:
            with self._connection.cursor() as cursor:
                if locked:
                    cursor.execute(
                        """
                        SELECT pg_advisory_unlock(
                            hashtextextended(%(document_id)s::text, 0)
                        )
                        """,
                        {"document_id": context.document_id},
                    )
                cursor.execute("RESET lock_timeout")

    def claim(
        self,
        *,
        worker_id: str,
        job_types: Sequence[str],
        capacity: int,
        lease_seconds: int = 120,
        worker_version: str | None = None,
        queue_classes: Sequence[str] | None = None,
    ) -> list[JobLease]:
        """Claim Python-owned queued jobs with SKIP LOCKED.

        ``queue_classes`` filters ``payload.queue_class`` (default ``local`` when
        missing). Pass ``None`` to claim any class (legacy single-queue behaviour).
        DBOS-owned jobs are never eligible for a Python lease.
        """
        if not worker_id.strip():
            raise ValueError("worker_id is required")
        if not job_types:
            return []
        if capacity < 1:
            raise ValueError("capacity must be positive")
        if lease_seconds < 30:
            raise ValueError("lease_seconds must be at least 30")
        classes = [str(item).strip() for item in (queue_classes or []) if str(item).strip()]

        with self._connection.transaction():
            with self._connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute(
                    """
                    WITH candidates AS (
                        SELECT id
                        FROM app.jobs
                        WHERE status IN ('queued', 'retry')
                          AND execution_engine = 'python'
                          AND attempt < max_attempts
                          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
                          AND cancel_requested_at IS NULL
                          AND type = ANY(%(job_types)s)
                          AND (
                            %(queue_classes)s::text[] IS NULL
                            OR COALESCE(
                                NULLIF(payload->>'queue_class', ''),
                                'local'
                            ) = ANY(%(queue_classes)s)
                          )
                        ORDER BY created_at, id
                        FOR UPDATE SKIP LOCKED
                        LIMIT %(capacity)s
                    )
                    UPDATE app.jobs AS job
                    SET status = 'running',
                        attempt = job.attempt + 1,
                        claimed_by = %(worker_id)s,
                        claimed_at = now(),
                        started_at = coalesce(job.started_at, now()),
                        lease_token = gen_random_uuid(),
                        lease_expires_at =
                            now() + make_interval(secs => %(lease_seconds)s),
                        heartbeat_at = now(),
                        worker_version = %(worker_version)s,
                        updated_at = now()
                    FROM candidates
                    WHERE job.id = candidates.id
                    RETURNING job.*
                    """,
                    {
                        "worker_id": worker_id,
                        "worker_version": worker_version,
                        "job_types": list(job_types),
                        "capacity": capacity,
                        "lease_seconds": lease_seconds,
                        "queue_classes": classes or None,
                    },
                )
                return [self._to_lease(row) for row in cursor.fetchall()]

    def patch_job_payload(
        self,
        *,
        job_id: UUID,
        lease_token: UUID,
        patch: dict[str, Any],
    ) -> None:
        """Merge keys into job.payload while lease is held."""
        if not patch:
            return
        with self._connection.transaction():
            with self._connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE app.jobs
                    SET payload = COALESCE(payload, '{}'::jsonb) || %(patch)s::jsonb,
                        updated_at = now()
                    WHERE id = %(job_id)s
                      AND lease_token = %(lease_token)s
                      AND status = 'running'
                    """,
                    {
                        "job_id": job_id,
                        "lease_token": lease_token,
                        "patch": Jsonb(patch),
                    },
                )
                if cursor.rowcount != 1:
                    raise LostJobLeaseError(
                        f"failed to patch payload for job {job_id}"
                    )

    def requeue_for_queue_class(
        self,
        *,
        job_id: UUID,
        lease_token: UUID,
        queue_class: str,
    ) -> None:
        """Release lease and re-queue with a new queue_class (does not burn attempt)."""
        resolved = (queue_class or "").strip() or "local"
        with self._connection.transaction():
            with self._connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE app.jobs
                    SET status = 'queued',
                        stage = 'accepted',
                        progress = 0,
                        claimed_by = NULL,
                        claimed_at = NULL,
                        started_at = NULL,
                        lease_token = NULL,
                        lease_expires_at = NULL,
                        heartbeat_at = NULL,
                        worker_version = NULL,
                        attempt = GREATEST(0, attempt - 1),
                        payload = COALESCE(payload, '{}'::jsonb) || %(patch)s,
                        updated_at = now()
                    WHERE id = %(job_id)s
                      AND lease_token = %(lease_token)s
                      AND status = 'running'
                    """,
                    {
                        "job_id": job_id,
                        "lease_token": lease_token,
                        "patch": Jsonb({"queue_class": resolved}),
                    },
                )
                if cursor.rowcount != 1:
                    raise LostJobLeaseError(
                        f"failed to requeue job {job_id} for class {resolved}"
                    )

    def defer_leased_job(
        self,
        *,
        job_id: UUID,
        lease_token: UUID,
        delay_seconds: float,
    ) -> None:
        """Release an async-provider poll without consuming a job attempt."""
        delay = max(1.0, float(delay_seconds))
        with self._connection.transaction():
            with self._connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE app.jobs
                    SET status = 'retry',
                        lease_token = NULL,
                        lease_expires_at = NULL,
                        claimed_by = NULL,
                        claimed_at = NULL,
                        heartbeat_at = NULL,
                        worker_version = NULL,
                        attempt = GREATEST(0, attempt - 1),
                        next_attempt_at =
                            now() + make_interval(secs => %(delay_seconds)s),
                        updated_at = now()
                    WHERE id = %(job_id)s
                      AND lease_token = %(lease_token)s
                      AND status = 'running'
                    """,
                    {
                        "job_id": job_id,
                        "lease_token": lease_token,
                        "delay_seconds": delay,
                    },
                )
                if cursor.rowcount != 1:
                    raise LostJobLeaseError(
                        f"failed to defer async provider poll for job {job_id}"
                    )

    def heartbeat(
        self,
        *,
        job_id: UUID,
        lease_token: UUID,
        stage: JobStage,
        progress: int,
        lease_seconds: int = 120,
        progress_current: int | None = None,
        progress_total: int | None = None,
    ) -> datetime:
        if not 0 <= progress <= 100:
            raise ValueError("progress must be between 0 and 100")
        if progress_current is not None and progress_current < 0:
            raise ValueError("progress_current cannot be negative")
        if progress_total is not None and progress_total < 0:
            raise ValueError("progress_total cannot be negative")
        if (
            progress_current is not None
            and progress_total is not None
            and progress_current > progress_total
        ):
            raise ValueError("progress_current cannot exceed progress_total")

        with self._connection.transaction():
            with self._connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE app.jobs
                    SET stage = %(stage)s,
                        progress = greatest(progress, %(progress)s),
                        progress_current = %(progress_current)s,
                        progress_total = %(progress_total)s,
                        heartbeat_at = now(),
                        lease_expires_at =
                            now() + make_interval(secs => %(lease_seconds)s),
                        updated_at = now()
                    WHERE id = %(job_id)s
                      AND lease_token = %(lease_token)s
                      AND status IN ('running', 'cancelling')
                      AND lease_expires_at > now()
                    RETURNING lease_expires_at
                    """,
                    {
                        "job_id": job_id,
                        "lease_token": lease_token,
                        "stage": stage.value,
                        "progress": progress,
                        "progress_current": progress_current,
                        "progress_total": progress_total,
                        "lease_seconds": lease_seconds,
                    },
                )
                row = cursor.fetchone()
                if row is None:
                    raise LostJobLeaseError(f"job lease is no longer valid: {job_id}")
                return row[0]

    def load_document_ingest_context(self, lease: JobLease) -> DocumentIngestContext:
        if lease.document_version_id is None:
            raise ValueError("document.ingest job requires document_version_id")
        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                """
                SELECT
                    job.id AS job_id,
                    job.organization_id,
                    job.workspace_id,
                    job.payload AS job_payload,
                    version.id AS document_version_id,
                    version.generation_id,
                    version.content_hash,
                    version.storage_key,
                    version.pipeline_version,
                    version.status AS version_status,
                    version.parser_backend,
                    version.chunk_profile,
                    version.parser_report,
                    version.point_count,
                    version.chunk_count,
                    version.section_count,
                    version.table_count,
                    version.document_profile AS version_document_profile,
                    version.scan_handling AS version_scan_handling,
                    version.parse_preference AS version_parse_preference,
                    version.ingest_policy_version AS version_ingest_policy_version,
                    document.id AS document_id,
                    document.rag_document_id,
                    document.name AS title,
                    document.filename,
                    document.content_type,
                    document.created_by AS principal_id,
                    library.id AS library_id,
                    library.rag_library_id,
                    coalesce(
                        array_agg(acl.subject_id)
                            FILTER (WHERE acl.subject_type = 'principal'),
                        ARRAY[]::uuid[]
                    ) AS allowed_principal_ids,
                    coalesce(
                        array_agg(acl.subject_id)
                            FILTER (WHERE acl.subject_type = 'group'),
                        ARRAY[]::uuid[]
                    ) AS allowed_group_ids
                FROM app.jobs AS job
                JOIN app.document_versions AS version
                  ON version.id = job.document_version_id
                JOIN app.documents AS document
                  ON document.id = version.document_id
                JOIN app.libraries AS library
                  ON library.id = document.library_id
                LEFT JOIN app.document_acl AS acl
                  ON acl.document_id = document.id
                 AND acl.permission = 'read'
                WHERE job.id = %(job_id)s
                  AND job.lease_token = %(lease_token)s
                  AND job.status IN ('running', 'cancelling')
                  AND job.lease_expires_at > now()
                  AND job.organization_id = document.organization_id
                  AND job.workspace_id = document.workspace_id
                GROUP BY
                    job.id,
                    version.id,
                    document.id,
                    library.id
                """,
                {"job_id": lease.id, "lease_token": lease.lease_token},
            )
            row = cursor.fetchone()
        if row is None:
            raise LostJobLeaseError(f"job lease is no longer valid: {lease.id}")
        payload = row.get("job_payload") if isinstance(row.get("job_payload"), dict) else {}
        # Prefer version snapshot, then job payload. Never re-read live library policy.
        document_profile = (
            row.get("version_document_profile")
            or payload.get("document_profile")
            or "auto"
        )
        scan_handling = (
            row.get("version_scan_handling")
            or payload.get("scan_handling")
            or "auto"
        )
        parse_preference = (
            row.get("version_parse_preference")
            or payload.get("parse_preference")
            or "auto"
        )
        ingest_policy_version = row.get("version_ingest_policy_version")
        if ingest_policy_version is None:
            raw_version = payload.get("ingest_policy_version")
            try:
                ingest_policy_version = int(raw_version) if raw_version is not None else 1
            except (TypeError, ValueError):
                ingest_policy_version = 1
        return DocumentIngestContext(
            job_id=row["job_id"],
            organization_id=row["organization_id"],
            workspace_id=row["workspace_id"],
            library_id=row["library_id"],
            document_id=row["document_id"],
            document_version_id=row["document_version_id"],
            generation_id=row["generation_id"],
            rag_document_id=row["rag_document_id"],
            rag_library_id=row["rag_library_id"],
            title=row["title"],
            filename=row["filename"],
            content_type=row["content_type"],
            content_hash=row["content_hash"],
            storage_key=row["storage_key"],
            pipeline_version=row["pipeline_version"],
            version_status=row["version_status"],
            parser_backend=row["parser_backend"],
            chunk_profile=row["chunk_profile"],
            document_profile=str(document_profile),
            scan_handling=str(scan_handling),
            parse_preference=str(parse_preference),
            ingest_policy_version=int(ingest_policy_version),
            parser_report=row["parser_report"],
            point_count=row["point_count"],
            chunk_count=row["chunk_count"],
            section_count=row["section_count"],
            table_count=row["table_count"],
            principal_id=row["principal_id"],
            allowed_principal_ids=tuple(row["allowed_principal_ids"]),
            allowed_group_ids=tuple(row["allowed_group_ids"]),
        )

    def begin_document_ingest(self, lease: JobLease, context: DocumentIngestContext) -> None:
        with self._connection.transaction():
            with self._connection.cursor() as cursor:
                self._lock_library_context(cursor, context)
                self._lock_document_key(cursor, context.document_id)
                cursor.execute(
                    """
                    SELECT desired_version_id
                    FROM app.documents
                    WHERE id = %(document_id)s
                      AND organization_id = %(organization_id)s
                      AND workspace_id = %(workspace_id)s
                      AND library_id = %(library_id)s
                    FOR UPDATE
                    """,
                    {
                        "document_id": context.document_id,
                        "organization_id": context.organization_id,
                        "workspace_id": context.workspace_id,
                        "library_id": context.library_id,
                    },
                )
                row = cursor.fetchone()
                if row is None or row[0] != context.document_version_id:
                    raise StaleDocumentVersionError(
                        f"document no longer desires version {context.document_version_id}"
                    )
                self._lock_document_version_context(cursor, context)
                self._assert_live_lease(cursor, lease)
                cursor.execute(
                    """
                    UPDATE app.document_versions
                    SET status = 'processing',
                        failure_code = NULL,
                        error = NULL,
                        updated_at = now()
                    WHERE id = %(version_id)s
                      AND status IN ('pending', 'processing', 'indexed', 'activating')
                    """,
                    {"version_id": context.document_version_id},
                )
                if cursor.rowcount != 1:
                    raise StaleDocumentVersionError(
                        f"document version cannot enter processing: {context.document_version_id}"
                    )

    def cancellation_requested(self, lease: JobLease) -> bool:
        with self._connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT status = 'cancelling' OR cancel_requested_at IS NOT NULL
                FROM app.jobs
                WHERE id = %(job_id)s
                  AND lease_token = %(lease_token)s
                  AND status IN ('running', 'cancelling')
                  AND lease_expires_at > now()
                """,
                {"job_id": lease.id, "lease_token": lease.lease_token},
            )
            row = cursor.fetchone()
        if row is None:
            raise LostJobLeaseError(f"job lease is no longer valid: {lease.id}")
        return bool(row[0])

    def mark_library_document_profile_applied(
        self,
        *,
        library_id: UUID,
        document_profile: str,
    ) -> None:
        """Deprecated aggregate hint only — requires_reindex uses per-version snapshots.

        Kept for backwards-compatible observability; never treat as sole signal.
        """
        profile = (document_profile or "auto").strip()[:64] or "auto"
        with self._connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE app.libraries
                SET applied_document_profile = %(profile)s,
                    updated_at = now()
                WHERE id = %(library_id)s
                """,
                {"library_id": library_id, "profile": profile},
            )

    def complete_indexing(
        self,
        lease: JobLease,
        context: DocumentIngestContext,
        *,
        parser_backend: str,
        chunk_profile: str,
        parser_report: dict[str, Any],
        point_count: int,
        chunk_count: int,
        section_count: int,
        table_count: int,
    ) -> None:
        result = {
            "document_id": str(context.document_id),
            "document_version_id": str(context.document_version_id),
            "generation_id": str(context.generation_id),
            "point_count": point_count,
            "chunk_count": chunk_count,
            "section_count": section_count,
            "table_count": table_count,
            "visibility": "staging",
        }
        with self._connection.transaction():
            with self._connection.cursor() as cursor:
                self._lock_library_context(cursor, context)
                self._lock_document_key(cursor, context.document_id)
                cursor.execute(
                    """
                    SELECT document.id
                    FROM app.documents AS document
                    JOIN app.document_versions AS version
                      ON version.id = %(version_id)s
                     AND version.document_id = document.id
                    WHERE document.id = %(document_id)s
                      AND document.organization_id = %(organization_id)s
                      AND document.workspace_id = %(workspace_id)s
                      AND document.library_id = %(library_id)s
                    FOR UPDATE OF document, version
                    """,
                    {
                        "document_id": context.document_id,
                        "version_id": context.document_version_id,
                        "organization_id": context.organization_id,
                        "workspace_id": context.workspace_id,
                        "library_id": context.library_id,
                    },
                )
                if cursor.fetchone() is None:
                    raise StaleDocumentVersionError("document version no longer exists")
                cursor.execute(
                    """
                    UPDATE app.document_versions
                    SET status = 'indexed',
                        parser_backend = %(parser_backend)s,
                        chunk_profile = %(chunk_profile)s,
                        parser_report = %(parser_report)s,
                        document_profile = coalesce(
                            document_profile, %(document_profile)s
                        ),
                        scan_handling = coalesce(
                            scan_handling, %(scan_handling)s
                        ),
                        parse_preference = coalesce(
                            parse_preference, %(parse_preference)s
                        ),
                        ingest_policy_version = coalesce(
                            ingest_policy_version, %(ingest_policy_version)s
                        ),
                        point_count = %(point_count)s,
                        chunk_count = %(chunk_count)s,
                        section_count = %(section_count)s,
                        table_count = %(table_count)s,
                        failure_code = NULL,
                        error = NULL,
                        indexed_at = now(),
                        updated_at = now()
                    WHERE id = %(version_id)s
                      AND document_id = %(document_id)s
                      AND generation_id = %(generation_id)s
                      AND status = 'processing'
                    """,
                    {
                        "version_id": context.document_version_id,
                        "document_id": context.document_id,
                        "generation_id": context.generation_id,
                        "parser_backend": parser_backend[:64],
                        "chunk_profile": chunk_profile[:64],
                        "parser_report": Jsonb(parser_report),
                        "document_profile": (context.document_profile or "auto")[:64],
                        "scan_handling": (context.scan_handling or "auto")[:32],
                        "parse_preference": (context.parse_preference or "auto")[:32],
                        "ingest_policy_version": int(
                            context.ingest_policy_version or 1
                        ),
                        "point_count": point_count,
                        "chunk_count": chunk_count,
                        "section_count": section_count,
                        "table_count": table_count,
                    },
                )
                if cursor.rowcount != 1:
                    raise StaleDocumentVersionError(
                        f"document version changed during indexing: {context.document_version_id}"
                    )
                cursor.execute(
                    """
                    UPDATE app.jobs
                    SET status = 'running',
                        stage = 'awaiting_activation',
                        progress = 94,
                        progress_current = %(point_count)s,
                        progress_total = %(point_count)s,
                        result = %(result)s,
                        error_code = NULL,
                        error = NULL,
                        heartbeat_at = now(),
                        updated_at = now()
                    WHERE id = %(job_id)s
                      AND lease_token = %(lease_token)s
                      AND status = 'running'
                      AND lease_expires_at > now()
                    """,
                    {
                        "job_id": lease.id,
                        "lease_token": lease.lease_token,
                        "point_count": point_count,
                        "result": Jsonb(result),
                    },
                )
                if cursor.rowcount != 1:
                    raise LostJobLeaseError(f"job lease is no longer valid: {lease.id}")
                cursor.execute(
                    """
                    INSERT INTO app.audit_logs (
                        organization_id,
                        workspace_id,
                        action,
                        resource_type,
                        resource_id,
                        details
                    )
                    VALUES (
                        %(organization_id)s,
                        %(workspace_id)s,
                        'document.generation_indexed',
                        'document_version',
                        %(resource_id)s,
                        %(details)s
                    )
                    """,
                    {
                        "organization_id": context.organization_id,
                        "workspace_id": context.workspace_id,
                        "resource_id": str(context.document_version_id),
                        "details": Jsonb(result),
                    },
                )

    def prepare_activation(
        self,
        lease: JobLease,
        context: DocumentIngestContext,
    ) -> ActivationPreparation:
        with self._connection.transaction():
            with self._connection.cursor() as cursor:
                self._lock_library_context(cursor, context)
                self._lock_document_key(cursor, context.document_id)
                cursor.execute(
                    """
                    SELECT
                        document.desired_version_id,
                        document.status,
                        version.status,
                        version.generation_id
                    FROM app.documents AS document
                    JOIN app.document_versions AS version
                      ON version.id = %(version_id)s
                     AND version.document_id = document.id
                    WHERE document.id = %(document_id)s
                      AND document.organization_id = %(organization_id)s
                      AND document.workspace_id = %(workspace_id)s
                      AND document.library_id = %(library_id)s
                    FOR UPDATE OF document, version
                    """,
                    {
                        "document_id": context.document_id,
                        "version_id": context.document_version_id,
                        "organization_id": context.organization_id,
                        "workspace_id": context.workspace_id,
                        "library_id": context.library_id,
                    },
                )
                row = cursor.fetchone()
                if row is None:
                    raise StaleDocumentVersionError("document version no longer exists")
                (
                    desired_version_id,
                    document_status,
                    version_status,
                    generation_id,
                ) = row
                self._assert_live_lease(cursor, lease, require_running=True)
                if document_status in {"deleting", "deleted"}:
                    raise StaleDocumentVersionError(
                        f"document cannot activate while status is {document_status}"
                    )
                if (
                    desired_version_id != context.document_version_id
                    or generation_id != context.generation_id
                ):
                    self._complete_superseded(cursor, lease, context)
                    return ActivationPreparation(
                        should_activate=False,
                        superseded=True,
                    )
                if version_status not in {"indexed", "activating"}:
                    raise StaleDocumentVersionError(
                        f"version cannot activate from status {version_status}"
                    )
                cursor.execute(
                    """
                    UPDATE app.document_versions
                    SET status = 'activating',
                        updated_at = now()
                    WHERE id = %(version_id)s
                      AND generation_id = %(generation_id)s
                      AND status IN ('indexed', 'activating')
                    """,
                    {
                        "version_id": context.document_version_id,
                        "generation_id": context.generation_id,
                    },
                )
                if cursor.rowcount != 1:
                    raise StaleDocumentVersionError("version activation CAS failed")
                cursor.execute(
                    """
                    UPDATE app.jobs
                    SET stage = 'activating',
                        progress = greatest(progress, 96),
                        updated_at = now()
                    WHERE id = %(job_id)s
                      AND lease_token = %(lease_token)s
                      AND status = 'running'
                    """,
                    {
                        "job_id": lease.id,
                        "lease_token": lease.lease_token,
                    },
                )
                return ActivationPreparation(
                    should_activate=True,
                    superseded=False,
                )

    def activate_generation(
        self,
        lease: JobLease,
        context: DocumentIngestContext,
    ) -> ActivationResult:
        with self._connection.transaction():
            with self._connection.cursor() as cursor:
                self._lock_library_context(cursor, context)
                self._lock_document_key(cursor, context.document_id)
                cursor.execute(
                    """
                    SELECT
                        document.desired_version_id,
                        document.status,
                        version.status,
                        version.generation_id,
                        active.version_id,
                        previous.generation_id
                    FROM app.documents AS document
                    JOIN app.document_versions AS version
                      ON version.id = %(version_id)s
                     AND version.document_id = document.id
                    LEFT JOIN app.document_active_versions AS active
                      ON active.document_id = document.id
                    LEFT JOIN app.document_versions AS previous
                      ON previous.id = active.version_id
                    WHERE document.id = %(document_id)s
                      AND document.organization_id = %(organization_id)s
                      AND document.workspace_id = %(workspace_id)s
                      AND document.library_id = %(library_id)s
                    FOR UPDATE OF document, version
                    """,
                    {
                        "document_id": context.document_id,
                        "version_id": context.document_version_id,
                        "organization_id": context.organization_id,
                        "workspace_id": context.workspace_id,
                        "library_id": context.library_id,
                    },
                )
                row = cursor.fetchone()
                if row is None:
                    raise StaleDocumentVersionError("document version no longer exists")
                (
                    desired_version_id,
                    document_status,
                    version_status,
                    generation_id,
                    previous_version_id,
                    previous_generation_id,
                ) = row
                self._assert_live_lease(cursor, lease, require_running=True)
                if document_status in {"deleting", "deleted"}:
                    raise StaleDocumentVersionError(
                        f"document cannot activate while status is {document_status}"
                    )
                if (
                    desired_version_id != context.document_version_id
                    or generation_id != context.generation_id
                ):
                    self._complete_superseded(cursor, lease, context)
                    return ActivationResult(activated=False, superseded=True)
                if version_status not in {"indexed", "activating"}:
                    raise StaleDocumentVersionError(
                        f"version cannot activate from status {version_status}"
                    )
                cursor.execute(
                    """
                    SELECT sweep_status
                    FROM rag.generation_cleanup_queue
                    WHERE generation_id = %(generation_id)s
                    FOR UPDATE
                    """,
                    {"generation_id": context.generation_id},
                )
                cleanup_row = cursor.fetchone()
                if cleanup_row is not None:
                    cleanup_status = str(cleanup_row[0])
                    if cleanup_status != "pending":
                        raise StaleDocumentVersionError(
                            "generation cannot activate after cleanup has started"
                        )
                    cursor.execute(
                        """
                        DELETE FROM rag.generation_cleanup_queue
                        WHERE generation_id = %(generation_id)s
                          AND sweep_status = 'pending'
                        """,
                        {"generation_id": context.generation_id},
                    )
                    if cursor.rowcount != 1:
                        raise StaleDocumentVersionError(
                            "generation cleanup cancellation CAS failed"
                        )

                cursor.execute(
                    """
                    INSERT INTO app.document_active_versions (
                        document_id,
                        version_id,
                        activated_at
                    )
                    VALUES (%(document_id)s, %(version_id)s, now())
                    ON CONFLICT (document_id) DO UPDATE
                    SET version_id = excluded.version_id,
                        activated_at = excluded.activated_at
                    """,
                    {
                        "document_id": context.document_id,
                        "version_id": context.document_version_id,
                    },
                )
                cursor.execute(
                    """
                    INSERT INTO rag.active_document_generations (
                        organization_id,
                        workspace_id,
                        library_id,
                        rag_library_id,
                        document_id,
                        document_version_id,
                        generation_id,
                        activated_at
                    )
                    VALUES (
                        %(organization_id)s,
                        %(workspace_id)s,
                        %(library_id)s,
                        %(rag_library_id)s,
                        %(document_id)s,
                        %(version_id)s,
                        %(generation_id)s,
                        now()
                    )
                    ON CONFLICT (organization_id, workspace_id, document_id)
                    DO UPDATE SET
                        library_id = excluded.library_id,
                        rag_library_id = excluded.rag_library_id,
                        document_version_id = excluded.document_version_id,
                        generation_id = excluded.generation_id,
                        activated_at = excluded.activated_at
                    """,
                    {
                        "organization_id": context.organization_id,
                        "workspace_id": context.workspace_id,
                        "library_id": context.library_id,
                        "rag_library_id": context.rag_library_id,
                        "document_id": context.document_id,
                        "version_id": context.document_version_id,
                        "generation_id": context.generation_id,
                    },
                )
                if (
                    previous_version_id is not None
                    and previous_version_id != context.document_version_id
                ):
                    cursor.execute(
                        """
                        UPDATE app.document_versions
                        SET status = 'superseded',
                            superseded_at = now(),
                            updated_at = now()
                        WHERE id = %(previous_version_id)s
                          AND status = 'active'
                        """,
                        {"previous_version_id": previous_version_id},
                    )
                    cursor.execute(
                        """
                        INSERT INTO rag.generation_cleanup_queue (
                            generation_id,
                            organization_id,
                            workspace_id,
                            library_id,
                            document_id,
                            document_version_id
                        )
                        VALUES (
                            %(previous_generation_id)s,
                            %(organization_id)s,
                            %(workspace_id)s,
                            %(library_id)s,
                            %(document_id)s,
                            %(previous_version_id)s
                        )
                        ON CONFLICT (generation_id) DO NOTHING
                        """,
                        {
                            "previous_generation_id": previous_generation_id,
                            "organization_id": context.organization_id,
                            "workspace_id": context.workspace_id,
                            "library_id": context.library_id,
                            "document_id": context.document_id,
                            "previous_version_id": previous_version_id,
                        },
                    )
                cursor.execute(
                    """
                    UPDATE app.document_versions
                    SET status = 'active',
                        activated_at = now(),
                        superseded_at = NULL,
                        failure_code = NULL,
                        error = NULL,
                        updated_at = now()
                    WHERE id = %(version_id)s
                      AND generation_id = %(generation_id)s
                      AND status IN ('indexed', 'activating')
                    """,
                    {
                        "version_id": context.document_version_id,
                        "generation_id": context.generation_id,
                    },
                )
                if cursor.rowcount != 1:
                    raise StaleDocumentVersionError("version activation update failed")
                cursor.execute(
                    """
                    UPDATE app.documents
                    SET status = 'ready',
                        updated_at = now()
                    WHERE id = %(document_id)s
                      AND desired_version_id = %(version_id)s
                      AND status NOT IN ('deleting', 'deleted')
                    """,
                    {
                        "document_id": context.document_id,
                        "version_id": context.document_version_id,
                    },
                )
                if cursor.rowcount != 1:
                    raise StaleDocumentVersionError("document activation CAS failed")
                self._refresh_library_status(cursor, context.library_id)
                activation_result = {
                    "activation": "active",
                    "document_id": str(context.document_id),
                    "document_version_id": str(context.document_version_id),
                    "generation_id": str(context.generation_id),
                    "previous_document_version_id": (
                        str(previous_version_id) if previous_version_id else None
                    ),
                    "previous_generation_id": (
                        str(previous_generation_id) if previous_generation_id else None
                    ),
                }
                cursor.execute(
                    """
                    UPDATE app.jobs
                    SET status = 'completed',
                        stage = 'done',
                        progress = 100,
                        result = coalesce(result, '{}'::jsonb) || %(result)s,
                        error_code = NULL,
                        error = NULL,
                        lease_token = NULL,
                        lease_expires_at = NULL,
                        heartbeat_at = now(),
                        finished_at = now(),
                        updated_at = now()
                    WHERE id = %(job_id)s
                      AND lease_token = %(lease_token)s
                      AND status = 'running'
                      AND lease_expires_at > now()
                    """,
                    {
                        "job_id": lease.id,
                        "lease_token": lease.lease_token,
                        "result": Jsonb(activation_result),
                    },
                )
                if cursor.rowcount != 1:
                    raise LostJobLeaseError(f"job lease is no longer valid: {lease.id}")
                cursor.execute(
                    """
                    INSERT INTO app.audit_logs (
                        organization_id,
                        workspace_id,
                        action,
                        resource_type,
                        resource_id,
                        details
                    )
                    VALUES (
                        %(organization_id)s,
                        %(workspace_id)s,
                        'document.generation_activated',
                        'document_version',
                        %(resource_id)s,
                        %(details)s
                    )
                    """,
                    {
                        "organization_id": context.organization_id,
                        "workspace_id": context.workspace_id,
                        "resource_id": str(context.document_version_id),
                        "details": Jsonb(activation_result),
                    },
                )
                return ActivationResult(
                    activated=True,
                    superseded=False,
                    previous_document_version_id=previous_version_id,
                    previous_generation_id=previous_generation_id,
                )

    def is_generation_active(self, context: DocumentIngestContext) -> bool:
        with self._connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT 1
                FROM rag.active_document_generations
                WHERE organization_id = %(organization_id)s
                  AND workspace_id = %(workspace_id)s
                  AND document_id = %(document_id)s
                  AND document_version_id = %(version_id)s
                  AND generation_id = %(generation_id)s
                """,
                {
                    "organization_id": context.organization_id,
                    "workspace_id": context.workspace_id,
                    "document_id": context.document_id,
                    "version_id": context.document_version_id,
                    "generation_id": context.generation_id,
                },
            )
            return cursor.fetchone() is not None

    def mark_cleanup_hint(
        self,
        *,
        generation_id: UUID,
        applied: bool,
        error: str | None = None,
    ) -> None:
        with self._connection.transaction():
            with self._connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE rag.generation_cleanup_queue
                    SET hint_status = %(status)s,
                        hint_attempts = hint_attempts + 1,
                        last_error = %(error)s,
                        updated_at = now()
                    WHERE generation_id = %(generation_id)s
                    """,
                    {
                        "generation_id": generation_id,
                        "status": "applied" if applied else "error",
                        "error": (error or "")[:8000] or None,
                    },
                )

    def claim_cleanup_due(
        self,
        *,
        capacity: int = 20,
        sweeping_stale_seconds: int = 300,
    ) -> list[GenerationCleanupClaim]:
        """Claim due cleanup rows explicitly owned by the Python sweeper."""
        if capacity < 1:
            raise ValueError("capacity must be positive")
        if sweeping_stale_seconds < 1:
            raise ValueError("sweeping_stale_seconds must be positive")
        with self._connection.transaction():
            with self._connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute(
                    """
                    WITH candidates AS (
                        SELECT queue.generation_id
                        FROM rag.generation_cleanup_queue AS queue
                        WHERE queue.delete_after <= now()
                          AND (
                              queue.sweep_status IN ('pending', 'error')
                              OR (
                                  queue.sweep_status = 'sweeping'
                                  AND queue.sweep_updated_at
                                      <= now()
                                          - make_interval(
                                              secs => %(sweeping_stale_seconds)s
                                          )
                              )
                          )
                          AND NOT EXISTS (
                              SELECT 1
                              FROM rag.active_document_generations AS active
                              WHERE active.generation_id = queue.generation_id
                          )
                          AND queue.execution_engine = 'python'
                          AND queue.cleanup_job_id IS NULL
                        ORDER BY queue.delete_after, queue.generation_id
                        FOR UPDATE OF queue SKIP LOCKED
                        LIMIT %(capacity)s
                    )
                    UPDATE rag.generation_cleanup_queue AS queue
                    SET sweep_status = 'sweeping',
                        sweep_attempts = queue.sweep_attempts + 1,
                        sweep_last_error = NULL,
                        sweep_updated_at = now(),
                        updated_at = now()
                    FROM candidates
                    WHERE queue.generation_id = candidates.generation_id
                    RETURNING
                        queue.generation_id,
                        queue.organization_id,
                        queue.workspace_id,
                        queue.library_id,
                        queue.document_id,
                        queue.document_version_id,
                        queue.delete_after,
                        queue.hint_status,
                        queue.sweep_attempts
                    """,
                    {
                        "capacity": capacity,
                        "sweeping_stale_seconds": sweeping_stale_seconds,
                    },
                )
                return [
                    GenerationCleanupClaim(
                        generation_id=row["generation_id"],
                        organization_id=row["organization_id"],
                        workspace_id=row["workspace_id"],
                        library_id=row["library_id"],
                        document_id=row["document_id"],
                        document_version_id=row["document_version_id"],
                        delete_after=row["delete_after"],
                        hint_status=str(row["hint_status"]),
                        sweep_attempts=int(row["sweep_attempts"]),
                    )
                    for row in cursor.fetchall()
                ]

    def mark_cleanup_swept(
        self,
        *,
        generation_id: UUID,
    ) -> None:
        with self._connection.transaction():
            with self._connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE rag.generation_cleanup_queue
                    SET sweep_status = 'deleted',
                        sweep_last_error = NULL,
                        sweep_updated_at = now(),
                        updated_at = now()
                    WHERE generation_id = %(generation_id)s
                      AND sweep_status = 'sweeping'
                      AND execution_engine = 'python'
                      AND cleanup_job_id IS NULL
                    """,
                    {"generation_id": generation_id},
                )

    def mark_cleanup_sweep_error(
        self,
        *,
        generation_id: UUID,
        error: str,
    ) -> None:
        with self._connection.transaction():
            with self._connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE rag.generation_cleanup_queue
                    SET sweep_status = 'error',
                        sweep_last_error = %(error)s,
                        sweep_updated_at = now(),
                        updated_at = now()
                    WHERE generation_id = %(generation_id)s
                      AND sweep_status = 'sweeping'
                      AND execution_engine = 'python'
                      AND cleanup_job_id IS NULL
                    """,
                    {
                        "generation_id": generation_id,
                        "error": (error or "")[:8000] or "cleanup sweep failed",
                    },
                )

    def load_document_delete_context(self, lease: JobLease) -> DocumentDeleteContext:
        if lease.type != "document.delete":
            raise ValueError("document.delete job required")
        payload = lease.payload if isinstance(lease.payload, dict) else {}
        document_id_raw = payload.get("document_id")
        if not document_id_raw:
            raise ValueError("document.delete job missing document_id")
        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                """
                SELECT
                    job.id AS job_id,
                    job.organization_id,
                    job.workspace_id,
                    document.id AS document_id,
                    document.rag_document_id,
                    document.created_by AS principal_id,
                    library.id AS library_id,
                    library.rag_library_id,
                    library.status AS library_status,
                    coalesce(
                        (
                            SELECT array_agg(version.storage_key)
                            FROM app.document_versions AS version
                            WHERE version.document_id = document.id
                              AND version.storage_key IS NOT NULL
                              AND version.storage_key <> ''
                        ),
                        ARRAY[]::text[]
                    ) AS storage_keys,
                    coalesce(
                        (
                            SELECT array_agg(version.generation_id)
                            FROM app.document_versions AS version
                            WHERE version.document_id = document.id
                        ),
                        ARRAY[]::uuid[]
                    ) AS generation_ids
                FROM app.jobs AS job
                JOIN app.documents AS document
                  ON document.id = %(document_id)s
                 AND document.organization_id = job.organization_id
                 AND document.workspace_id = job.workspace_id
                JOIN app.libraries AS library
                  ON library.id = document.library_id
                WHERE job.id = %(job_id)s
                  AND job.lease_token = %(lease_token)s
                  AND job.status IN ('running', 'cancelling')
                  AND job.lease_expires_at > now()
                """,
                {
                    "job_id": lease.id,
                    "lease_token": lease.lease_token,
                    "document_id": str(document_id_raw),
                },
            )
            row = cursor.fetchone()
        if row is None:
            raise LostJobLeaseError(f"job lease is no longer valid: {lease.id}")
        payload_keys = payload.get("storage_keys") or []
        payload_gens = payload.get("generation_ids") or []
        storage_keys = tuple(
            dict.fromkeys(
                [
                    *(str(key) for key in payload_keys if key),
                    *(str(key) for key in (row["storage_keys"] or []) if key),
                ]
            )
        )
        generation_ids = tuple(
            dict.fromkeys(
                [
                    *(UUID(str(item)) for item in payload_gens if item),
                    *(UUID(str(item)) for item in (row["generation_ids"] or []) if item),
                ]
            )
        )
        return DocumentDeleteContext(
            job_id=row["job_id"],
            organization_id=row["organization_id"],
            workspace_id=row["workspace_id"],
            library_id=row["library_id"],
            document_id=row["document_id"],
            rag_document_id=row["rag_document_id"],
            rag_library_id=row["rag_library_id"],
            library_status=row["library_status"],
            library_delete=bool(payload.get("library_delete")),
            storage_keys=storage_keys,
            generation_ids=generation_ids,
            principal_id=row["principal_id"],
        )

    def complete_document_delete(
        self,
        lease: JobLease,
        context: DocumentDeleteContext,
        *,
        result: dict[str, Any] | None = None,
    ) -> DocumentDeleteCompletion:
        with self._connection.transaction():
            with self._connection.cursor() as cursor:
                self._lock_library_context(cursor, context)
                self._lock_document_key(cursor, context.document_id)
                cursor.execute(
                    """
                    SELECT id
                    FROM app.documents
                    WHERE id = %(document_id)s
                      AND organization_id = %(organization_id)s
                      AND workspace_id = %(workspace_id)s
                      AND library_id = %(library_id)s
                    FOR UPDATE
                    """,
                    {
                        "document_id": context.document_id,
                        "organization_id": context.organization_id,
                        "workspace_id": context.workspace_id,
                        "library_id": context.library_id,
                    },
                )
                if cursor.fetchone() is None:
                    raise StaleDocumentVersionError("document no longer exists")
                self._assert_live_lease(cursor, lease)
                cursor.execute(
                    """
                    UPDATE app.document_versions
                    SET status = 'deleted',
                        updated_at = now()
                    WHERE document_id = %(document_id)s
                      AND status <> 'deleted'
                    """,
                    {"document_id": context.document_id},
                )
                cursor.execute(
                    """
                    DELETE FROM app.document_active_versions
                    WHERE document_id = %(document_id)s
                    """,
                    {"document_id": context.document_id},
                )
                cursor.execute(
                    """
                    DELETE FROM rag.active_document_generations
                    WHERE organization_id = %(organization_id)s
                      AND workspace_id = %(workspace_id)s
                      AND document_id = %(document_id)s
                    """,
                    {
                        "organization_id": context.organization_id,
                        "workspace_id": context.workspace_id,
                        "document_id": context.document_id,
                    },
                )
                cursor.execute(
                    """
                    DELETE FROM rag.generation_cleanup_queue
                    WHERE document_id = %(document_id)s
                    """,
                    {"document_id": context.document_id},
                )
                cursor.execute(
                    """
                    UPDATE app.documents
                    SET status = 'deleted',
                        deleted_at = coalesce(deleted_at, now()),
                        updated_at = now()
                    WHERE id = %(document_id)s
                    """,
                    {"document_id": context.document_id},
                )
                self._refresh_library_status(cursor, context.library_id)
                library_finalized = False
                if context.library_status == "deleting" or context.library_delete:
                    cursor.execute(
                        """
                        SELECT count(*)::integer
                        FROM app.documents
                        WHERE library_id = %(library_id)s
                          AND status NOT IN ('deleted')
                        """,
                        {"library_id": context.library_id},
                    )
                    remaining = int(cursor.fetchone()[0])
                    if remaining == 0:
                        cursor.execute(
                            """
                            UPDATE app.libraries
                            SET status = 'deleted',
                                doc_count = 0,
                                ready_count = 0,
                                updated_at = now()
                            WHERE id = %(library_id)s
                              AND status = 'deleting'
                            """,
                            {"library_id": context.library_id},
                        )
                        if cursor.rowcount == 1:
                            cursor.execute(
                                """
                                INSERT INTO app.outbox_events (
                                    organization_id,
                                    workspace_id,
                                    aggregate_type,
                                    aggregate_id,
                                    event_type,
                                    idempotency_key,
                                    payload,
                                    status,
                                    created_at,
                                    updated_at
                                )
                                VALUES (
                                    %(organization_id)s,
                                    %(workspace_id)s,
                                    'library',
                                    %(rag_library_id)s,
                                    'library.delete',
                                    %(idempotency_key)s,
                                    %(payload)s,
                                    'pending',
                                    now(),
                                    now()
                                )
                                ON CONFLICT (idempotency_key) DO NOTHING
                                """,
                                {
                                    "organization_id": context.organization_id,
                                    "workspace_id": context.workspace_id,
                                    "rag_library_id": context.rag_library_id,
                                    "idempotency_key": (
                                        f"library.delete:{context.rag_library_id}:"
                                        f"{context.document_id}"
                                    ),
                                    "payload": Jsonb(
                                        {
                                            "library_id": context.rag_library_id,
                                            "principal_id": str(
                                                context.principal_id
                                                or context.organization_id
                                            ),
                                        }
                                    ),
                                },
                            )
                            library_finalized = True
                completion = {
                    "deleted": True,
                    "document_id": str(context.document_id),
                    "rag_document_id": context.rag_document_id,
                    "library_finalized": library_finalized,
                    **(result or {}),
                }
                cursor.execute(
                    """
                    UPDATE app.jobs
                    SET status = 'completed',
                        stage = 'done',
                        progress = 100,
                        result = coalesce(result, '{}'::jsonb) || %(result)s,
                        error_code = NULL,
                        error = NULL,
                        lease_token = NULL,
                        lease_expires_at = NULL,
                        heartbeat_at = now(),
                        finished_at = now(),
                        updated_at = now()
                    WHERE id = %(job_id)s
                      AND lease_token = %(lease_token)s
                      AND status IN ('running', 'cancelling')
                      AND lease_expires_at > now()
                    """,
                    {
                        "job_id": lease.id,
                        "lease_token": lease.lease_token,
                        "result": Jsonb(completion),
                    },
                )
                if cursor.rowcount != 1:
                    raise LostJobLeaseError(f"job lease is no longer valid: {lease.id}")
                cursor.execute(
                    """
                    INSERT INTO app.audit_logs (
                        organization_id,
                        workspace_id,
                        action,
                        resource_type,
                        resource_id,
                        details
                    )
                    VALUES (
                        %(organization_id)s,
                        %(workspace_id)s,
                        'document.deleted',
                        'document',
                        %(resource_id)s,
                        %(details)s
                    )
                    """,
                    {
                        "organization_id": context.organization_id,
                        "workspace_id": context.workspace_id,
                        "resource_id": str(context.document_id),
                        "details": Jsonb(completion),
                    },
                )
                return DocumentDeleteCompletion(library_finalized=library_finalized)

    def fail_leased_job(
        self,
        lease: JobLease,
        *,
        error_code: str,
        error: str,
        retryable: bool,
        retry_delay_seconds: int | None = None,
    ) -> JobFailureResult:
        safe_error = error[:8000]
        with self._connection.transaction():
            with self._connection.cursor() as cursor:
                self._assert_live_lease(cursor, lease)
                cursor.execute(
                    """
                    SELECT
                        status,
                        cancel_requested_at IS NOT NULL,
                        attempt,
                        max_attempts
                    FROM app.jobs
                    WHERE id = %(job_id)s
                      AND lease_token = %(lease_token)s
                    FOR UPDATE
                    """,
                    {"job_id": lease.id, "lease_token": lease.lease_token},
                )
                row = cursor.fetchone()
                if row is None:
                    raise LostJobLeaseError(f"job lease is no longer valid: {lease.id}")
                status, cancel_requested, attempt, max_attempts = row
                if status == "cancelling" or cancel_requested:
                    target = JobStatus.CANCELLED
                elif retryable and attempt < max_attempts:
                    target = JobStatus.RETRY
                elif retryable:
                    target = JobStatus.DEAD
                else:
                    target = JobStatus.FAILED
                delay = retry_delay_seconds
                if target == JobStatus.RETRY and delay is None:
                    delay = min(300, 5 * (2 ** max(0, int(attempt) - 1)))
                cursor.execute(
                    """
                    UPDATE app.jobs
                    SET status = %(status)s::varchar(32),
                        next_attempt_at = CASE
                            WHEN %(status)s::varchar(32) = 'retry'
                            THEN now() + make_interval(secs => %(delay)s)
                            ELSE NULL
                        END,
                        error_code = %(error_code)s,
                        error = %(error)s,
                        lease_token = NULL,
                        lease_expires_at = NULL,
                        finished_at = CASE
                            WHEN %(status)s::varchar(32) IN ('cancelled', 'failed', 'dead') THEN now()
                            ELSE NULL
                        END,
                        updated_at = now()
                    WHERE id = %(job_id)s
                      AND lease_token = %(lease_token)s
                    RETURNING next_attempt_at
                    """,
                    {
                        "job_id": lease.id,
                        "lease_token": lease.lease_token,
                        "status": target.value,
                        "delay": delay or 0,
                        "error_code": error_code[:128],
                        "error": safe_error,
                    },
                )
                next_attempt_at = cursor.fetchone()[0]
                return JobFailureResult(status=target, next_attempt_at=next_attempt_at)

    @staticmethod
    def _complete_superseded(
        cursor: Any,
        lease: JobLease,
        context: DocumentIngestContext,
    ) -> None:
        result = {
            "activation": "superseded",
            "document_version_id": str(context.document_version_id),
            "generation_id": str(context.generation_id),
        }
        cursor.execute(
            """
            UPDATE app.document_versions
            SET status = 'superseded',
                superseded_at = now(),
                updated_at = now()
            WHERE id = %(version_id)s
              AND status IN ('pending', 'processing', 'indexed', 'activating')
            """,
            {"version_id": context.document_version_id},
        )
        cursor.execute(
            """
            UPDATE app.jobs
            SET status = 'completed',
                stage = 'done',
                progress = 100,
                result = coalesce(result, '{}'::jsonb) || %(result)s,
                error_code = 'superseded',
                error = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                finished_at = now(),
                updated_at = now()
            WHERE id = %(job_id)s
              AND lease_token = %(lease_token)s
              AND status = 'running'
            """,
            {
                "job_id": lease.id,
                "lease_token": lease.lease_token,
                "result": Jsonb(result),
            },
        )

    def acknowledge_cancel(
        self,
        lease: JobLease,
        context: DocumentIngestContext,
        *,
        result: dict[str, Any] | None = None,
    ) -> None:
        with self._connection.transaction():
            with self._connection.cursor() as cursor:
                self._lock_library_context(cursor, context)
                self._lock_document_key(cursor, context.document_id)
                self._lock_document_version_context(cursor, context)
                self._assert_live_lease(cursor, lease)
                cursor.execute(
                    """
                    UPDATE app.jobs
                    SET status = 'cancelled',
                        result = %(result)s,
                        error_code = 'cancelled',
                        error = NULL,
                        lease_token = NULL,
                        lease_expires_at = NULL,
                        finished_at = now(),
                        updated_at = now()
                    WHERE id = %(job_id)s
                      AND lease_token = %(lease_token)s
                      AND status IN ('running', 'cancelling')
                      AND lease_expires_at > now()
                    """,
                    {
                        "job_id": lease.id,
                        "lease_token": lease.lease_token,
                        "result": Jsonb(result or {}),
                    },
                )
                if cursor.rowcount != 1:
                    raise LostJobLeaseError(f"job lease is no longer valid: {lease.id}")
                self._mark_version_terminal(
                    cursor,
                    context=context,
                    version_status="cancelled",
                    failure_code="cancelled",
                    error=None,
                )

    def fail(
        self,
        lease: JobLease,
        context: DocumentIngestContext,
        *,
        error_code: str,
        error: str,
        retryable: bool,
        retry_delay_seconds: int | None = None,
        parser_report: dict[str, Any] | None = None,
    ) -> JobFailureResult:
        safe_error = error[:8000]
        with self._connection.transaction():
            with self._connection.cursor() as cursor:
                self._lock_library_context(cursor, context)
                self._lock_document_key(cursor, context.document_id)
                self._lock_document_version_context(cursor, context)
                self._assert_live_lease(cursor, lease)
                cursor.execute(
                    """
                    SELECT
                        status,
                        cancel_requested_at IS NOT NULL,
                        attempt,
                        max_attempts
                    FROM app.jobs
                    WHERE id = %(job_id)s
                      AND lease_token = %(lease_token)s
                    FOR UPDATE
                    """,
                    {"job_id": lease.id, "lease_token": lease.lease_token},
                )
                row = cursor.fetchone()
                if row is None:
                    raise LostJobLeaseError(f"job lease is no longer valid: {lease.id}")
                status, cancel_requested, attempt, max_attempts = row
                if parser_report is not None:
                    cursor.execute(
                        """
                        UPDATE app.document_versions
                        SET parser_report = %(parser_report)s,
                            updated_at = now()
                        WHERE id = %(version_id)s
                        """,
                        {
                            "version_id": context.document_version_id,
                            "parser_report": Jsonb(parser_report),
                        },
                    )
                if status == "cancelling" or cancel_requested:
                    target = JobStatus.CANCELLED
                elif retryable and attempt < max_attempts:
                    target = JobStatus.RETRY
                elif retryable:
                    target = JobStatus.DEAD
                else:
                    target = JobStatus.FAILED
                delay = retry_delay_seconds
                if target == JobStatus.RETRY and delay is None:
                    delay = min(300, 5 * (2 ** max(0, int(attempt) - 1)))
                cursor.execute(
                    """
                    UPDATE app.jobs
                    SET status = %(status)s::varchar(32),
                        next_attempt_at = CASE
                            WHEN %(status)s::varchar(32) = 'retry'
                            THEN now() + make_interval(secs => %(delay)s)
                            ELSE NULL
                        END,
                        error_code = %(error_code)s,
                        error = %(error)s,
                        lease_token = NULL,
                        lease_expires_at = NULL,
                        finished_at = CASE
                            WHEN %(status)s::varchar(32) IN ('cancelled', 'failed', 'dead') THEN now()
                            ELSE NULL
                        END,
                        updated_at = now()
                    WHERE id = %(job_id)s
                      AND lease_token = %(lease_token)s
                    RETURNING next_attempt_at
                    """,
                    {
                        "job_id": lease.id,
                        "lease_token": lease.lease_token,
                        "status": target.value,
                        "delay": delay or 0,
                        "error_code": error_code[:128],
                        "error": safe_error,
                    },
                )
                next_attempt_at = cursor.fetchone()[0]
                if target != JobStatus.RETRY:
                    self._mark_version_terminal(
                        cursor,
                        context=context,
                        version_status=(
                            "cancelled" if target == JobStatus.CANCELLED else "failed"
                        ),
                        failure_code=error_code,
                        error=None if target == JobStatus.CANCELLED else safe_error,
                    )
                else:
                    cursor.execute(
                        """
                        UPDATE app.document_versions
                        SET status = CASE
                                WHEN status = 'activating' THEN 'indexed'
                                ELSE status
                            END,
                            error = %(error)s,
                            failure_code = %(error_code)s,
                            updated_at = now()
                        WHERE id = %(version_id)s
                          AND status IN ('processing', 'indexed', 'activating')
                        """,
                        {
                            "version_id": context.document_version_id,
                            "error": safe_error,
                            "error_code": error_code[:128],
                        },
                    )
                return JobFailureResult(status=target, next_attempt_at=next_attempt_at)

    def reap_expired(self, *, limit: int = 100) -> int:
        if limit < 1:
            return 0
        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                """
                SELECT
                    job.id,
                    job.document_version_id,
                    job.organization_id,
                    job.workspace_id,
                    version.document_id,
                    document.library_id
                FROM app.jobs AS job
                LEFT JOIN app.document_versions AS version
                  ON version.id = job.document_version_id
                LEFT JOIN app.documents AS document
                  ON document.id = version.document_id
                WHERE job.status IN ('running', 'cancelling')
                  AND job.execution_engine = 'python'
                  AND job.lease_expires_at <= now()
                ORDER BY
                    document.library_id NULLS LAST,
                    version.document_id NULLS LAST,
                    job.lease_expires_at,
                    job.id
                LIMIT %(limit)s
                """,
                {"limit": limit},
            )
            candidates = cursor.fetchall()

        reaped = 0
        for candidate in candidates:
            with self._connection.transaction():
                with self._connection.cursor(row_factory=dict_row) as cursor:
                    library_id = candidate["library_id"]
                    document_id = candidate["document_id"]
                    version_id = candidate["document_version_id"]
                    if library_id:
                        cursor.execute(
                            """
                            SELECT pg_advisory_xact_lock(
                                hashtextextended(%(library_id)s::text, 0)
                            )
                            """,
                            {"library_id": library_id},
                        )
                        cursor.execute(
                            """
                            SELECT id
                            FROM app.libraries
                            WHERE id = %(library_id)s
                              AND organization_id = %(organization_id)s
                              AND workspace_id = %(workspace_id)s
                            FOR UPDATE
                            """,
                            candidate,
                        )
                        cursor.fetchone()
                    if document_id:
                        self._lock_document_key(cursor, document_id)
                        cursor.execute(
                            """
                            SELECT id
                            FROM app.documents
                            WHERE id = %(document_id)s
                              AND organization_id = %(organization_id)s
                              AND workspace_id = %(workspace_id)s
                            FOR UPDATE
                            """,
                            candidate,
                        )
                        cursor.fetchone()
                    if version_id:
                        cursor.execute(
                            """
                            SELECT id
                            FROM app.document_versions
                            WHERE id = %(document_version_id)s
                              AND document_id = %(document_id)s
                            FOR UPDATE
                            """,
                            candidate,
                        )
                        cursor.fetchone()

                    cursor.execute(
                        """
                        SELECT status, attempt, max_attempts
                        FROM app.jobs
                        WHERE id = %(id)s
                          AND status IN ('running', 'cancelling')
                          AND execution_engine = 'python'
                          AND lease_expires_at <= now()
                        FOR UPDATE SKIP LOCKED
                        """,
                        candidate,
                    )
                    row = cursor.fetchone()
                    if row is None:
                        continue
                    reaped += 1
                    cancelled = row["status"] == "cancelling"
                    exhausted = int(row["attempt"]) >= int(row["max_attempts"])
                    target = (
                        JobStatus.CANCELLED
                        if cancelled
                        else JobStatus.DEAD
                        if exhausted
                        else JobStatus.RETRY
                    )
                    cursor.execute(
                        """
                        UPDATE app.jobs
                        SET status = %(status)s::varchar(32),
                            next_attempt_at = CASE
                                WHEN %(status)s::varchar(32) = 'retry' THEN now()
                                ELSE NULL
                            END,
                            error_code = %(error_code)s,
                            error = %(error)s,
                            lease_token = NULL,
                            lease_expires_at = NULL,
                            finished_at = CASE
                                WHEN %(status)s::varchar(32) IN ('cancelled', 'dead') THEN now()
                                ELSE NULL
                            END,
                            updated_at = now()
                        WHERE id = %(job_id)s
                        """,
                        {
                            "job_id": candidate["id"],
                            "status": target.value,
                            "error_code": (
                                "cancelled"
                                if target == JobStatus.CANCELLED
                                else "lease_expired"
                            ),
                            "error": (
                                None
                                if target == JobStatus.CANCELLED
                                else "worker lease expired"
                            ),
                        },
                    )
                    if target in {JobStatus.CANCELLED, JobStatus.DEAD} and version_id:
                        cursor.execute(
                            """
                            UPDATE app.document_versions
                            SET status = %(status)s,
                                failure_code = %(failure_code)s,
                                error = %(error)s,
                                updated_at = now()
                            WHERE id = %(version_id)s
                              AND status IN (
                                  'pending',
                                  'processing',
                                  'indexed',
                                  'activating'
                              )
                            """,
                            {
                                "version_id": version_id,
                                "status": (
                                    "cancelled"
                                    if target == JobStatus.CANCELLED
                                    else "failed"
                                ),
                                "failure_code": (
                                    "cancelled"
                                    if target == JobStatus.CANCELLED
                                    else "lease_expired"
                                ),
                                "error": (
                                    None
                                    if target == JobStatus.CANCELLED
                                    else "worker lease expired"
                                ),
                            },
                        )
                        if document_id:
                            self._refresh_document_failure_status(
                                cursor,
                                document_id,
                                version_id,
                            )
                        if library_id:
                            self._refresh_library_status(cursor, library_id)
                    elif target == JobStatus.RETRY and version_id:
                        cursor.execute(
                            """
                            UPDATE app.document_versions
                            SET status = CASE
                                    WHEN status = 'activating' THEN 'indexed'
                                    ELSE status
                                END,
                                failure_code = 'lease_expired',
                                error = 'worker lease expired',
                                updated_at = now()
                            WHERE id = %(version_id)s
                              AND status IN ('processing', 'indexed', 'activating')
                            """,
                            {"version_id": version_id},
                        )
        return reaped

    @staticmethod
    def _lock_library_context(
        cursor: Any,
        context: DocumentIngestContext | DocumentDeleteContext,
    ) -> None:
        cursor.execute(
            """
            SELECT pg_advisory_xact_lock(
                hashtextextended(%(library_id)s::text, 0)
            )
            """,
            {"library_id": context.library_id},
        )
        cursor.execute(
            """
            SELECT id
            FROM app.libraries
            WHERE id = %(library_id)s
              AND organization_id = %(organization_id)s
              AND workspace_id = %(workspace_id)s
            FOR UPDATE
            """,
            {
                "library_id": context.library_id,
                "organization_id": context.organization_id,
                "workspace_id": context.workspace_id,
            },
        )
        if cursor.fetchone() is None:
            raise StaleDocumentVersionError("document library no longer exists")

    @staticmethod
    def _lock_document_key(cursor: Any, document_id: UUID) -> None:
        cursor.execute(
            """
            SELECT pg_advisory_xact_lock(
                hashtextextended(%(document_id)s::text, 0)
            )
            """,
            {"document_id": document_id},
        )

    @staticmethod
    def _lock_document_version_context(
        cursor: Any,
        context: DocumentIngestContext,
    ) -> None:
        cursor.execute(
            """
            SELECT document.id
            FROM app.documents AS document
            JOIN app.document_versions AS version
              ON version.id = %(version_id)s
             AND version.document_id = document.id
            WHERE document.id = %(document_id)s
              AND document.organization_id = %(organization_id)s
              AND document.workspace_id = %(workspace_id)s
              AND document.library_id = %(library_id)s
            FOR UPDATE OF document, version
            """,
            {
                "document_id": context.document_id,
                "version_id": context.document_version_id,
                "organization_id": context.organization_id,
                "workspace_id": context.workspace_id,
                "library_id": context.library_id,
            },
        )
        if cursor.fetchone() is None:
            raise StaleDocumentVersionError("document version no longer exists")

    @staticmethod
    def _assert_live_lease(
        cursor: Any,
        lease: JobLease,
        *,
        require_running: bool = False,
    ) -> None:
        statuses = ("running",) if require_running else ("running", "cancelling")
        cursor.execute(
            """
            SELECT 1
            FROM app.jobs
            WHERE id = %(job_id)s
              AND lease_token = %(lease_token)s
              AND status = ANY(%(statuses)s)
              AND lease_expires_at > now()
            FOR UPDATE
            """,
            {
                "job_id": lease.id,
                "lease_token": lease.lease_token,
                "statuses": list(statuses),
            },
        )
        if cursor.fetchone() is None:
            raise LostJobLeaseError(f"job lease is no longer valid: {lease.id}")

    @classmethod
    def _mark_version_terminal(
        cls,
        cursor: Any,
        *,
        context: DocumentIngestContext,
        version_status: str,
        failure_code: str,
        error: str | None,
    ) -> None:
        cursor.execute(
            """
            UPDATE app.document_versions
            SET status = %(status)s,
                failure_code = %(failure_code)s,
                error = %(error)s,
                updated_at = now()
            WHERE id = %(version_id)s
              AND status IN ('pending', 'processing', 'indexed', 'activating')
            """,
            {
                "version_id": context.document_version_id,
                "status": version_status,
                "failure_code": failure_code[:128],
                "error": error,
            },
        )
        cls._refresh_document_failure_status(
            cursor,
            context.document_id,
            context.document_version_id,
        )
        cls._refresh_library_status(cursor, context.library_id)

    @staticmethod
    def _refresh_document_failure_status(
        cursor: Any,
        document_id: UUID,
        document_version_id: UUID,
    ) -> None:
        cursor.execute(
            """
            UPDATE app.documents AS document
            SET status = CASE
                    WHEN active.document_id IS NULL THEN 'failed'
                    ELSE 'degraded'
                END,
                updated_at = now()
            FROM (
                SELECT %(document_id)s::uuid AS target_id
            ) AS target
            LEFT JOIN app.document_active_versions AS active
              ON active.document_id = target.target_id
            WHERE document.id = target.target_id
              AND document.desired_version_id = %(document_version_id)s
              AND document.status NOT IN ('deleting', 'deleted')
            """,
            {
                "document_id": document_id,
                "document_version_id": document_version_id,
            },
        )

    @staticmethod
    def _refresh_library_status(cursor: Any, library_id: UUID) -> None:
        """Recompute the parent summary in the same transaction as document state."""
        cursor.execute(
            """
            UPDATE app.libraries AS library
            SET doc_count = counts.document_count,
                ready_count = counts.ready_count,
                status = CASE
                    WHEN library.status = 'deleting' THEN 'deleting'
                    WHEN counts.document_count = 0 THEN 'empty'
                    WHEN counts.processing_count > 0 THEN 'indexing'
                    WHEN counts.ready_count = counts.document_count THEN 'ready'
                    WHEN counts.ready_count > 0 THEN 'degraded'
                    WHEN counts.failed_count > 0 THEN 'failed'
                    ELSE 'empty'
                END,
                updated_at = now()
            FROM (
                SELECT
                    count(*) FILTER (
                        WHERE status NOT IN ('deleting', 'deleted')
                    )::integer AS document_count,
                    count(*) FILTER (
                        WHERE status IN ('ready', 'degraded')
                    )::integer AS ready_count,
                    count(*) FILTER (
                        WHERE status = 'processing'
                    )::integer AS processing_count,
                    count(*) FILTER (
                        WHERE status = 'failed'
                    )::integer AS failed_count
                FROM app.documents
                WHERE library_id = %(library_id)s
            ) AS counts
            WHERE library.id = %(library_id)s
            """,
            {"library_id": library_id},
        )

    @staticmethod
    def _to_lease(row: dict[str, Any]) -> JobLease:
        lease_token = row["lease_token"]
        lease_expires_at = row["lease_expires_at"]
        if lease_token is None or lease_expires_at is None:
            raise RuntimeError("claimed job did not receive a lease")
        return JobLease(
            id=row["id"],
            organization_id=row["organization_id"],
            workspace_id=row["workspace_id"],
            document_version_id=row["document_version_id"],
            type=row["type"],
            status=JobStatus(row["status"]),
            stage=JobStage(row["stage"]),
            attempt=row["attempt"],
            max_attempts=row["max_attempts"],
            lease_token=lease_token,
            lease_expires_at=lease_expires_at,
            payload=row["payload"],
        )
