from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import os
from time import sleep
from uuid import uuid4

import psycopg
import pytest
from psycopg.conninfo import make_conninfo

from app.repositories.job_repository import (
    JobRepository,
    JobStage,
    JobStatus,
    LostJobLeaseError,
    StaleDocumentVersionError,
)
from app.security.access_scope import AccessScope
from app.services.document_metadata_projection import (
    DocumentMetadataProjectionCleaner,
)


DATABASE_URL = os.getenv("JOB_TEST_DATABASE_URL", "").strip()
pytestmark = pytest.mark.skipif(
    not DATABASE_URL,
    reason="JOB_TEST_DATABASE_URL is not configured",
)


@pytest.fixture
def job_scope():
    organization_id = uuid4()
    workspace_id = uuid4()
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        connection.execute(
            """
            INSERT INTO app.organizations (id, slug, name)
            VALUES (%s, %s, 'Job repository test')
            """,
            (organization_id, f"job-test-{organization_id}"),
        )
        connection.execute(
            """
            INSERT INTO app.workspaces (id, organization_id, slug, name)
            VALUES (%s, %s, 'default', 'Default')
            """,
            (workspace_id, organization_id),
        )
        for index in range(2):
            connection.execute(
                """
                INSERT INTO app.jobs (
                    organization_id,
                    workspace_id,
                    type,
                    idempotency_key,
                    payload
                )
                VALUES (%s, %s, 'document.ingest', %s, %s)
                """,
                (
                    organization_id,
                    workspace_id,
                    f"job-test:{organization_id}:{index}",
                    psycopg.types.json.Jsonb({"index": index}),
                ),
            )
    try:
        yield organization_id
    finally:
        with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
            connection.execute(
                "DELETE FROM app.organizations WHERE id = %s",
                (organization_id,),
            )


def test_workers_claim_disjoint_jobs_and_enforce_lease(job_scope):
    organization_id = job_scope
    with (
        psycopg.connect(DATABASE_URL, autocommit=True) as first_connection,
        psycopg.connect(DATABASE_URL, autocommit=True) as second_connection,
    ):
        first_connection.execute("SET ROLE unorag_worker")
        second_connection.execute("SET ROLE unorag_worker")
        first_repository = JobRepository(first_connection)
        second_repository = JobRepository(second_connection)

        first = first_repository.claim(
            worker_id="worker-1",
            job_types=["document.ingest"],
            capacity=1,
        )
        second = second_repository.claim(
            worker_id="worker-2",
            job_types=["document.ingest"],
            capacity=2,
        )

        assert len(first) == 1
        assert len(second) == 1
        assert first[0].id != second[0].id
        assert first[0].attempt == 1
        assert second[0].attempt == 1

        renewed_until = first_repository.heartbeat(
            job_id=first[0].id,
            lease_token=first[0].lease_token,
            stage=JobStage.PARSING,
            progress=20,
            progress_current=1,
            progress_total=5,
        )
        assert renewed_until >= first[0].lease_expires_at

        with pytest.raises(LostJobLeaseError):
            first_repository.heartbeat(
                job_id=first[0].id,
                lease_token=uuid4(),
                stage=JobStage.PARSING,
                progress=30,
            )

        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            first_connection.execute(
                "UPDATE app.organizations SET name = 'forbidden' WHERE id = %s",
                (organization_id,),
            )


def test_python_claim_excludes_dbos_cohort_and_schema_enforces_engine(job_scope):
    organization_id = job_scope
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        workspace_id = connection.execute(
            "SELECT id FROM app.workspaces WHERE organization_id = %s",
            (organization_id,),
        ).fetchone()[0]
        dbos_job_id = uuid4()
        connection.execute(
            """
            INSERT INTO app.jobs (
                id,
                organization_id,
                workspace_id,
                type,
                execution_engine,
                workflow_id,
                dispatched_at,
                idempotency_key
            )
            VALUES (
                %s,
                %s,
                %s,
                'document.ingest',
                'dbos',
                %s,
                now(),
                %s
            )
            """,
            (
                dbos_job_id,
                organization_id,
                workspace_id,
                str(dbos_job_id),
                f"dbos-job:{organization_id}",
            ),
        )
        default_engine = connection.execute(
            """
            SELECT execution_engine
            FROM app.jobs
            WHERE organization_id = %s
              AND id <> %s
            LIMIT 1
            """,
            (organization_id, dbos_job_id),
        ).fetchone()[0]

        assert default_engine == "python"

        repository = JobRepository(connection)
        claimed = repository.claim(
            worker_id="python-worker",
            job_types=["document.ingest"],
            capacity=10,
        )

        assert claimed
        assert dbos_job_id not in {lease.id for lease in claimed}
        assert connection.execute(
            "SELECT status FROM app.jobs WHERE id = %s",
            (dbos_job_id,),
        ).fetchone()[0] == "queued"

        with pytest.raises(psycopg.errors.CheckViolation):
            connection.execute(
                """
                UPDATE app.jobs
                SET execution_engine = 'unknown'
                WHERE id = %s
                """,
                (dbos_job_id,),
            )


