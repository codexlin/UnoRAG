"""One-shot / loop ops entrypoint for generation cleanup sweeps.

Run once::

    uv run python -m app.generation_cleanup_sweeper

Continuous loop (optional)::

    LIFECYCLE_CLEANUP_LOOP=1 uv run python -m app.generation_cleanup_sweeper
"""

from __future__ import annotations

import logging
import os
import signal
import socket
import threading
from types import FrameType

import psycopg

from app.repositories.job_repository import JobRepository
from app.settings import get_settings
from app.workers.generation_cleanup import GenerationCleanupSweeper

logger = logging.getLogger(__name__)


def main() -> None:
	logging.basicConfig(
		level=os.getenv("LOG_LEVEL", "INFO").upper(),
		format="%(asctime)s %(levelname)s %(name)s %(message)s",
	)
	settings = get_settings()
	if not settings.worker_database_dsn:
		raise SystemExit("WORKER_DATABASE_URL is required")
	if not settings.lifecycle_cleanup_enabled:
		raise SystemExit("LIFECYCLE_CLEANUP_ENABLED is false")

	loop = os.getenv("LIFECYCLE_CLEANUP_LOOP", "").strip().lower() in {
		"1",
		"true",
		"yes",
	}
	poll_seconds = max(1.0, settings.lifecycle_worker_poll_seconds)
	worker_id = (
		os.getenv("LIFECYCLE_WORKER_ID", "").strip()
		or f"cleanup:{socket.gethostname()}:{os.getpid()}"
	)
	stop_event = threading.Event()

	def stop(_signum: int, _frame: FrameType | None) -> None:
		stop_event.set()

	signal.signal(signal.SIGINT, stop)
	signal.signal(signal.SIGTERM, stop)

	logger.info(
		"generation_cleanup_sweeper.start worker_id=%s loop=%s",
		worker_id,
		loop,
	)
	with psycopg.connect(settings.worker_database_dsn, autocommit=True) as connection:
		repository = JobRepository(connection)
		sweeper = GenerationCleanupSweeper(settings, repository)
		while not stop_event.is_set():
			result = sweeper.run_once()
			if result.claimed:
				logger.info(
					"generation_cleanup_sweeper.batch claimed=%s deleted=%s errors=%s",
					result.claimed,
					result.deleted,
					result.errors,
				)
			if not loop:
				break
			stop_event.wait(poll_seconds)
	logger.info("generation_cleanup_sweeper.stop worker_id=%s", worker_id)


if __name__ == "__main__":
	main()
