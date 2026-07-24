"""PostgreSQL lifecycle worker.

Run with: ``uv run python -m app.lifecycle_worker``.
"""

from __future__ import annotations

import logging
import os
import signal
import socket
import threading
import time
from types import FrameType

import psycopg

from app.repositories.job_repository import (
	CancelRequestedError,
	JobLease,
	JobRepository,
	JobStage,
	LostJobLeaseError,
)
from app.settings import Settings, get_settings
from app.workers.document_ingest import DocumentIngestProcessor

logger = logging.getLogger(__name__)


class LeaseController:
	def __init__(
		self,
		*,
		database_dsn: str,
		repository: JobRepository,
		lease: JobLease,
		lease_seconds: int,
		heartbeat_seconds: int,
	) -> None:
		self.database_dsn = database_dsn
		self.repository = repository
		self.lease = lease
		self.lease_seconds = lease_seconds
		self.heartbeat_seconds = heartbeat_seconds
		self._stage = lease.stage
		self._progress = 0
		self._current: int | None = None
		self._total: int | None = None
		self._state_lock = threading.Lock()
		self._stop = threading.Event()
		self._failure: Exception | None = None
		self._thread = threading.Thread(
			target=self._heartbeat_loop,
			name=f"lease-{lease.id}",
			daemon=True,
		)

	def __enter__(self) -> "LeaseController":
		self._thread.start()
		return self

	def __exit__(self, *_args: object) -> None:
		self._stop.set()
		self._thread.join(timeout=max(1.0, self.heartbeat_seconds + 1.0))

	def checkpoint(
		self,
		stage: JobStage,
		progress: int,
		*,
		current: int | None = None,
		total: int | None = None,
	) -> None:
		self._raise_background_failure()
		self.repository.heartbeat(
			job_id=self.lease.id,
			lease_token=self.lease.lease_token,
			stage=stage,
			progress=progress,
			progress_current=current,
			progress_total=total,
			lease_seconds=self.lease_seconds,
		)
		with self._state_lock:
			self._stage = stage
			self._progress = progress
			self._current = current
			self._total = total
		if self.repository.cancellation_requested(self.lease):
			raise CancelRequestedError(f"job cancellation requested: {self.lease.id}")
		self._raise_background_failure()

	def _heartbeat_loop(self) -> None:
		try:
			with psycopg.connect(self.database_dsn, autocommit=True) as connection:
				repository = JobRepository(connection)
				while not self._stop.wait(self.heartbeat_seconds):
					with self._state_lock:
						stage = self._stage
						progress = self._progress
						current = self._current
						total = self._total
					repository.heartbeat(
						job_id=self.lease.id,
						lease_token=self.lease.lease_token,
						stage=stage,
						progress=progress,
						progress_current=current,
						progress_total=total,
						lease_seconds=self.lease_seconds,
					)
					if repository.cancellation_requested(self.lease):
						self._failure = CancelRequestedError(
							f"job cancellation requested: {self.lease.id}"
						)
		except Exception as exc:
			if not self._stop.is_set():
				self._failure = exc

	def _raise_background_failure(self) -> None:
		if self._failure is not None:
			if isinstance(self._failure, CancelRequestedError):
				raise self._failure
			raise LostJobLeaseError(
				f"background heartbeat failed for job {self.lease.id}"
			) from self._failure


class LifecycleWorker:
	def __init__(self, settings: Settings) -> None:
		if not settings.worker_database_dsn:
			raise ValueError("WORKER_DATABASE_URL is required")
		if not settings.document_storage_root.strip():
			raise ValueError("DOCUMENT_STORAGE_ROOT is required")
		if settings.lifecycle_worker_heartbeat_seconds < 1:
			raise ValueError("LIFECYCLE_WORKER_HEARTBEAT_SECONDS must be positive")
		if (
			settings.lifecycle_worker_lease_seconds
			< settings.lifecycle_worker_heartbeat_seconds * 2
		):
			raise ValueError(
				"LIFECYCLE_WORKER_LEASE_SECONDS must be at least twice heartbeat seconds"
			)
		self.settings = settings
		self.worker_id = (
			os.getenv("LIFECYCLE_WORKER_ID", "").strip()
			or f"{socket.gethostname()}:{os.getpid()}"
		)
		self.stop_event = threading.Event()

	def request_stop(self) -> None:
		self.stop_event.set()

	def run(self) -> None:
		logger.info(
			"lifecycle_worker.start worker_id=%s version=%s",
			self.worker_id,
			self.settings.lifecycle_worker_version,
		)
		with psycopg.connect(
			self.settings.worker_database_dsn,
			autocommit=True,
		) as connection:
			repository = JobRepository(connection)
			processor = DocumentIngestProcessor(self.settings, repository)
			while not self.stop_event.is_set():
				reaped = repository.reap_expired()
				if reaped:
					logger.warning("lifecycle_worker.reaped count=%s", reaped)
				leases = repository.claim(
					worker_id=self.worker_id,
					job_types=["document.ingest"],
					capacity=1,
					lease_seconds=self.settings.lifecycle_worker_lease_seconds,
					worker_version=self.settings.lifecycle_worker_version,
				)
				if not leases:
					self.stop_event.wait(self.settings.lifecycle_worker_poll_seconds)
					continue
				lease = leases[0]
				try:
					with LeaseController(
						database_dsn=self.settings.worker_database_dsn,
						repository=repository,
						lease=lease,
						lease_seconds=self.settings.lifecycle_worker_lease_seconds,
						heartbeat_seconds=self.settings.lifecycle_worker_heartbeat_seconds,
					) as progress:
						result = processor.process(lease, progress)
					logger.info(
						"lifecycle_worker.completed job_id=%s generation_id=%s "
						"points=%s activated=%s superseded=%s",
						result.job_id,
						result.generation_id,
						result.point_count,
						result.activated,
						result.superseded,
					)
				except CancelRequestedError:
					logger.info("lifecycle_worker.cancelled job_id=%s", lease.id)
				except LostJobLeaseError:
					logger.warning(
						"lifecycle_worker.lease_lost job_id=%s",
						lease.id,
						exc_info=True,
					)
				except Exception:
					# The processor has already transitioned the leased job to
					# retry/failed/dead with a bounded error payload.
					logger.exception("lifecycle_worker.job_failed job_id=%s", lease.id)
		logger.info("lifecycle_worker.stop worker_id=%s", self.worker_id)


def main() -> None:
	logging.basicConfig(
		level=os.getenv("LOG_LEVEL", "INFO").upper(),
		format="%(asctime)s %(levelname)s %(name)s %(message)s",
	)
	worker = LifecycleWorker(get_settings())

	def stop(_signum: int, _frame: FrameType | None) -> None:
		worker.request_stop()

	signal.signal(signal.SIGINT, stop)
	signal.signal(signal.SIGTERM, stop)
	worker.run()


if __name__ == "__main__":
	main()