def test_lifecycle_constraints_reject_invalid_state_and_cross_document_pointer(
    job_scope,
):
    organization_id = job_scope
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        workspace_id = connection.execute(
            "SELECT id FROM app.workspaces WHERE organization_id = %s",
            (organization_id,),
        ).fetchone()[0]
        job_id = connection.execute(
            "SELECT id FROM app.jobs WHERE organization_id = %s LIMIT 1",
            (organization_id,),
        ).fetchone()[0]

        with pytest.raises(psycopg.errors.CheckViolation):
            connection.execute(
                "UPDATE app.jobs SET status = 'unknown' WHERE id = %s",
                (job_id,),
            )

        library_id = connection.execute(
            """
            INSERT INTO app.libraries (
                organization_id,
                workspace_id,
                rag_library_id,
                name
            )
            VALUES (%s, %s, %s, 'Constraint test')
            RETURNING id
            """,
            (organization_id, workspace_id, f"constraint-{uuid4()}"),
        ).fetchone()[0]
        document_ids = []
        for index in range(2):
            document_ids.append(
                connection.execute(
                    """
                    INSERT INTO app.documents (
                        organization_id,
                        workspace_id,
                        library_id,
                        rag_document_id,
                        name,
                        filename,
                        content_type
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, 'text/markdown')
                    RETURNING id
                    """,
                    (
                        organization_id,
                        workspace_id,
                        library_id,
                        f"doc-{uuid4()}",
                        f"Document {index}",
                        f"document-{index}.md",
                    ),
                ).fetchone()[0]
            )
        foreign_version_id = connection.execute(
            """
            INSERT INTO app.document_versions (
                document_id,
                version,
                content_hash,
                storage_key
            )
            VALUES (%s, 1, %s, %s)
            RETURNING id
            """,
            (document_ids[1], f"sha256:{uuid4()}", f"test/{uuid4()}"),
        ).fetchone()[0]

        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            connection.execute(
                "UPDATE app.documents SET desired_version_id = %s WHERE id = %s",
                (foreign_version_id, document_ids[0]),
            )


@pytest.fixture
def ingest_job_scope():
    organization_id = uuid4()
    workspace_id = uuid4()
    library_id = uuid4()
    document_id = uuid4()
    version_id = uuid4()
    generation_id = uuid4()
    job_id = uuid4()
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        connection.execute(
            """
            INSERT INTO app.organizations (id, slug, name)
            VALUES (%s, %s, 'Lifecycle worker test')
            """,
            (organization_id, f"lifecycle-test-{organization_id}"),
        )
        connection.execute(
            """
            INSERT INTO app.workspaces (id, organization_id, slug, name)
            VALUES (%s, %s, 'default', 'Default')
            """,
            (workspace_id, organization_id),
        )
        connection.execute(
            """
            INSERT INTO app.libraries (
                id,
                organization_id,
                workspace_id,
                rag_library_id,
                name,
                status,
                doc_count
            )
            VALUES (%s, %s, %s, %s, 'Lifecycle library', 'indexing', 1)
            """,
            (library_id, organization_id, workspace_id, f"library-{library_id}"),
        )
        connection.execute(
            """
            INSERT INTO app.documents (
                id,
                organization_id,
                workspace_id,
                library_id,
                rag_document_id,
                name,
                filename,
                content_type
            )
            VALUES (%s, %s, %s, %s, %s, 'Policy', 'policy.md', 'text/markdown')
            """,
            (
                document_id,
                organization_id,
                workspace_id,
                library_id,
                f"document-{document_id}",
            ),
        )
        connection.execute(
            """
            INSERT INTO app.document_versions (
                id,
                document_id,
                version,
                generation_id,
                content_hash,
                storage_key,
                pipeline_version
            )
            VALUES (%s, %s, 1, %s, 'sha256:test', 'test/policy.md', 'test-v1')
            """,
            (version_id, document_id, generation_id),
        )
        connection.execute(
            """
            INSERT INTO app.jobs (
                id,
                organization_id,
                workspace_id,
                document_version_id,
                type,
                max_attempts,
                idempotency_key,
                payload
            )
            VALUES (%s, %s, %s, %s, 'test.document.ingest', 2, %s, %s)
            """,
            (
                job_id,
                organization_id,
                workspace_id,
                version_id,
                f"test-lifecycle:{job_id}",
                psycopg.types.json.Jsonb({}),
            ),
        )
        connection.execute(
            """
            UPDATE app.documents
            SET desired_version_id = %s,
                latest_job_id = %s
            WHERE id = %s
            """,
            (version_id, job_id, document_id),
        )
    try:
        yield {
            "organization_id": organization_id,
            "library_id": library_id,
            "document_id": document_id,
            "version_id": version_id,
            "generation_id": generation_id,
            "job_id": job_id,
        }
    finally:
        with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
            connection.execute(
                "DELETE FROM app.organizations WHERE id = %s",
                (organization_id,),
            )


