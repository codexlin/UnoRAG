from __future__ import annotations

import json
import logging
import threading
from abc import ABC, abstractmethod
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

logger = logging.getLogger(__name__)

LibraryStatus = Literal["ready", "indexing", "empty"]
DocumentStatus = Literal["processing", "ready", "failed"]


def _now_iso() -> str:
	return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _library_status(doc_count: int, ready_count: int, has_processing: bool) -> LibraryStatus:
	if doc_count <= 0:
		return "empty"
	if has_processing or ready_count < doc_count:
		return "indexing"
	return "ready"


class MetadataStore(ABC):
	@abstractmethod
	def list_libraries(self) -> list[dict[str, Any]]:
		raise NotImplementedError

	@abstractmethod
	def get_library(self, library_id: str) -> dict[str, Any] | None:
		raise NotImplementedError

	@abstractmethod
	def create_library(self, *, name: str, library_id: str | None = None) -> dict[str, Any]:
		raise NotImplementedError

	@abstractmethod
	def list_documents(self, library_id: str) -> list[dict[str, Any]]:
		raise NotImplementedError

	@abstractmethod
	def get_document(self, doc_id: str) -> dict[str, Any] | None:
		raise NotImplementedError

	@abstractmethod
	def create_document(
		self,
		*,
		library_id: str,
		name: str,
		filename: str,
		content_type: str,
		doc_id: str | None = None,
		status: DocumentStatus = "processing",
	) -> dict[str, Any]:
		raise NotImplementedError

	@abstractmethod
	def update_document(
		self,
		doc_id: str,
		*,
		status: DocumentStatus | None = None,
		chunk_count: int | None = None,
		error: str | None = None,
	) -> dict[str, Any] | None:
		raise NotImplementedError

	@abstractmethod
	def refresh_library_counts(self, library_id: str) -> dict[str, Any] | None:
		raise NotImplementedError


class JsonMetadataStore(MetadataStore):
	"""File-backed metadata for local demos without Postgres."""

	def __init__(self, path: Path) -> None:
		self.path = path
		self._lock = threading.Lock()
		self.path.parent.mkdir(parents=True, exist_ok=True)
		if not self.path.exists():
			self._write({"libraries": {}, "documents": {}})
			self._seed_defaults()

	def _read(self) -> dict[str, Any]:
		with self.path.open("r", encoding="utf-8") as handle:
			return json.load(handle)

	def _write(self, data: dict[str, Any]) -> None:
		tmp = self.path.with_suffix(".tmp")
		with tmp.open("w", encoding="utf-8") as handle:
			json.dump(data, handle, ensure_ascii=False, indent=2)
		tmp.replace(self.path)

	def _seed_defaults(self) -> None:
		with self._lock:
			data = self._read()
			if data.get("libraries"):
				return
			now = _now_iso()
			library_id = "lib-hr"
			data["libraries"][library_id] = {
				"id": library_id,
				"name": "人事制度库",
				"status": "empty",
				"doc_count": 0,
				"ready_count": 0,
				"created_at": now,
				"updated_at": now,
			}
			self._write(data)
			logger.info("metadata.seed library_id=%s", library_id)

	def list_libraries(self) -> list[dict[str, Any]]:
		with self._lock:
			data = self._read()
			items = list(data.get("libraries", {}).values())
		return sorted(items, key=lambda item: item.get("updated_at") or "", reverse=True)

	def get_library(self, library_id: str) -> dict[str, Any] | None:
		with self._lock:
			data = self._read()
			item = data.get("libraries", {}).get(library_id)
			return dict(item) if item else None

	def create_library(self, *, name: str, library_id: str | None = None) -> dict[str, Any]:
		resolved = library_id or str(uuid4())
		now = _now_iso()
		row = {
			"id": resolved,
			"name": name.strip()[:256] or "未命名文库",
			"status": "empty",
			"doc_count": 0,
			"ready_count": 0,
			"created_at": now,
			"updated_at": now,
		}
		with self._lock:
			data = self._read()
			if resolved in data.get("libraries", {}):
				raise ValueError(f"library already exists: {resolved}")
			data.setdefault("libraries", {})[resolved] = row
			self._write(data)
		return dict(row)

	def list_documents(self, library_id: str) -> list[dict[str, Any]]:
		with self._lock:
			data = self._read()
			items = [
				dict(item)
				for item in data.get("documents", {}).values()
				if item.get("library_id") == library_id
			]
		return sorted(items, key=lambda item: item.get("updated_at") or "", reverse=True)

	def get_document(self, doc_id: str) -> dict[str, Any] | None:
		with self._lock:
			data = self._read()
			item = data.get("documents", {}).get(doc_id)
			return dict(item) if item else None

	def create_document(
		self,
		*,
		library_id: str,
		name: str,
		filename: str,
		content_type: str,
		doc_id: str | None = None,
		status: DocumentStatus = "processing",
	) -> dict[str, Any]:
		with self._lock:
			data = self._read()
			if library_id not in data.get("libraries", {}):
				raise ValueError(f"library not found: {library_id}")
			resolved = doc_id or str(uuid4())
			now = _now_iso()
			row = {
				"id": resolved,
				"library_id": library_id,
				"name": name.strip()[:512] or filename,
				"filename": filename,
				"content_type": content_type,
				"status": status,
				"chunk_count": 0,
				"error": None,
				"created_at": now,
				"updated_at": now,
			}
			data.setdefault("documents", {})[resolved] = row
			self._write(data)
		self.refresh_library_counts(library_id)
		return dict(row)

	def update_document(
		self,
		doc_id: str,
		*,
		status: DocumentStatus | None = None,
		chunk_count: int | None = None,
		error: str | None = None,
	) -> dict[str, Any] | None:
		with self._lock:
			data = self._read()
			row = data.get("documents", {}).get(doc_id)
			if not row:
				return None
			if status is not None:
				row["status"] = status
			if chunk_count is not None:
				row["chunk_count"] = int(chunk_count)
			if error is not None:
				row["error"] = error
			row["updated_at"] = _now_iso()
			data["documents"][doc_id] = row
			self._write(data)
			library_id = str(row["library_id"])
			updated = dict(row)
		self.refresh_library_counts(library_id)
		return updated

	def refresh_library_counts(self, library_id: str) -> dict[str, Any] | None:
		with self._lock:
			data = self._read()
			library = data.get("libraries", {}).get(library_id)
			if not library:
				return None
			docs = [
				item
				for item in data.get("documents", {}).values()
				if item.get("library_id") == library_id
			]
			doc_count = len(docs)
			ready_count = sum(1 for item in docs if item.get("status") == "ready")
			has_processing = any(item.get("status") == "processing" for item in docs)
			library["doc_count"] = doc_count
			library["ready_count"] = ready_count
			library["status"] = _library_status(doc_count, ready_count, has_processing)
			library["updated_at"] = _now_iso()
			data["libraries"][library_id] = library
			self._write(data)
			return dict(library)


