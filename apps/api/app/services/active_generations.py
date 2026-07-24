from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Protocol

import psycopg

from app.security.access_scope import AccessScope
from app.settings import Settings


@dataclass(frozen=True)
class ActiveGenerationSnapshot:
	generation_ids: tuple[str, ...]
	resolved_at: float

	@property
	def cache_key(self) -> str:
		return ",".join(self.generation_ids) or "none"


class ActiveGenerationResolverProtocol(Protocol):
	def resolve(
		self,
		*,
		scope: AccessScope,
		library_id: str,
	) -> ActiveGenerationSnapshot: ...


class ActiveGenerationResolver:
	"""Resolve one authoritative generation snapshot per retrieval operation."""

	def __init__(self, settings: Settings) -> None:
		if not settings.rag_read_database_dsn:
			raise ValueError("RAG_READ_DATABASE_URL or DATABASE_URL is required")
		self.database_dsn = settings.rag_read_database_dsn
		self.ttl_seconds = max(0.0, settings.active_generation_cache_ttl_seconds)
		self._cache: dict[
			tuple[str, str, str],
			tuple[float, ActiveGenerationSnapshot],
		] = {}
		self._lock = threading.Lock()

	def resolve(
		self,
		*,
		scope: AccessScope,
		library_id: str,
	) -> ActiveGenerationSnapshot:
		key = (scope.tenant_id, scope.workspace_id, library_id)
		now = time.monotonic()
		with self._lock:
			cached = self._cache.get(key)
			if cached is not None and cached[0] > now:
				return cached[1]
		with psycopg.connect(self.database_dsn, autocommit=True) as connection:
			rows = connection.execute(
				"""
				SELECT generation_id
				FROM rag.active_document_generations
				WHERE organization_id = %s
				  AND workspace_id = %s
				  AND rag_library_id = %s
				ORDER BY document_id
				""",
				(scope.tenant_id, scope.workspace_id, library_id),
			).fetchall()
		snapshot = ActiveGenerationSnapshot(
			generation_ids=tuple(str(row[0]) for row in rows),
			resolved_at=time.time(),
		)
		with self._lock:
			self._cache[key] = (now + self.ttl_seconds, snapshot)
		return snapshot

	def invalidate(
		self,
		*,
		organization_id: str,
		workspace_id: str,
		library_id: str,
	) -> None:
		with self._lock:
			self._cache.pop((organization_id, workspace_id, library_id), None)


def probe_active_generation_store(settings: Settings) -> tuple[bool, str]:
	if not settings.active_generation_gate_enabled:
		return True, "disabled"
	try:
		with psycopg.connect(
			settings.rag_read_database_dsn,
			autocommit=True,
			connect_timeout=2,
		) as connection:
			connection.execute(
				"SELECT 1 FROM rag.active_document_generations LIMIT 1"
			).fetchone()
		return True, "ok"
	except Exception as exc:
		return False, str(exc)