def test_document_ingest_repository_completes_staging_generation(
    ingest_job_scope,
):
    ids = ingest_job_scope
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        connection.execute("SET ROLE unorag_worker")
        repository = JobRepository(connection)
        [lease] = repository.claim(
            worker_id="lifecycle-worker-1",
            job_types=["test.document.ingest"],
            capacity=1,
        )
        context = repository.load_document_ingest_context(lease)
        repository.begin_document_ingest(lease, context)
        repository.complete_indexing(
            lease,
            context,
            parser_backend="markdown",
            chunk_profile="balanced",
            parser_report={"parser": "markdown"},
            point_count=3,
            chunk_count=1,
            section_count=1,
            table_count=1,
        )
        preparation = repository.prepare_activation(lease, context)
        activation = repository.activate_generation(lease, context)

        job = connection.execute(
            "SELECT status, stage, progress FROM app.jobs WHERE id = %s",
            (ids["job_id"],),
        ).fetchone()
        version = connection.execute(
            """
            SELECT status, point_count, chunk_count, section_count, table_count
            FROM app.document_versions
            WHERE id = %s
            """,
            (ids["version_id"],),
        ).fetchone()
        document = connection.execute(
            """
            SELECT
                status,
                acl_fingerprint,
                projected_acl_fingerprint
            FROM app.documents
            WHERE id = %s
            """,
            (ids["document_id"],),
        ).fetchone()
        active = connection.execute(
            """
            SELECT document_version_id, generation_id
            FROM rag.active_document_generations
            WHERE document_id = %s
            """,
            (ids["document_id"],),
        ).fetchone()

    assert preparation.should_activate is True
    assert activation.activated is True
    assert job == ("completed", "done", 100)
    assert version == ("active", 3, 1, 1, 1)
    assert document == (
        "ready",
        "250f383c79d9c1a77d4b4def892e992dc3d463713270b6d5fb9b41d529e5bd6e",
        "250f383c79d9c1a77d4b4def892e992dc3d463713270b6d5fb9b41d529e5bd6e",
    )
    assert active == (ids["version_id"], ids["generation_id"])


def test_document_write_fence_serializes_and_rejects_deleting_document(
    ingest_job_scope,
):
    ids = ingest_job_scope
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        connection.execute("SET ROLE unorag_worker")
        repository = JobRepository(connection)
        [lease] = repository.claim(
            worker_id="lifecycle-worker-fence",
            job_types=["test.document.ingest"],
            capacity=1,
        )
        context = repository.load_document_ingest_context(lease)

        with repository.document_write_fence(lease, context):
            with psycopg.connect(DATABASE_URL, autocommit=True) as contender:
                acquired = contender.execute(
                    """
                    SELECT pg_try_advisory_lock(
                        hashtextextended(%s::text, 0)
                    )
                    """,
                    (ids["document_id"],),
                ).fetchone()[0]
                assert acquired is False

        with psycopg.connect(DATABASE_URL, autocommit=True) as owner:
            owner.execute(
                "UPDATE app.documents SET status = 'deleting' WHERE id = %s",
                (ids["document_id"],),
            )
        with pytest.raises(LostJobLeaseError):
            with repository.document_write_fence(lease, context):
                pytest.fail("deleting document must not enter the write fence")