class SqlAlchemyMetadataStore(MetadataStore):
	"""Optional Postgres-backed metadata when DATABASE_URL is set."""

	def __init__(self, database_url: str) -> None:
		from sqlalchemy import (
			DateTime,
			Integer,
			MetaData,
			String,
			Text,
			create_engine,
			func,
			select,
		)
		from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

		class Base(DeclarativeBase):
			metadata = MetaData()

		class LibraryRow(Base):
			__tablename__ = "libraries"

			id: Mapped[str] = mapped_column(String(128), primary_key=True)
			name: Mapped[str] = mapped_column(String(256), nullable=False)
			status: Mapped[str] = mapped_column(String(32), nullable=False, default="empty")
			doc_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
			ready_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
			created_at: Mapped[datetime] = mapped_column(
				DateTime(timezone=True),
				server_default=func.now(),
				nullable=False,
			)
			updated_at: Mapped[datetime] = mapped_column(
				DateTime(timezone=True),
				server_default=func.now(),
				onupdate=func.now(),
				nullable=False,
			)

		class DocumentRow(Base):
			__tablename__ = "documents"

			id: Mapped[str] = mapped_column(String(128), primary_key=True)
			library_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
			name: Mapped[str] = mapped_column(String(512), nullable=False)
			filename: Mapped[str] = mapped_column(String(512), nullable=False)
			content_type: Mapped[str] = mapped_column(String(128), nullable=False, default="")
			status: Mapped[str] = mapped_column(String(32), nullable=False, default="processing")
			chunk_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
			error: Mapped[str | None] = mapped_column(Text, nullable=True)
			created_at: Mapped[datetime] = mapped_column(
				DateTime(timezone=True),
				server_default=func.now(),
				nullable=False,
			)
			updated_at: Mapped[datetime] = mapped_column(
				DateTime(timezone=True),
				server_default=func.now(),
				onupdate=func.now(),
				nullable=False,
			)

		self._LibraryRow = LibraryRow
		self._DocumentRow = DocumentRow
		self._select = select
		self._engine = create_engine(database_url, pool_pre_ping=True)
		Base.metadata.create_all(self._engine)
		self._Session = sessionmaker(bind=self._engine, expire_on_commit=False, class_=Session)
		self._seed_defaults()

	@staticmethod
	def _dt(value: datetime | None) -> str:
		if value is None:
			return _now_iso()
		if value.tzinfo is None:
			value = value.replace(tzinfo=UTC)
		return value.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")

	def _library_dict(self, row: Any) -> dict[str, Any]:
		return {
			"id": row.id,
			"name": row.name,
			"status": row.status,
			"doc_count": int(row.doc_count),
			"ready_count": int(row.ready_count),
			"created_at": self._dt(row.created_at),
			"updated_at": self._dt(row.updated_at),
		}

	def _document_dict(self, row: Any) -> dict[str, Any]:
		return {
			"id": row.id,
			"library_id": row.library_id,
			"name": row.name,
			"filename": row.filename,
			"content_type": row.content_type,
			"status": row.status,
			"chunk_count": int(row.chunk_count),
			"error": row.error,
			"created_at": self._dt(row.created_at),
			"updated_at": self._dt(row.updated_at),
		}

	def _seed_defaults(self) -> None:
		with self._Session() as session:
			existing = session.get(self._LibraryRow, "lib-hr")
			if existing is not None:
				return
			session.add(
				self._LibraryRow(
					id="lib-hr",
					name="人事制度库",
					status="empty",
					doc_count=0,
					ready_count=0,
				)
			)
			session.commit()
			logger.info("metadata.seed.sql library_id=lib-hr")

	def list_libraries(self) -> list[dict[str, Any]]:
		with self._Session() as session:
			rows = session.scalars(
				self._select(self._LibraryRow).order_by(self._LibraryRow.updated_at.desc())
			).all()
			return [self._library_dict(row) for row in rows]

	def get_library(self, library_id: str) -> dict[str, Any] | None:
		with self._Session() as session:
			row = session.get(self._LibraryRow, library_id)
			return self._library_dict(row) if row else None

	def create_library(self, *, name: str, library_id: str | None = None) -> dict[str, Any]:
		resolved = library_id or str(uuid4())
		with self._Session() as session:
			if session.get(self._LibraryRow, resolved) is not None:
				raise ValueError(f"library already exists: {resolved}")
			row = self._LibraryRow(
				id=resolved,
				name=name.strip()[:256] or "未命名文库",
				status="empty",
				doc_count=0,
				ready_count=0,
			)
			session.add(row)
			session.commit()
			session.refresh(row)
			return self._library_dict(row)

	def list_documents(self, library_id: str) -> list[dict[str, Any]]:
		with self._Session() as session:
			rows = session.scalars(
				self._select(self._DocumentRow)
				.where(self._DocumentRow.library_id == library_id)
				.order_by(self._DocumentRow.updated_at.desc())
			).all()
			return [self._document_dict(row) for row in rows]

	def get_document(self, doc_id: str) -> dict[str, Any] | None:
		with self._Session() as session:
			row = session.get(self._DocumentRow, doc_id)
			return self._document_dict(row) if row else None

	def create_document(
		self,
		*,
		library_id: str,
		name: str,
		filename: str,
		content_type: str,
		doc_id: str | None = None,
		status: DocumentStatus = "processing",
	) -> dict[str, Any]:
		resolved = doc_id or str(uuid4())
		with self._Session() as session:
			if session.get(self._LibraryRow, library_id) is None:
				raise ValueError(f"library not found: {library_id}")
			row = self._DocumentRow(
				id=resolved,
				library_id=library_id,
				name=name.strip()[:512] or filename,
				filename=filename,
				content_type=content_type,
				status=status,
				chunk_count=0,
				error=None,
			)
			session.add(row)
			session.commit()
			session.refresh(row)
			payload = self._document_dict(row)
		self.refresh_library_counts(library_id)
		return payload

	def update_document(
		self,
		doc_id: str,
		*,
		status: DocumentStatus | None = None,
		chunk_count: int | None = None,
		error: str | None = None,
	) -> dict[str, Any] | None:
		with self._Session() as session:
			row = session.get(self._DocumentRow, doc_id)
			if row is None:
				return None
			if status is not None:
				row.status = status
			if chunk_count is not None:
				row.chunk_count = int(chunk_count)
			if error is not None:
				row.error = error
			library_id = row.library_id
			session.commit()
			session.refresh(row)
			payload = self._document_dict(row)
		self.refresh_library_counts(library_id)
		return payload

	def refresh_library_counts(self, library_id: str) -> dict[str, Any] | None:
		with self._Session() as session:
			library = session.get(self._LibraryRow, library_id)
			if library is None:
				return None
			docs = session.scalars(
				self._select(self._DocumentRow).where(self._DocumentRow.library_id == library_id)
			).all()
			doc_count = len(docs)
			ready_count = sum(1 for item in docs if item.status == "ready")
			has_processing = any(item.status == "processing" for item in docs)
			library.doc_count = doc_count
			library.ready_count = ready_count
			library.status = _library_status(doc_count, ready_count, has_processing)
			session.commit()
			session.refresh(library)
			return self._library_dict(library)


_store: MetadataStore | None = None
_store_lock = threading.Lock()


def get_metadata_store(settings: Any | None = None) -> MetadataStore:
	global _store
	from app.settings import get_settings

	cfg = settings or get_settings()
	with _store_lock:
		if _store is not None:
			return _store
		database_url = (getattr(cfg, "database_url", "") or "").strip()
		if database_url:
			try:
				_store = SqlAlchemyMetadataStore(database_url)
				logger.info("metadata.backend=postgres")
				return _store
			except Exception:
				logger.exception("metadata.postgres_failed fallback=json")
		path = Path(getattr(cfg, "metadata_path", "data/metadata.json"))
		_store = JsonMetadataStore(path)
		logger.info("metadata.backend=json path=%s", path)
		return _store


def reset_metadata_store() -> None:
	global _store
	with _store_lock:
		_store = None
