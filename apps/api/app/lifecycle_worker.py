"""PostgreSQL lifecycle worker.

Run with: ``uv run python -m app.lifecycle_worker``.

Ingest slotting (payload.queue_class):
- ``LIFECYCLE_LOCAL_CAPACITY`` (default 2): concurrent local/auto jobs
- ``LIFECYCLE_MINERU_CAPACITY`` (default 1): concurrent mineru jobs

When mineru slots are full, claim only ``local`` so docx continues while a
MinerU PDF holds its slot. See ``app.services.ingest.queue_class``.
"""

from __future__ import annotations

import logging
import os
import signal
import socket
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
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
from app.workers.document_delete import DocumentDeleteProcessor
from app.workers.document_ingest import DocumentIngestProcessor
from app.workers.generation_cleanup import GenerationCleanupSweeper

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


def _lease_queue_class(lease: JobLease) -> str:
	payload = lease.payload if isinstance(lease.payload, dict) else {}
	raw = str(payload.get("queue_class") or "").strip().lower()
	if raw in {"local", "auto", "mineru"}:
		return raw
	if lease.type == "document.delete":
		return "local"
	return "local"


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
		if settings.lifecycle_local_capacity < 1:
			raise ValueError("LIFECYCLE_LOCAL_CAPACITY must be positive")
		if settings.lifecycle_mineru_capacity < 1:
			raise ValueError("LIFECYCLE_MINERU_CAPACITY must be positive")
		if (
			settings.mineru_enabled
			and settings.resolved_mineru_provider == "302ai"
			and not settings.mineru_302_api_key.strip()
		):
			raise ValueError(
				"302 MinerU lifecycle worker requires MINERU_302_API_KEY"
			)
		self.settings = settings
		self.worker_id = (
			os.getenv("LIFECYCLE_WORKER_ID", "").strip()
			or f"{socket.gethostname()}:{os.getpid()}"
		)
		self.stop_event = threading.Event()
		self._local_capacity = int(settings.lifecycle_local_capacity)
		self._mineru_capacity = int(settings.lifecycle_mineru_capacity)
		self._inflight_lock = threading.Lock()
		self._inflight_local = 0
		self._inflight_mineru = 0

	def request_stop(self) -> None:
		self.stop_event.set()

	def _slot_kind(self, lease: JobLease) -> str:
		return "mineru" if _lease_queue_class(lease) == "mineru" else "local"

	def _reserve_slot(self, kind: str) -> bool:
		with self._inflight_lock:
			if kind == "mineru":
				if self._inflight_mineru >= self._mineru_capacity:
					return False
				self._inflight_mineru += 1
				return True
			if self._inflight_local >= self._local_capacity:
				return False
			self._inflight_local += 1
			return True

	def _release_slot(self, kind: str) -> None:
		with self._inflight_lock:
			if kind == "mineru":
				self._inflight_mineru = max(0, self._inflight_mineru - 1)
			else:
				self._inflight_local = max(0, self._inflight_local - 1)

	def _free_slots(self) -> tuple[int, int]:
		with self._inflight_lock:
			return (
				self._local_capacity - self._inflight_local,
				self._mineru_capacity - self._inflight_mineru,
			)

	def run(self) -> None:
		logger.info(
			"lifecycle_worker.start worker_id=%s version=%s local_cap=%s mineru_cap=%s",
			self.worker_id,
			self.settings.lifecycle_worker_version,
			self._local_capacity,
			self._mineru_capacity,
		)
		ready_path = os.getenv("LIFECYCLE_WORKER_READY_FILE", "").strip()

		def _touch_ready_file() -> None:
			if not ready_path:
				return
			try:
				Path(ready_path).parent.mkdir(parents=True, exist_ok=True)
				Path(ready_path).write_text(
					f"{self.worker_id}\n{time.time():.3f}\n",
					encoding="utf-8",
				)
			except Exception:
				logger.warning(
					"lifecycle_worker.ready_file_touch_failed path=%s",
					ready_path,
					exc_info=True,
				)

		_touch_ready_file()
		max_workers = self._local_capacity + self._mineru_capacity
		# future → (slot kind, started monotonic)
		futures: dict[Future[None], tuple[str, float]] = {}
		with (
			psycopg.connect(
				self.settings.worker_database_dsn,
				autocommit=True,
			) as connection,
			ThreadPoolExecutor(
				max_workers=max_workers,
				thread_name_prefix="lifecycle",
			) as pool,
		):
			repository = JobRepository(connection)
			while not self.stop_event.is_set():
				_touch_ready_file()
				# Reap finished futures
				done = [fut for fut in list(futures) if fut.done()]
				for fut in done:
					kind, started = futures.pop(fut)
					slot_held_ms = (time.monotonic() - started) * 1000.0
					self._release_slot(kind)
					exc = fut.exception()
					logger.info(
						"lifecycle_worker.slot_released kind=%s slot_held_ms=%.1f "
						"ok=%s",
						kind,
						slot_held_ms,
						exc is None,
					)
					if exc is not None and not isinstance(
						exc, (CancelRequestedError, LostJobLeaseError)
					):
						logger.exception(
							"lifecycle_worker.job_failed",
							exc_info=exc,
						)

				reaped = repository.reap_expired()
				if reaped:
					logger.warning("lifecycle_worker.reaped count=%s", reaped)
				if self.settings.lifecycle_cleanup_enabled:
					try:
						sweeper = GenerationCleanupSweeper(self.settings, repository)
						sweep = sweeper.run_once()
						if sweep.claimed:
							logger.info(
								"lifecycle_worker.cleanup claimed=%s deleted=%s "
								"errors=%s",
								sweep.claimed,
								sweep.deleted,
								sweep.errors,
							)
					except Exception:
						logger.exception("lifecycle_worker.cleanup_failed")

				free_local, free_mineru = self._free_slots()
				# Prefer delete + local ingest when mineru slots are saturated.
				if free_local > 0:
					local_leases = repository.claim(
						worker_id=self.worker_id,
						job_types=["document.delete", "document.ingest"],
						capacity=free_local,
						lease_seconds=self.settings.lifecycle_worker_lease_seconds,
						worker_version=self.settings.lifecycle_worker_version,
						queue_classes=["local", "auto"],
					)
					for lease in local_leases:
						kind = self._slot_kind(lease)
						if not self._reserve_slot(kind):
							# Should be rare (race); requeue-equivalent: let lease expire
							logger.warning(
								"lifecycle_worker.slot_exhausted job_id=%s kind=%s",
								lease.id,
								kind,
							)
							continue
						fut = pool.submit(self._process_lease, lease)
						futures[fut] = (kind, time.monotonic())

				if free_mineru > 0:
					mineru_leases = repository.claim(
						worker_id=self.worker_id,
						job_types=["document.ingest"],
						capacity=free_mineru,
						lease_seconds=self.settings.lifecycle_worker_lease_seconds,
						worker_version=self.settings.lifecycle_worker_version,
						queue_classes=["mineru"],
					)
					for lease in mineru_leases:
						if not self._reserve_slot("mineru"):
							logger.warning(
								"lifecycle_worker.mineru_slot_exhausted job_id=%s",
								lease.id,
							)
							continue
						fut = pool.submit(self._process_lease, lease)
						futures[fut] = ("mineru", time.monotonic())

				if not futures:
					self.stop_event.wait(self.settings.lifecycle_worker_poll_seconds)
					continue
				# Brief wait so heartbeats/progress can run without busy-spin
				time.sleep(min(0.25, self.settings.lifecycle_worker_poll_seconds))

		if ready_path:
			try:
				Path(ready_path).unlink(missing_ok=True)
			except Exception:
				logger.warning(
					"lifecycle_worker.ready_file_cleanup_failed path=%s",
					ready_path,
					exc_info=True,
				)
		logger.info("lifecycle_worker.stop worker_id=%s", self.worker_id)

	def _process_lease(self, lease: JobLease) -> None:
		"""Process one lease on a worker thread with its own DB connection."""
		with psycopg.connect(
			self.settings.worker_database_dsn,
			autocommit=True,
		) as connection:
			repository = JobRepository(connection)
			ingest_processor = DocumentIngestProcessor(self.settings, repository)
			delete_processor = DocumentDeleteProcessor(self.settings, repository)
			try:
				with LeaseController(
					database_dsn=self.settings.worker_database_dsn,
					repository=repository,
					lease=lease,
					lease_seconds=self.settings.lifecycle_worker_lease_seconds,
					heartbeat_seconds=self.settings.lifecycle_worker_heartbeat_seconds,
				) as progress:
					if lease.type == "document.delete":
						result = delete_processor.process(lease, progress)
						logger.info(
							"lifecycle_worker.delete_completed job_id=%s "
							"document_id=%s library_finalized=%s",
							result.job_id,
							result.document_id,
							result.library_finalized,
						)
					else:
						result = ingest_processor.process(lease, progress)
						if result is None:
							logger.info(
								"lifecycle_worker.requeued job_id=%s",
								lease.id,
							)
							return
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