def test_begin_ingest_locks_version_before_job(ingest_job_scope):
    ids = ingest_job_scope
    with psycopg.connect(DATABASE_URL, autocommit=True) as setup:
        setup.execute("SET ROLE unorag_worker")
        repository = JobRepository(setup)
        [lease] = repository.claim(
            worker_id="lifecycle-worker-begin-order",
            job_types=["test.document.ingest"],
            capacity=1,
        )
        context = repository.load_document_ingest_context(lease)

    with (
        psycopg.connect(DATABASE_URL) as version_owner,
        ThreadPoolExecutor(max_workers=1) as executor,
    ):
        version_owner.execute(
            "SELECT id FROM app.document_versions WHERE id = %s FOR UPDATE",
            (ids["version_id"],),
        )

        def begin_ingest() -> None:
            with psycopg.connect(DATABASE_URL, autocommit=True) as worker:
                worker.execute("SET ROLE unorag_worker")
                JobRepository(worker).begin_document_ingest(lease, context)

        pending = executor.submit(begin_ingest)
        sleep(0.1)
        with psycopg.connect(DATABASE_URL, autocommit=True) as probe:
            probe.execute(
                "SELECT id FROM app.jobs WHERE id = %s FOR UPDATE NOWAIT",
                (ids["job_id"],),
            )
        version_owner.commit()
        pending.result(timeout=5)


def test_projection_cleaner_uses_worker_role_and_recomputes_library_state():
    tenant_id = str(uuid4())
    workspace_id = str(uuid4())
    library_id = f"projection-library-{uuid4()}"
    document_ids = [f"projection-document-{uuid4()}" for _ in range(2)]
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        connection.execute(
            """
            INSERT INTO public.libraries (
                id, tenant_id, workspace_id, name, status, doc_count, ready_count
            )
            VALUES (%s, %s, %s, 'Projection test', 'ready', 2, 2)
            """,
            (library_id, tenant_id, workspace_id),
        )
        for document_id in document_ids:
            connection.execute(
                """
                INSERT INTO public.documents (
                    id, library_id, tenant_id, workspace_id, name, filename,
                    content_type, status, chunk_count
                )
                VALUES (
                    %s, %s, %s, %s, 'Projection test', 'test.pdf',
                    'application/pdf', 'ready', 1
                )
                """,
                (document_id, library_id, tenant_id, workspace_id),
            )
    try:
        cleaner = DocumentMetadataProjectionCleaner(
            make_conninfo(DATABASE_URL, options="-c role=unorag_worker")
        )
        scope = AccessScope(tenant_id, workspace_id, "worker")
        assert cleaner.delete_document(document_ids[0], scope=scope) is True
        assert cleaner.delete_document(document_ids[1], scope=scope) is True

        with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
            state = connection.execute(
                """
                SELECT status, doc_count, ready_count
                FROM public.libraries
                WHERE id = %s
                """,
                (library_id,),
            ).fetchone()
        assert state == ("empty", 0, 0)
    finally:
        with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
            connection.execute(
                "DELETE FROM public.documents WHERE library_id = %s",
                (library_id,),
            )
            connection.execute(
                "DELETE FROM public.libraries WHERE id = %s",
                (library_id,),
            )


def test_activate_generation_refuses_deleting_document(ingest_job_scope):
    ids = ingest_job_scope
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        connection.execute("SET ROLE unorag_worker")
        repository = JobRepository(connection)
        [lease] = repository.claim(
            worker_id="lifecycle-worker-1",
            job_types=["test.document.ingest"],
            capacity=1,
        )
        context = repository.load_document_ingest_context(lease)
        repository.begin_document_ingest(lease, context)
        repository.complete_indexing(
            lease,
            context,
            parser_backend="markdown",
            chunk_profile="balanced",
            parser_report={"parser": "markdown"},
            point_count=1,
            chunk_count=1,
            section_count=0,
            table_count=0,
        )
        connection.execute(
            """
            UPDATE app.documents
            SET status = 'deleting'
            WHERE id = %s
            """,
            (ids["document_id"],),
        )
        with pytest.raises(StaleDocumentVersionError, match="deleting"):
            repository.prepare_activation(lease, context)
        with pytest.raises(StaleDocumentVersionError, match="deleting"):
            repository.activate_generation(lease, context)


