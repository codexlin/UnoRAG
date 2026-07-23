"""ARQ worker process: `uv run arq app.worker.WorkerSettings`."""

from __future__ import annotations

from arq.connections import RedisSettings

from app.services.ingest.jobs import ingest_document
from app.settings import get_settings


def _redis_settings() -> RedisSettings:
	return RedisSettings.from_dsn(get_settings().redis_url)


class WorkerSettings:
	functions = [ingest_document]
	redis_settings = _redis_settings()
	max_jobs = get_settings().ingest_worker_max_jobs
	job_timeout = get_settings().ingest_job_timeout_s
	keep_result = 3600
