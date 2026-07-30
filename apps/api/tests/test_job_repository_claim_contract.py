"""Static contract for ownership of Python lifecycle claims."""

from __future__ import annotations

from contextlib import nullcontext
from typing import Any

from app.repositories.job_repository import JobRepository


class _Cursor:
    def __init__(self) -> None:
        self.statement = ""
        self.parameters: dict[str, Any] = {}

    def __enter__(self) -> "_Cursor":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, statement: str, parameters: dict[str, Any]) -> None:
        self.statement = statement
        self.parameters = parameters

    def fetchall(self) -> list[dict[str, Any]]:
        return []


class _Connection:
    def __init__(self) -> None:
        self.last_cursor: _Cursor | None = None

    def transaction(self) -> nullcontext[None]:
        return nullcontext()

    def cursor(self, **_kwargs: object) -> _Cursor:
        self.last_cursor = _Cursor()
        return self.last_cursor


def test_python_claim_query_excludes_dbos_jobs() -> None:
    connection = _Connection()
    repository = JobRepository(connection)  # type: ignore[arg-type]

    assert (
        repository.claim(
            worker_id="python-worker",
            job_types=["document.ingest"],
            capacity=1,
        )
        == []
    )

    assert connection.last_cursor is not None
    assert "AND execution_engine = 'python'" in connection.last_cursor.statement


def test_python_cleanup_claim_excludes_dbos_owned_generation() -> None:
    connection = _Connection()
    repository = JobRepository(connection)  # type: ignore[arg-type]

    assert repository.claim_cleanup_due(capacity=1) == []

    assert connection.last_cursor is not None
    statement = connection.last_cursor.statement
    assert "queue.execution_engine = 'python'" in statement
    assert "queue.cleanup_job_id IS NULL" in statement


def test_python_lease_reaper_excludes_dbos_jobs() -> None:
    connection = _Connection()
    repository = JobRepository(connection)  # type: ignore[arg-type]

    assert repository.reap_expired(limit=1) == 0

    assert connection.last_cursor is not None
    assert (
        "AND job.execution_engine = 'python'"
        in connection.last_cursor.statement
    )