def test_activate_generation_preserves_library_deleting_status(ingest_job_scope):
    ids = ingest_job_scope
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        library_id = connection.execute(
            "SELECT library_id FROM app.documents WHERE id = %s",
            (ids["document_id"],),
        ).fetchone()[0]
        connection.execute(
            "UPDATE app.libraries SET status = 'deleting' WHERE id = %s",
            (library_id,),
        )
        connection.execute("SET ROLE unorag_worker")
        repository = JobRepository(connection)
        [lease] = repository.claim(
            worker_id="lifecycle-worker-1",
            job_types=["test.document.ingest"],
            capacity=1,
        )
        context = repository.load_document_ingest_context(lease)
        repository.begin_document_ingest(lease, context)
        repository.complete_indexing(
            lease,
            context,
            parser_backend="markdown",
            chunk_profile="balanced",
            parser_report={"parser": "markdown"},
            point_count=1,
            chunk_count=1,
            section_count=0,
            table_count=0,
        )
        preparation = repository.prepare_activation(lease, context)
        activation = repository.activate_generation(lease, context)
        library_status = connection.execute(
            "SELECT status FROM app.libraries WHERE id = %s",
            (library_id,),
        ).fetchone()[0]

    assert preparation.should_activate is True
    assert activation.activated is True
    assert library_status == "deleting"


def test_activate_generation_refuses_acl_changed_after_staging(ingest_job_scope):
    ids = ingest_job_scope
    principal_id = uuid4()
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        connection.execute("SET ROLE unorag_worker")
        repository = JobRepository(connection)
        [lease] = repository.claim(
            worker_id="lifecycle-worker-acl-race",
            job_types=["test.document.ingest"],
            capacity=1,
        )
        context = repository.load_document_ingest_context(lease)
        repository.begin_document_ingest(lease, context)
        repository.complete_indexing(
            lease,
            context,
            parser_backend="markdown",
            chunk_profile="balanced",
            parser_report={"parser": "markdown"},
            point_count=1,
            chunk_count=1,
            section_count=0,
            table_count=0,
        )
        assert repository.prepare_activation(lease, context).should_activate is True

        connection.execute("RESET ROLE")
        connection.execute(
            """
            INSERT INTO app.document_acl (
                document_id,
                subject_type,
                subject_id,
                permission
            )
            VALUES (%s, 'principal', %s, 'read')
            """,
            (ids["document_id"], principal_id),
        )
        connection.execute("SET ROLE unorag_worker")

        with pytest.raises(
            StaleDocumentVersionError,
            match="ACL changed",
        ):
            repository.activate_generation(lease, context)

        active = connection.execute(
            """
            SELECT 1
            FROM rag.active_document_generations
            WHERE generation_id = %s
            """,
            (ids["generation_id"],),
        ).fetchone()

    assert active is None


def test_activate_generation_refuses_cleanup_that_has_started(ingest_job_scope):
    ids = ingest_job_scope
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        connection.execute("SET ROLE unorag_worker")
        repository = JobRepository(connection)
        [lease] = repository.claim(
            worker_id="lifecycle-worker-1",
            job_types=["test.document.ingest"],
            capacity=1,
        )
        context = repository.load_document_ingest_context(lease)
        repository.begin_document_ingest(lease, context)
        repository.complete_indexing(
            lease,
            context,
            parser_backend="markdown",
            chunk_profile="balanced",
            parser_report={"parser": "markdown"},
            point_count=1,
            chunk_count=1,
            section_count=0,
            table_count=0,
        )
        assert repository.prepare_activation(lease, context).should_activate is True
        connection.execute("RESET ROLE")
        connection.execute(
            """
            INSERT INTO rag.generation_cleanup_queue (
                generation_id,
                organization_id,
                workspace_id,
                library_id,
                document_id,
                document_version_id,
                delete_after,
                sweep_status
            )
            SELECT
                version.generation_id,
                document.organization_id,
                document.workspace_id,
                document.library_id,
                document.id,
                version.id,
                now(),
                'sweeping'
            FROM app.document_versions AS version
            JOIN app.documents AS document ON document.id = version.document_id
            WHERE version.id = %s
            """,
            (ids["version_id"],),
        )
        connection.execute("SET ROLE unorag_worker")

        with pytest.raises(
            StaleDocumentVersionError,
            match="cleanup has started",
        ):
            repository.activate_generation(lease, context)

        active = connection.execute(
            """
            SELECT 1
            FROM rag.active_document_generations
            WHERE generation_id = %s
            """,
            (ids["generation_id"],),
        ).fetchone()

    assert active is None


def test_expired_leases_retry_then_dead(ingest_job_scope):
    ids = ingest_job_scope
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        connection.execute("SET ROLE unorag_worker")
        repository = JobRepository(connection)

        [first] = repository.claim(
            worker_id="lifecycle-worker-1",
            job_types=["test.document.ingest"],
            capacity=1,
        )
        context = repository.load_document_ingest_context(first)
        repository.begin_document_ingest(first, context)
        connection.execute(
            "UPDATE app.jobs SET lease_expires_at = now() - interval '1 second' WHERE id = %s",
            (ids["job_id"],),
        )
        assert repository.reap_expired() == 1
        status = connection.execute(
            "SELECT status FROM app.jobs WHERE id = %s",
            (ids["job_id"],),
        ).fetchone()[0]
        retry_document_status = connection.execute(
            "SELECT status FROM app.documents WHERE id = %s",
            (ids["document_id"],),
        ).fetchone()[0]
        retry_library = connection.execute(
            "SELECT status, ready_count, doc_count FROM app.libraries WHERE id = %s",
            (ids["library_id"],),
        ).fetchone()
        assert status == JobStatus.RETRY.value
        assert retry_document_status == "processing"
        assert retry_library == ("indexing", 0, 1)

        [second] = repository.claim(
            worker_id="lifecycle-worker-2",
            job_types=["test.document.ingest"],
            capacity=1,
        )
        assert second.attempt == 2
        connection.execute(
            "UPDATE app.jobs SET lease_expires_at = now() - interval '1 second' WHERE id = %s",
            (ids["job_id"],),
        )
        assert repository.reap_expired() == 1
        job_status = connection.execute(
            "SELECT status FROM app.jobs WHERE id = %s",
            (ids["job_id"],),
        ).fetchone()[0]
        version_status = connection.execute(
            "SELECT status FROM app.document_versions WHERE id = %s",
            (ids["version_id"],),
        ).fetchone()[0]
        document_status = connection.execute(
            "SELECT status FROM app.documents WHERE id = %s",
            (ids["document_id"],),
        ).fetchone()[0]
        library = connection.execute(
            "SELECT status, ready_count, doc_count FROM app.libraries WHERE id = %s",
            (ids["library_id"],),
        ).fetchone()

    assert job_status == JobStatus.DEAD.value
    assert version_status == "failed"
    assert document_status == "failed"
    assert library == ("failed", 0, 1)


def test_expired_lease_reaper_locks_library_before_ingest_job(ingest_job_scope):
    ids = ingest_job_scope
    with psycopg.connect(DATABASE_URL, autocommit=True) as setup:
        setup.execute("SET ROLE unorag_worker")
        repository = JobRepository(setup)
        [lease] = repository.claim(
            worker_id="lifecycle-worker-reaper-order",
            job_types=["test.document.ingest"],
            capacity=1,
        )
        repository.begin_document_ingest(
            lease,
            repository.load_document_ingest_context(lease),
        )
        setup.execute(
            """
            UPDATE app.jobs
            SET lease_expires_at = now() - interval '1 second'
            WHERE id = %s
            """,
            (ids["job_id"],),
        )

    with (
        psycopg.connect(DATABASE_URL) as library_owner,
        ThreadPoolExecutor(max_workers=1) as executor,
    ):
        library_owner.execute(
            "SELECT id FROM app.libraries WHERE id = %s FOR UPDATE",
            (ids["library_id"],),
        )

        def reap() -> int:
            with psycopg.connect(DATABASE_URL, autocommit=True) as worker:
                worker.execute("SET ROLE unorag_worker")
                return JobRepository(worker).reap_expired()

        pending = executor.submit(reap)
        sleep(0.1)
        with psycopg.connect(DATABASE_URL, autocommit=True) as probe:
            probe.execute(
                "SELECT id FROM app.jobs WHERE id = %s FOR UPDATE NOWAIT",
                (ids["job_id"],),
            )
        library_owner.commit()
        assert pending.result(timeout=5) == 1


def test_terminal_ingest_failure_refreshes_parent_library(ingest_job_scope):
    ids = ingest_job_scope
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        connection.execute("SET ROLE unorag_worker")
        repository = JobRepository(connection)
        [lease] = repository.claim(
            worker_id="lifecycle-worker-failure",
            job_types=["test.document.ingest"],
            capacity=1,
        )
        context = repository.load_document_ingest_context(lease)
        repository.begin_document_ingest(lease, context)
        failure = repository.fail(
            lease,
            context,
            error_code="parse_failed",
            error="fixture parse failed",
            retryable=False,
        )
        document = connection.execute(
            "SELECT status FROM app.documents WHERE id = %s",
            (ids["document_id"],),
        ).fetchone()
        library = connection.execute(
            "SELECT status, ready_count, doc_count FROM app.libraries WHERE id = %s",
            (ids["library_id"],),
        ).fetchone()

    assert failure.status == JobStatus.FAILED
    assert document == ("failed",)
    assert library == ("failed", 0, 1)


def test_late_job_is_superseded_before_activation(ingest_job_scope):
    ids = ingest_job_scope
    with psycopg.connect(DATABASE_URL, autocommit=True) as worker_connection:
        worker_connection.execute("SET ROLE unorag_worker")
        repository = JobRepository(worker_connection)
        [lease] = repository.claim(
            worker_id="lifecycle-worker-late",
            job_types=["test.document.ingest"],
            capacity=1,
        )
        context = repository.load_document_ingest_context(lease)
        repository.begin_document_ingest(lease, context)
        repository.complete_indexing(
            lease,
            context,
            parser_backend="markdown",
            chunk_profile="balanced",
            parser_report={"parser": "markdown"},
            point_count=2,
            chunk_count=1,
            section_count=1,
            table_count=0,
        )

        newer_version_id = uuid4()
        newer_job_id = uuid4()
        with psycopg.connect(DATABASE_URL, autocommit=True) as owner_connection:
            owner_connection.execute(
                """
                INSERT INTO app.document_versions (
                    id,
                    document_id,
                    version,
                    generation_id,
                    content_hash,
                    storage_key,
                    pipeline_version
                )
                VALUES (%s, %s, 2, %s, 'sha256:new', 'test/new.md', 'test-v1')
                """,
                (newer_version_id, ids["document_id"], uuid4()),
            )
            owner_connection.execute(
                """
                INSERT INTO app.jobs (
                    id,
                    organization_id,
                    workspace_id,
                    document_version_id,
                    type,
                    idempotency_key,
                    payload
                )
                SELECT
                    %s,
                    organization_id,
                    workspace_id,
                    %s,
                    'test.document.ingest',
                    %s,
                    '{}'::jsonb
                FROM app.jobs
                WHERE id = %s
                """,
                (
                    newer_job_id,
                    newer_version_id,
                    f"test-newer:{newer_job_id}",
                    ids["job_id"],
                ),
            )
            owner_connection.execute(
                """
                UPDATE app.documents
                SET desired_version_id = %s,
                    latest_job_id = %s
                WHERE id = %s
                """,
                (newer_version_id, newer_job_id, ids["document_id"]),
            )

        preparation = repository.prepare_activation(lease, context)
        old_job = worker_connection.execute(
            "SELECT status, stage, error_code FROM app.jobs WHERE id = %s",
            (ids["job_id"],),
        ).fetchone()
        old_version_status = worker_connection.execute(
            "SELECT status FROM app.document_versions WHERE id = %s",
            (ids["version_id"],),
        ).fetchone()[0]
        active_count = worker_connection.execute(
            """
            SELECT count(*)
            FROM rag.active_document_generations
            WHERE document_id = %s
            """,
            (ids["document_id"],),
        ).fetchone()[0]

    assert preparation.should_activate is False
    assert preparation.superseded is True
    assert old_job == ("completed", "done", "superseded")
    assert old_version_status == "superseded"
    assert active_count == 0


def test_claim_cleanup_due_skips_active_and_marks_sweep(ingest_job_scope):
    ids = ingest_job_scope
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        has_sweep = connection.execute(
            """
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'rag'
              AND table_name = 'generation_cleanup_queue'
              AND column_name = 'sweep_status'
            """
        ).fetchone()
        if has_sweep is None:
            pytest.skip("rag.generation_cleanup_queue.sweep_status not migrated")

        inactive_generation_id = uuid4()
        dbos_generation_id = uuid4()
        dbos_cleanup_job_id = uuid4()
        active_generation_id = ids["generation_id"]
        connection.execute(
            """
            INSERT INTO rag.generation_cleanup_queue (
                generation_id,
                organization_id,
                workspace_id,
                library_id,
                document_id,
                document_version_id,
                delete_after
            )
            SELECT
                %s,
                document.organization_id,
                document.workspace_id,
                document.library_id,
                document.id,
                %s,
                now() - interval '1 minute'
            FROM app.documents AS document
            WHERE document.id = %s
            """,
            (inactive_generation_id, ids["version_id"], ids["document_id"]),
        )
        connection.execute(
            """
            INSERT INTO rag.generation_cleanup_queue (
                generation_id,
                organization_id,
                workspace_id,
                library_id,
                document_id,
                document_version_id,
                delete_after
            )
            SELECT
                %s,
                document.organization_id,
                document.workspace_id,
                document.library_id,
                document.id,
                %s,
                now() - interval '1 minute'
            FROM app.documents AS document
            WHERE document.id = %s
            """,
            (dbos_generation_id, ids["version_id"], ids["document_id"]),
        )
        connection.execute(
            """
            INSERT INTO app.jobs (
                id,
                organization_id,
                workspace_id,
                type,
                execution_engine,
                workflow_id,
                idempotency_key,
                payload
            )
            SELECT
                %s,
                document.organization_id,
                document.workspace_id,
                'generation.cleanup',
                'dbos',
                %s,
                %s,
                jsonb_build_object('generation_id', %s::text)
            FROM app.documents AS document
            WHERE document.id = %s
            """,
            (
                dbos_cleanup_job_id,
                str(dbos_cleanup_job_id),
                f"cleanup-job:{dbos_generation_id}",
                dbos_generation_id,
                ids["document_id"],
            ),
        )
        connection.execute(
            """
            UPDATE rag.generation_cleanup_queue
            SET execution_engine = 'dbos',
                cleanup_job_id = %s
            WHERE generation_id = %s
            """,
            (dbos_cleanup_job_id, dbos_generation_id),
        )
        connection.execute(
            """
            INSERT INTO rag.active_document_generations (
                organization_id,
                workspace_id,
                library_id,
                rag_library_id,
                document_id,
                document_version_id,
                generation_id
            )
            SELECT
                document.organization_id,
                document.workspace_id,
                document.library_id,
                library.rag_library_id,
                document.id,
                %s,
                %s
            FROM app.documents AS document
            JOIN app.libraries AS library ON library.id = document.library_id
            WHERE document.id = %s
            """,
            (ids["version_id"], active_generation_id, ids["document_id"]),
        )
        connection.execute(
            """
            INSERT INTO rag.generation_cleanup_queue (
                generation_id,
                organization_id,
                workspace_id,
                library_id,
                document_id,
                document_version_id,
                delete_after
            )
            SELECT
                %s,
                document.organization_id,
                document.workspace_id,
                document.library_id,
                document.id,
                %s,
                now() - interval '1 minute'
            FROM app.documents AS document
            WHERE document.id = %s
            ON CONFLICT (generation_id) DO NOTHING
            """,
            (active_generation_id, ids["version_id"], ids["document_id"]),
        )

        connection.execute("SET ROLE unorag_worker")
        repository = JobRepository(connection)
        claims = repository.claim_cleanup_due(capacity=10)
        claimed_ids = {claim.generation_id for claim in claims}
        assert inactive_generation_id in claimed_ids
        assert dbos_generation_id not in claimed_ids
        assert active_generation_id not in claimed_ids

        dbos_sweep_status = connection.execute(
            """
            SELECT sweep_status
            FROM rag.generation_cleanup_queue
            WHERE generation_id = %s
            """,
            (dbos_generation_id,),
        ).fetchone()[0]
        assert dbos_sweep_status == "pending"

        repository.mark_cleanup_swept(generation_id=inactive_generation_id)
        status = connection.execute(
            """
            SELECT sweep_status
            FROM rag.generation_cleanup_queue
            WHERE generation_id = %s
            """,
            (inactive_generation_id,),
        ).fetchone()[0]
        assert status == "deleted"
