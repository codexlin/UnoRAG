from __future__ import annotations

import json
import logging
import threading
from abc import ABC, abstractmethod
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from sqlalchemy import DateTime, Integer, MetaData, String, Text, create_engine, func, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from app.security.access_scope import AccessScope

logger = logging.getLogger(__name__)

LibraryStatus = Literal["ready", "indexing", "empty"]
DocumentStatus = Literal["processing", "ready", "failed"]


def _sqlalchemy_database_url(database_url: str) -> str:
	if database_url.startswith("postgresql://"):
		return database_url.replace("postgresql://", "postgresql+psycopg://", 1)
	if database_url.startswith("postgres://"):
		return database_url.replace("postgres://", "postgresql+psycopg://", 1)
	return database_url


def _now_iso() -> str:
	# Keep microseconds so bulk-archived turns in the same second stay ordered.
	return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _library_status(doc_count: int, ready_count: int, has_processing: bool) -> LibraryStatus:
	if doc_count <= 0:
		return "empty"
	if has_processing or ready_count < doc_count:
		return "indexing"
	return "ready"


class MetadataStore(ABC):
	"""Data-plane metadata projection.

	L6+: `app.*` is the product source of truth. `public.documents` /
	`public.libraries` (Postgres backend) are compatibility projections for
	legacy FastAPI reads and migration backfill joins. Do not treat public.*
	status as authoritative for product lifecycle.
	"""

	@abstractmethod
	def list_libraries(self, *, scope: AccessScope) -> list[dict[str, Any]]:
		raise NotImplementedError

	@abstractmethod
	def get_library(
		self,
		library_id: str,
		*,
		scope: AccessScope,
	) -> dict[str, Any] | None:
		raise NotImplementedError

	@abstractmethod
	def create_library(
		self,
		*,
		name: str,
		library_id: str | None = None,
		description: str | None = None,
		scope: AccessScope,
	) -> dict[str, Any]:
		raise NotImplementedError

	@abstractmethod
	def update_library(
		self,
		library_id: str,
		*,
		name: str | None = None,
		description: str | None = None,
		update_description: bool = False,
		scope: AccessScope,
	) -> dict[str, Any] | None:
		raise NotImplementedError

	@abstractmethod
	def delete_library(self, library_id: str, *, scope: AccessScope) -> bool:
		"""删除知识库及其下全部文档元数据；向量与落盘原文由调用方先清。"""
		raise NotImplementedError

	@abstractmethod
	def list_documents(
		self,
		library_id: str,
		*,
		scope: AccessScope,
	) -> list[dict[str, Any]]:
		raise NotImplementedError

	@abstractmethod
	def get_document(
		self,
		doc_id: str,
		*,
		scope: AccessScope,
	) -> dict[str, Any] | None:
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
		storage_key: str | None = None,
		size_bytes: int | None = None,
		scope: AccessScope,
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
		parser_report: dict[str, Any] | None = None,
		storage_key: str | None = None,
		size_bytes: int | None = None,
		name: str | None = None,
		filename: str | None = None,
		content_type: str | None = None,
		clear_error: bool = False,
		scope: AccessScope,
	) -> dict[str, Any] | None:
		raise NotImplementedError

	@abstractmethod
	def delete_document(self, doc_id: str, *, scope: AccessScope) -> bool:
		"""删除文档元数据行；向量需调用方先清 Qdrant。"""
		raise NotImplementedError

	@abstractmethod
	def refresh_library_counts(
		self,
		library_id: str,
		*,
		scope: AccessScope,
	) -> dict[str, Any] | None:
		raise NotImplementedError

	@abstractmethod
	def create_thread(
		self,
		*,
		title: str,
		session_id: str | None = None,
		library_id: str | None = None,
		thread_id: str | None = None,
		# status=active: persisted (archived) conversation that can continue.
		# Temporary chats have no Thread row. status=hidden soft-hides from lists.
		status: str = "active",
		tenant_id: str | None = None,
		workspace_id: str | None = None,
		principal_id: str | None = None,
	) -> dict[str, Any]:
		raise NotImplementedError

	@abstractmethod
	def list_threads(
		self,
		*,
		tenant_id: str,
		workspace_id: str,
		principal_id: str,
		status: str | None = "active",
		limit: int = 50,
	) -> list[dict[str, Any]]:
		raise NotImplementedError

	@abstractmethod
	def get_thread(
		self,
		thread_id: str,
		*,
		tenant_id: str,
		workspace_id: str,
		principal_id: str,
	) -> dict[str, Any] | None:
		raise NotImplementedError

	@abstractmethod
	def touch_thread(
		self,
		thread_id: str,
		*,
		tenant_id: str,
		workspace_id: str,
		principal_id: str,
		title: str | None = None,
	) -> dict[str, Any] | None:
		raise NotImplementedError

	@abstractmethod
	def create_turn(
		self,
		*,
		session_id: str,
		library_id: str | None,
		question: str,
		answer: str,
		citations: list[dict[str, Any]],
		mode: str,
		refused: bool = False,
		refuse_reason: str | None = None,
		turn_id: str | None = None,
		thread_id: str | None = None,
		query_type: str | None = None,
		retrieval_plan: dict[str, Any] | None = None,
		retrieval_debug: dict[str, Any] | None = None,
		rewrite: str | None = None,
		rewritten_query: str | None = None,
		judge: dict[str, Any] | None = None,
		document_version_id: str | None = None,
		tenant_id: str | None = None,
		workspace_id: str | None = None,
		principal_id: str | None = None,
	) -> dict[str, Any]:
		raise NotImplementedError

	@abstractmethod
	def list_turns(
		self,
		*,
		library_id: str | None = None,
		session_id: str | None = None,
		thread_id: str | None = None,
		tenant_id: str | None = None,
		workspace_id: str | None = None,
		principal_id: str | None = None,
		limit: int = 50,
	) -> list[dict[str, Any]]:
		raise NotImplementedError

	@abstractmethod
	def get_turn(
		self,
		turn_id: str,
		*,
		tenant_id: str,
		workspace_id: str,
		principal_id: str,
	) -> dict[str, Any] | None:
		raise NotImplementedError


class JsonMetadataStore(MetadataStore):
	"""File-backed metadata for local demos without Postgres."""

	def __init__(self, path: Path) -> None:
		self.path = path
		self._lock = threading.Lock()
		self.path.parent.mkdir(parents=True, exist_ok=True)
		if not self.path.exists():
			self._write({"libraries": {}, "documents": {}, "turns": {}, "threads": {}})

	def _read(self) -> dict[str, Any]:
		with self.path.open("r", encoding="utf-8") as handle:
			data = json.load(handle)
		if not isinstance(data, dict):
			return {"libraries": {}, "documents": {}, "turns": {}, "threads": {}}
		data.setdefault("libraries", {})
		data.setdefault("documents", {})
		data.setdefault("turns", {})
		data.setdefault("threads", {})
		return data

	def _write(self, data: dict[str, Any]) -> None:
		tmp = self.path.with_suffix(".tmp")
		with tmp.open("w", encoding="utf-8") as handle:
			json.dump(data, handle, ensure_ascii=False, indent=2)
		tmp.replace(self.path)

	@staticmethod
	def _library_dict(item: dict[str, Any]) -> dict[str, Any]:
		row = dict(item)
		row.setdefault("description", None)
		return row

	@staticmethod
	def _in_scope(item: dict[str, Any], scope: AccessScope) -> bool:
		return (
			item.get("tenant_id") == scope.tenant_id
			and item.get("workspace_id") == scope.workspace_id
		)

	def list_libraries(self, *, scope: AccessScope) -> list[dict[str, Any]]:
		with self._lock:
			data = self._read()
			items = [
				self._library_dict(item)
				for item in data.get("libraries", {}).values()
				if self._in_scope(item, scope)
			]
		return sorted(items, key=lambda item: item.get("updated_at") or "", reverse=True)

	def get_library(
		self,
		library_id: str,
		*,
		scope: AccessScope,
	) -> dict[str, Any] | None:
		with self._lock:
			data = self._read()
			item = data.get("libraries", {}).get(library_id)
			return self._library_dict(item) if item and self._in_scope(item, scope) else None

	def create_library(
		self,
		*,
		name: str,
		library_id: str | None = None,
		description: str | None = None,
		scope: AccessScope,
	) -> dict[str, Any]:
		resolved = library_id or str(uuid4())
		now = _now_iso()
		desc = description.strip()[:2000] if isinstance(description, str) and description.strip() else None
		row = {
			"id": resolved,
			"name": name.strip()[:256] or "未命名知识库",
			"description": desc,
			"status": "empty",
			"doc_count": 0,
			"ready_count": 0,
			"tenant_id": scope.tenant_id,
			"workspace_id": scope.workspace_id,
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

	def update_library(
		self,
		library_id: str,
		*,
		name: str | None = None,
		description: str | None = None,
		update_description: bool = False,
		scope: AccessScope,
	) -> dict[str, Any] | None:
		with self._lock:
			data = self._read()
			row = data.get("libraries", {}).get(library_id)
			if row is None or not self._in_scope(row, scope):
				return None
			if name is not None:
				row["name"] = name.strip()[:256] or "未命名知识库"
			if update_description:
				if isinstance(description, str) and description.strip():
					row["description"] = description.strip()[:2000]
				else:
					row["description"] = None
			row["updated_at"] = _now_iso()
			data["libraries"][library_id] = row
			self._write(data)
			return self._library_dict(row)

	def delete_library(self, library_id: str, *, scope: AccessScope) -> bool:
		with self._lock:
			data = self._read()
			libraries = data.get("libraries", {})
			library = libraries.get(library_id)
			if library is None or not self._in_scope(library, scope):
				return False
			documents = data.setdefault("documents", {})
			for doc_id in [
				key
				for key, item in list(documents.items())
				if item.get("library_id") == library_id and self._in_scope(item, scope)
			]:
				documents.pop(doc_id, None)
			libraries.pop(library_id, None)
			self._write(data)
			return True

	def list_documents(
		self,
		library_id: str,
		*,
		scope: AccessScope,
	) -> list[dict[str, Any]]:
		with self._lock:
			data = self._read()
			library = data.get("libraries", {}).get(library_id)
			if library is None or not self._in_scope(library, scope):
				return []
			items = [
				dict(item)
				for item in data.get("documents", {}).values()
				if item.get("library_id") == library_id and self._in_scope(item, scope)
			]
		return sorted(items, key=lambda item: item.get("updated_at") or "", reverse=True)

	def get_document(
		self,
		doc_id: str,
		*,
		scope: AccessScope,
	) -> dict[str, Any] | None:
		with self._lock:
			data = self._read()
			item = data.get("documents", {}).get(doc_id)
			return dict(item) if item and self._in_scope(item, scope) else None

	def create_document(
		self,
		*,
		library_id: str,
		name: str,
		filename: str,
		content_type: str,
		doc_id: str | None = None,
		status: DocumentStatus = "processing",
		storage_key: str | None = None,
		size_bytes: int | None = None,
		scope: AccessScope,
	) -> dict[str, Any]:
		with self._lock:
			data = self._read()
			library = data.get("libraries", {}).get(library_id)
			if library is None or not self._in_scope(library, scope):
				raise ValueError(f"library not found: {library_id}")
			resolved = doc_id or str(uuid4())
			if resolved in data.get("documents", {}):
				raise ValueError(f"document already exists: {resolved}")
			now = _now_iso()
			row = {
				"id": resolved,
				"library_id": library_id,
				"name": name.strip()[:512] or filename,
				"filename": filename,
				"content_type": content_type,
				"status": status,
				"chunk_count": 0,
				"size_bytes": int(size_bytes) if size_bytes is not None else None,
				"error": None,
				"parser_report": None,
				"storage_key": storage_key,
				"tenant_id": scope.tenant_id,
				"workspace_id": scope.workspace_id,
				"created_at": now,
				"updated_at": now,
			}
			data.setdefault("documents", {})[resolved] = row
			self._write(data)
		self.refresh_library_counts(library_id, scope=scope)
		return dict(row)

	def update_document(
		self,
		doc_id: str,
		*,
		status: DocumentStatus | None = None,
		chunk_count: int | None = None,
		error: str | None = None,
		parser_report: dict[str, Any] | None = None,
		storage_key: str | None = None,
		size_bytes: int | None = None,
		name: str | None = None,
		filename: str | None = None,
		content_type: str | None = None,
		clear_error: bool = False,
		scope: AccessScope,
	) -> dict[str, Any] | None:
		with self._lock:
			data = self._read()
			row = data.get("documents", {}).get(doc_id)
			if not row or not self._in_scope(row, scope):
				return None
			if status is not None:
				row["status"] = status
			if chunk_count is not None:
				row["chunk_count"] = int(chunk_count)
			if clear_error:
				row["error"] = None
			elif error is not None:
				row["error"] = error
			if parser_report is not None:
				row["parser_report"] = parser_report
			if storage_key is not None:
				row["storage_key"] = storage_key
			if size_bytes is not None:
				row["size_bytes"] = int(size_bytes)
			if name is not None:
				row["name"] = name
			if filename is not None:
				row["filename"] = filename
			if content_type is not None:
				row["content_type"] = content_type
			row["updated_at"] = _now_iso()
			data["documents"][doc_id] = row
			self._write(data)
			library_id = str(row["library_id"])
			updated = dict(row)
		self.refresh_library_counts(library_id, scope=scope)
		return updated

	def delete_document(self, doc_id: str, *, scope: AccessScope) -> bool:
		with self._lock:
			data = self._read()
			row = data.get("documents", {}).get(doc_id)
			if not row or not self._in_scope(row, scope):
				return False
			data["documents"].pop(doc_id, None)
			library_id = str(row["library_id"])
			self._write(data)
		self.refresh_library_counts(library_id, scope=scope)
		return True

	def refresh_library_counts(
		self,
		library_id: str,
		*,
		scope: AccessScope,
	) -> dict[str, Any] | None:
		with self._lock:
			data = self._read()
			library = data.get("libraries", {}).get(library_id)
			if not library or not self._in_scope(library, scope):
				return None
			docs = [
				item
				for item in data.get("documents", {}).values()
				if item.get("library_id") == library_id and self._in_scope(item, scope)
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

	def create_thread(
		self,
		*,
		title: str,
		session_id: str | None = None,
		library_id: str | None = None,
		thread_id: str | None = None,
		status: str = "active",
		tenant_id: str | None = None,
		workspace_id: str | None = None,
		principal_id: str | None = None,
	) -> dict[str, Any]:
		resolved = thread_id or str(uuid4())
		now = _now_iso()
		row = {
			"id": resolved,
			"session_id": session_id,
			"library_id": library_id,
			"title": (title or "").strip()[:256] or "未命名会话",
			# active = archived & continuable; hidden = soft-hidden from lists
			"status": status if status in {"active", "hidden"} else "active",
			"tenant_id": tenant_id or "default",
			"workspace_id": workspace_id or "default",
			"principal_id": principal_id or "development",
			"created_at": now,
			"updated_at": now,
		}
		with self._lock:
			data = self._read()
			data.setdefault("threads", {})[resolved] = row
			self._write(data)
		return dict(row)

	def list_threads(
		self,
		*,
		tenant_id: str,
		workspace_id: str,
		principal_id: str,
		status: str | None = "active",
		limit: int = 50,
	) -> list[dict[str, Any]]:
		with self._lock:
			data = self._read()
			items = [dict(item) for item in data.get("threads", {}).values()]
			turns = [dict(item) for item in data.get("turns", {}).values()]
		items = [
			item
			for item in items
			if item.get("tenant_id") == tenant_id
			and item.get("workspace_id") == workspace_id
			and item.get("principal_id") == principal_id
		]
		if status:
			items = [item for item in items if item.get("status") == status]
		items.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
		capped = max(1, min(limit, 200))
		out: list[dict[str, Any]] = []
		for item in items[:capped]:
			turn_count = sum(
				1
				for turn in turns
				if turn.get("thread_id") == item["id"]
				and turn.get("tenant_id") == tenant_id
				and turn.get("workspace_id") == workspace_id
				and turn.get("principal_id") == principal_id
			)
			row = dict(item)
			row["turn_count"] = turn_count
			out.append(row)
		return out

	def get_thread(
		self,
		thread_id: str,
		*,
		tenant_id: str,
		workspace_id: str,
		principal_id: str,
	) -> dict[str, Any] | None:
		with self._lock:
			data = self._read()
			item = data.get("threads", {}).get(thread_id)
			if (
				item
				and item.get("tenant_id") == tenant_id
				and item.get("workspace_id") == workspace_id
				and item.get("principal_id") == principal_id
			):
				row = dict(item)
				row["turn_count"] = sum(
					1
					for turn in data.get("turns", {}).values()
					if turn.get("thread_id") == thread_id
				)
				return row
			return None

	def touch_thread(
		self,
		thread_id: str,
		*,
		tenant_id: str,
		workspace_id: str,
		principal_id: str,
		title: str | None = None,
	) -> dict[str, Any] | None:
		with self._lock:
			data = self._read()
			item = data.get("threads", {}).get(thread_id)
			if (
				not item
				or item.get("tenant_id") != tenant_id
				or item.get("workspace_id") != workspace_id
				or item.get("principal_id") != principal_id
			):
				return None
			item = dict(item)
			if title is not None and title.strip():
				item["title"] = title.strip()[:256]
			item["updated_at"] = _now_iso()
			data.setdefault("threads", {})[thread_id] = item
			self._write(data)
			return dict(item)

	def create_turn(
		self,
		*,
		session_id: str,
		library_id: str | None,
		question: str,
		answer: str,
		citations: list[dict[str, Any]],
		mode: str,
		refused: bool = False,
		refuse_reason: str | None = None,
		turn_id: str | None = None,
		thread_id: str | None = None,
		query_type: str | None = None,
		retrieval_plan: dict[str, Any] | None = None,
		retrieval_debug: dict[str, Any] | None = None,
		rewrite: str | None = None,
		rewritten_query: str | None = None,
		judge: dict[str, Any] | None = None,
		document_version_id: str | None = None,
		tenant_id: str | None = None,
		workspace_id: str | None = None,
		principal_id: str | None = None,
	) -> dict[str, Any]:
		resolved = turn_id or str(uuid4())
		now = _now_iso()
		row = {
			"id": resolved,
			"session_id": session_id,
			"thread_id": thread_id,
			"library_id": library_id,
			"question": question,
			"answer": answer,
			"citations": citations,
			"mode": mode,
			"refused": bool(refused),
			"refuse_reason": refuse_reason,
			"query_type": query_type,
			"retrieval_plan": retrieval_plan,
			"retrieval_debug": retrieval_debug,
			"rewrite": rewrite,
			"rewritten_query": rewritten_query,
			"judge": judge,
			"document_version_id": document_version_id,
			"tenant_id": tenant_id or "default",
			"workspace_id": workspace_id or "default",
			"principal_id": principal_id or "development",
			"created_at": now,
		}
		with self._lock:
			data = self._read()
			data.setdefault("turns", {})[resolved] = row
			if thread_id and thread_id in data.get("threads", {}):
				thread = dict(data["threads"][thread_id])
				thread["updated_at"] = now
				data["threads"][thread_id] = thread
			self._write(data)
		return dict(row)

	def list_turns(
		self,
		*,
		library_id: str | None = None,
		session_id: str | None = None,
		thread_id: str | None = None,
		tenant_id: str | None = None,
		workspace_id: str | None = None,
		principal_id: str | None = None,
		limit: int = 50,
	) -> list[dict[str, Any]]:
		if not tenant_id or not workspace_id or not principal_id:
			raise ValueError("tenant_id, workspace_id and principal_id are required")
		with self._lock:
			data = self._read()
			items = [dict(item) for item in data.get("turns", {}).values()]
		if library_id:
			items = [item for item in items if item.get("library_id") == library_id]
		if session_id:
			items = [item for item in items if item.get("session_id") == session_id]
		if thread_id:
			items = [item for item in items if item.get("thread_id") == thread_id]
		if tenant_id:
			items = [item for item in items if item.get("tenant_id") == tenant_id]
		if workspace_id:
			items = [item for item in items if item.get("workspace_id") == workspace_id]
		if principal_id:
			items = [item for item in items if item.get("principal_id") == principal_id]
		items.sort(key=lambda item: item.get("created_at") or "", reverse=True)
		return items[: max(1, min(limit, 200))]

	def get_turn(
		self,
		turn_id: str,
		*,
		tenant_id: str,
		workspace_id: str,
		principal_id: str,
	) -> dict[str, Any] | None:
		with self._lock:
			data = self._read()
			item = data.get("turns", {}).get(turn_id)
			if (
				item
				and item.get("tenant_id") == tenant_id
				and item.get("workspace_id") == workspace_id
				and item.get("principal_id") == principal_id
			):
				return dict(item)
			return None


class SqlAlchemyMetadataStore(MetadataStore):
	"""Optional Postgres-backed metadata when DATABASE_URL is set."""

	def __init__(self, database_url: str) -> None:
		class Base(DeclarativeBase):
			metadata = MetaData()

		class LibraryRow(Base):
			__tablename__ = "libraries"

			id: Mapped[str] = mapped_column(String(128), primary_key=True)
			tenant_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
			workspace_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
			name: Mapped[str] = mapped_column(String(256), nullable=False)
			description: Mapped[str | None] = mapped_column(Text, nullable=True)
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
			tenant_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
			workspace_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
			name: Mapped[str] = mapped_column(String(512), nullable=False)
			filename: Mapped[str] = mapped_column(String(512), nullable=False)
			content_type: Mapped[str] = mapped_column(String(128), nullable=False, default="")
			status: Mapped[str] = mapped_column(String(32), nullable=False, default="processing")
			chunk_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
			size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
			error: Mapped[str | None] = mapped_column(Text, nullable=True)
			# JSON string：页级 text/ocr/vlm/failed 账本（诚实失败 / partial）
			parser_report: Mapped[str | None] = mapped_column(Text, nullable=True)
			storage_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
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

		class ThreadRow(Base):
			__tablename__ = "threads"

			id: Mapped[str] = mapped_column(String(128), primary_key=True)
			session_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
			library_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
			title: Mapped[str] = mapped_column(String(256), nullable=False, default="未命名会话")
			# active = archived & continuable; hidden = soft-hidden from lists
			status: Mapped[str] = mapped_column(String(32), nullable=False, default="active")
			tenant_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
			workspace_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
			principal_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
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

		class TurnRow(Base):
			__tablename__ = "turns"

			id: Mapped[str] = mapped_column(String(128), primary_key=True)
			session_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
			thread_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
			library_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
			question: Mapped[str] = mapped_column(Text, nullable=False)
			answer: Mapped[str] = mapped_column(Text, nullable=False, default="")
			citations_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
			mode: Mapped[str] = mapped_column(String(32), nullable=False, default="stub")
			refused: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
			refuse_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
			# Phase 1：query / plan / judge 可审计字段（旧库 ALTER 补列）
			query_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
			rewrite: Mapped[str | None] = mapped_column(String(64), nullable=True)
			rewritten_query: Mapped[str | None] = mapped_column(Text, nullable=True)
			judge_json: Mapped[str | None] = mapped_column(Text, nullable=True)
			retrieval_plan_json: Mapped[str | None] = mapped_column(Text, nullable=True)
			retrieval_debug_json: Mapped[str | None] = mapped_column(Text, nullable=True)
			document_version_id: Mapped[str | None] = mapped_column(String(256), nullable=True)
			tenant_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
			workspace_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
			principal_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
			created_at: Mapped[datetime] = mapped_column(
				DateTime(timezone=True),
				server_default=func.now(),
				nullable=False,
			)

		self._LibraryRow = LibraryRow
		self._DocumentRow = DocumentRow
		self._ThreadRow = ThreadRow
		self._TurnRow = TurnRow
		self._select = select
		self._engine = create_engine(database_url, pool_pre_ping=True)
		Base.metadata.create_all(self._engine)
		# 已有库补列（create_all 不会 ALTER）
		try:
			from sqlalchemy import text as sql_text

			with self._engine.begin() as conn:
				conn.execute(
					sql_text(
						"ALTER TABLE documents ADD COLUMN IF NOT EXISTS parser_report TEXT"
					)
				)
				conn.execute(
					sql_text(
						"ALTER TABLE documents ADD COLUMN IF NOT EXISTS storage_key VARCHAR(512)"
					)
				)
				conn.execute(
					sql_text(
						"ALTER TABLE documents ADD COLUMN IF NOT EXISTS size_bytes INTEGER"
					)
				)
				conn.execute(
					sql_text(
						"ALTER TABLE libraries ADD COLUMN IF NOT EXISTS description TEXT"
					)
				)
				for stmt in (
					"ALTER TABLE libraries ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(128)",
					"ALTER TABLE libraries ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(128)",
					"ALTER TABLE documents ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(128)",
					"ALTER TABLE documents ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(128)",
					"""
					DO $$
					BEGIN
						IF to_regclass('app.libraries') IS NOT NULL THEN
							EXECUTE '
								UPDATE public.libraries AS public_library
								SET tenant_id = control_library.organization_id::text,
									workspace_id = control_library.workspace_id::text
								FROM app.libraries AS control_library
								WHERE control_library.rag_library_id = public_library.id
									AND (
										public_library.tenant_id IS NULL
										OR public_library.workspace_id IS NULL
									)
							';
						END IF;
					END $$;
					""",
					"""
					DO $$
					BEGIN
						IF (
							to_regclass('app.documents') IS NOT NULL
							AND to_regclass('app.libraries') IS NOT NULL
						) THEN
							EXECUTE '
								UPDATE public.documents AS public_document
								SET tenant_id = control_document.organization_id::text,
									workspace_id = control_document.workspace_id::text
								FROM app.documents AS control_document
								JOIN app.libraries AS control_library
									ON control_library.id = control_document.library_id
								WHERE control_document.rag_document_id = public_document.id
									AND control_library.rag_library_id = public_document.library_id
									AND (
										public_document.tenant_id IS NULL
										OR public_document.workspace_id IS NULL
									)
							';
						END IF;
					END $$;
					""",
					"CREATE INDEX IF NOT EXISTS ix_libraries_scope ON libraries (tenant_id, workspace_id)",
					"CREATE INDEX IF NOT EXISTS ix_documents_scope ON documents (tenant_id, workspace_id)",
					"ALTER TABLE turns ADD COLUMN IF NOT EXISTS query_type VARCHAR(64)",
					"ALTER TABLE turns ADD COLUMN IF NOT EXISTS rewrite VARCHAR(64)",
					"ALTER TABLE turns ADD COLUMN IF NOT EXISTS rewritten_query TEXT",
					"ALTER TABLE turns ADD COLUMN IF NOT EXISTS judge_json TEXT",
					"ALTER TABLE turns ADD COLUMN IF NOT EXISTS retrieval_plan_json TEXT",
					"ALTER TABLE turns ADD COLUMN IF NOT EXISTS retrieval_debug_json TEXT",
					"ALTER TABLE turns ADD COLUMN IF NOT EXISTS document_version_id VARCHAR(256)",
					"ALTER TABLE turns ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(128)",
					"ALTER TABLE turns ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(128)",
					"ALTER TABLE turns ADD COLUMN IF NOT EXISTS principal_id VARCHAR(128)",
					"ALTER TABLE turns ADD COLUMN IF NOT EXISTS thread_id VARCHAR(128)",
					"CREATE INDEX IF NOT EXISTS ix_turns_thread_id ON turns (thread_id)",
					"CREATE INDEX IF NOT EXISTS ix_threads_scope ON threads (tenant_id, workspace_id, principal_id)",
				):
					conn.execute(sql_text(stmt))
		except Exception as exc:
			logger.exception("metadata.schema_upgrade_failed")
			raise RuntimeError(
				"Postgres metadata schema upgrade failed; "
				"verify ALTER permission and apply the required columns before startup"
			) from exc
		self._Session = sessionmaker(bind=self._engine, expire_on_commit=False, class_=Session)

	@staticmethod
	def _dt(value: datetime | None) -> str:
		if value is None:
			return _now_iso()
		if value.tzinfo is None:
			value = value.replace(tzinfo=UTC)
		# Keep microseconds so same-second turns stay chronologically sortable.
		return value.astimezone(UTC).isoformat().replace("+00:00", "Z")

	def _library_dict(self, row: Any) -> dict[str, Any]:
		return {
			"id": row.id,
			"tenant_id": row.tenant_id,
			"workspace_id": row.workspace_id,
			"name": row.name,
			"description": getattr(row, "description", None),
			"status": row.status,
			"doc_count": int(row.doc_count),
			"ready_count": int(row.ready_count),
			"created_at": self._dt(row.created_at),
			"updated_at": self._dt(row.updated_at),
		}

	def _document_dict(self, row: Any) -> dict[str, Any]:
		report = None
		raw_report = getattr(row, "parser_report", None)
		if raw_report:
			try:
				parsed = json.loads(raw_report)
				if isinstance(parsed, dict):
					report = parsed
			except json.JSONDecodeError:
				report = None
		raw_size = getattr(row, "size_bytes", None)
		return {
			"id": row.id,
			"library_id": row.library_id,
			"tenant_id": row.tenant_id,
			"workspace_id": row.workspace_id,
			"name": row.name,
			"filename": row.filename,
			"content_type": row.content_type,
			"status": row.status,
			"chunk_count": int(row.chunk_count),
			"size_bytes": int(raw_size) if raw_size is not None else None,
			"error": row.error,
			"parser_report": report,
			"storage_key": getattr(row, "storage_key", None),
			"created_at": self._dt(row.created_at),
			"updated_at": self._dt(row.updated_at),
		}

	def _turn_dict(self, row: Any) -> dict[str, Any]:
		try:
			citations = json.loads(row.citations_json or "[]")
		except json.JSONDecodeError:
			citations = []
		if not isinstance(citations, list):
			citations = []

		def _load_obj(raw: str | None) -> dict[str, Any] | None:
			if not raw:
				return None
			try:
				value = json.loads(raw)
			except json.JSONDecodeError:
				return None
			return value if isinstance(value, dict) else None

		return {
			"id": row.id,
			"session_id": row.session_id,
			"thread_id": getattr(row, "thread_id", None),
			"library_id": row.library_id,
			"question": row.question,
			"answer": row.answer,
			"citations": citations,
			"mode": row.mode,
			"refused": bool(row.refused),
			"refuse_reason": row.refuse_reason,
			"query_type": getattr(row, "query_type", None),
			"rewrite": getattr(row, "rewrite", None),
			"rewritten_query": getattr(row, "rewritten_query", None),
			"judge": _load_obj(getattr(row, "judge_json", None)),
			"retrieval_plan": _load_obj(getattr(row, "retrieval_plan_json", None)),
			"retrieval_debug": _load_obj(getattr(row, "retrieval_debug_json", None)),
			"document_version_id": getattr(row, "document_version_id", None),
			"tenant_id": getattr(row, "tenant_id", None),
			"workspace_id": getattr(row, "workspace_id", None),
			"principal_id": getattr(row, "principal_id", None),
			"created_at": self._dt(row.created_at),
		}

	def _thread_dict(self, row: Any, *, turn_count: int | None = None) -> dict[str, Any]:
		payload = {
			"id": row.id,
			"session_id": getattr(row, "session_id", None),
			"library_id": getattr(row, "library_id", None),
			"title": row.title,
			"status": row.status,
			"tenant_id": row.tenant_id,
			"workspace_id": row.workspace_id,
			"principal_id": row.principal_id,
			"created_at": self._dt(row.created_at),
			"updated_at": self._dt(row.updated_at),
		}
		if turn_count is not None:
			payload["turn_count"] = turn_count
		return payload

	def list_libraries(self, *, scope: AccessScope) -> list[dict[str, Any]]:
		with self._Session() as session:
			rows = session.scalars(
				self._select(self._LibraryRow)
				.where(
					self._LibraryRow.tenant_id == scope.tenant_id,
					self._LibraryRow.workspace_id == scope.workspace_id,
				)
				.order_by(self._LibraryRow.updated_at.desc())
			).all()
			return [self._library_dict(row) for row in rows]

	def get_library(
		self,
		library_id: str,
		*,
		scope: AccessScope,
	) -> dict[str, Any] | None:
		with self._Session() as session:
			row = session.scalar(
				self._select(self._LibraryRow).where(
					self._LibraryRow.id == library_id,
					self._LibraryRow.tenant_id == scope.tenant_id,
					self._LibraryRow.workspace_id == scope.workspace_id,
				)
			)
			return self._library_dict(row) if row else None

	def create_library(
		self,
		*,
		name: str,
		library_id: str | None = None,
		description: str | None = None,
		scope: AccessScope,
	) -> dict[str, Any]:
		resolved = library_id or str(uuid4())
		desc = description.strip()[:2000] if isinstance(description, str) and description.strip() else None
		with self._Session() as session:
			if session.get(self._LibraryRow, resolved) is not None:
				raise ValueError(f"library already exists: {resolved}")
			row = self._LibraryRow(
				id=resolved,
				tenant_id=scope.tenant_id,
				workspace_id=scope.workspace_id,
				name=name.strip()[:256] or "未命名知识库",
				description=desc,
				status="empty",
				doc_count=0,
				ready_count=0,
			)
			session.add(row)
			session.commit()
			session.refresh(row)
			return self._library_dict(row)

	def update_library(
		self,
		library_id: str,
		*,
		name: str | None = None,
		description: str | None = None,
		update_description: bool = False,
		scope: AccessScope,
	) -> dict[str, Any] | None:
		with self._Session() as session:
			row = session.scalar(
				self._select(self._LibraryRow).where(
					self._LibraryRow.id == library_id,
					self._LibraryRow.tenant_id == scope.tenant_id,
					self._LibraryRow.workspace_id == scope.workspace_id,
				)
			)
			if row is None:
				return None
			if name is not None:
				row.name = name.strip()[:256] or "未命名知识库"
			if update_description:
				if isinstance(description, str) and description.strip():
					row.description = description.strip()[:2000]
				else:
					row.description = None
			session.commit()
			session.refresh(row)
			return self._library_dict(row)

	def delete_library(self, library_id: str, *, scope: AccessScope) -> bool:
		with self._Session() as session:
			library = session.scalar(
				self._select(self._LibraryRow).where(
					self._LibraryRow.id == library_id,
					self._LibraryRow.tenant_id == scope.tenant_id,
					self._LibraryRow.workspace_id == scope.workspace_id,
				)
			)
			if library is None:
				return False
			docs = session.scalars(
				self._select(self._DocumentRow).where(
					self._DocumentRow.library_id == library_id,
					self._DocumentRow.tenant_id == scope.tenant_id,
					self._DocumentRow.workspace_id == scope.workspace_id,
				)
			).all()
			for doc in docs:
				session.delete(doc)
			session.delete(library)
			session.commit()
			return True

	def list_documents(
		self,
		library_id: str,
		*,
		scope: AccessScope,
	) -> list[dict[str, Any]]:
		with self._Session() as session:
			library = session.scalar(
				self._select(self._LibraryRow.id).where(
					self._LibraryRow.id == library_id,
					self._LibraryRow.tenant_id == scope.tenant_id,
					self._LibraryRow.workspace_id == scope.workspace_id,
				)
			)
			if library is None:
				return []
			rows = session.scalars(
				self._select(self._DocumentRow)
				.where(
					self._DocumentRow.library_id == library_id,
					self._DocumentRow.tenant_id == scope.tenant_id,
					self._DocumentRow.workspace_id == scope.workspace_id,
				)
				.order_by(self._DocumentRow.updated_at.desc())
			).all()
			return [self._document_dict(row) for row in rows]

	def get_document(
		self,
		doc_id: str,
		*,
		scope: AccessScope,
	) -> dict[str, Any] | None:
		with self._Session() as session:
			row = session.scalar(
				self._select(self._DocumentRow).where(
					self._DocumentRow.id == doc_id,
					self._DocumentRow.tenant_id == scope.tenant_id,
					self._DocumentRow.workspace_id == scope.workspace_id,
				)
			)
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
		storage_key: str | None = None,
		size_bytes: int | None = None,
		scope: AccessScope,
	) -> dict[str, Any]:
		resolved = doc_id or str(uuid4())
		with self._Session() as session:
			library = session.scalar(
				self._select(self._LibraryRow.id).where(
					self._LibraryRow.id == library_id,
					self._LibraryRow.tenant_id == scope.tenant_id,
					self._LibraryRow.workspace_id == scope.workspace_id,
				)
			)
			if library is None:
				raise ValueError(f"library not found: {library_id}")
			if session.get(self._DocumentRow, resolved) is not None:
				raise ValueError(f"document already exists: {resolved}")
			row = self._DocumentRow(
				id=resolved,
				library_id=library_id,
				tenant_id=scope.tenant_id,
				workspace_id=scope.workspace_id,
				name=name.strip()[:512] or filename,
				filename=filename,
				content_type=content_type,
				status=status,
				chunk_count=0,
				size_bytes=int(size_bytes) if size_bytes is not None else None,
				error=None,
				storage_key=storage_key,
			)
			session.add(row)
			session.commit()
			session.refresh(row)
			payload = self._document_dict(row)
		self.refresh_library_counts(library_id, scope=scope)
		return payload

	def update_document(
		self,
		doc_id: str,
		*,
		status: DocumentStatus | None = None,
		chunk_count: int | None = None,
		error: str | None = None,
		parser_report: dict[str, Any] | None = None,
		storage_key: str | None = None,
		size_bytes: int | None = None,
		name: str | None = None,
		filename: str | None = None,
		content_type: str | None = None,
		clear_error: bool = False,
		scope: AccessScope,
	) -> dict[str, Any] | None:
		with self._Session() as session:
			row = session.scalar(
				self._select(self._DocumentRow).where(
					self._DocumentRow.id == doc_id,
					self._DocumentRow.tenant_id == scope.tenant_id,
					self._DocumentRow.workspace_id == scope.workspace_id,
				)
			)
			if row is None:
				return None
			if status is not None:
				row.status = status
			if chunk_count is not None:
				row.chunk_count = int(chunk_count)
			if clear_error:
				row.error = None
			elif error is not None:
				row.error = error
			if parser_report is not None:
				row.parser_report = json.dumps(parser_report, ensure_ascii=False)
			if storage_key is not None:
				row.storage_key = storage_key
			if size_bytes is not None:
				row.size_bytes = int(size_bytes)
			if name is not None:
				row.name = name
			if filename is not None:
				row.filename = filename
			if content_type is not None:
				row.content_type = content_type
			library_id = row.library_id
			session.commit()
			session.refresh(row)
			payload = self._document_dict(row)
		self.refresh_library_counts(library_id, scope=scope)
		return payload

	def delete_document(self, doc_id: str, *, scope: AccessScope) -> bool:
		with self._Session() as session:
			row = session.scalar(
				self._select(self._DocumentRow).where(
					self._DocumentRow.id == doc_id,
					self._DocumentRow.tenant_id == scope.tenant_id,
					self._DocumentRow.workspace_id == scope.workspace_id,
				)
			)
			if row is None:
				return False
			library_id = row.library_id
			session.delete(row)
			session.commit()
		self.refresh_library_counts(library_id, scope=scope)
		return True

	def refresh_library_counts(
		self,
		library_id: str,
		*,
		scope: AccessScope,
	) -> dict[str, Any] | None:
		with self._Session() as session:
			library = session.scalar(
				self._select(self._LibraryRow).where(
					self._LibraryRow.id == library_id,
					self._LibraryRow.tenant_id == scope.tenant_id,
					self._LibraryRow.workspace_id == scope.workspace_id,
				)
			)
			if library is None:
				return None
			docs = session.scalars(
				self._select(self._DocumentRow).where(
					self._DocumentRow.library_id == library_id,
					self._DocumentRow.tenant_id == scope.tenant_id,
					self._DocumentRow.workspace_id == scope.workspace_id,
				)
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

	def create_thread(
		self,
		*,
		title: str,
		session_id: str | None = None,
		library_id: str | None = None,
		thread_id: str | None = None,
		status: str = "active",
		tenant_id: str | None = None,
		workspace_id: str | None = None,
		principal_id: str | None = None,
	) -> dict[str, Any]:
		resolved = thread_id or str(uuid4())
		resolved_status = status if status in {"active", "hidden"} else "active"
		with self._Session() as session:
			row = self._ThreadRow(
				id=resolved,
				session_id=session_id,
				library_id=library_id,
				title=(title or "").strip()[:256] or "未命名会话",
				status=resolved_status,
				tenant_id=tenant_id or "default",
				workspace_id=workspace_id or "default",
				principal_id=principal_id or "development",
			)
			session.add(row)
			session.commit()
			session.refresh(row)
			return self._thread_dict(row, turn_count=0)

	def list_threads(
		self,
		*,
		tenant_id: str,
		workspace_id: str,
		principal_id: str,
		status: str | None = "active",
		limit: int = 50,
	) -> list[dict[str, Any]]:
		capped = max(1, min(limit, 200))
		with self._Session() as session:
			stmt = (
				self._select(self._ThreadRow)
				.where(
					self._ThreadRow.tenant_id == tenant_id,
					self._ThreadRow.workspace_id == workspace_id,
					self._ThreadRow.principal_id == principal_id,
				)
				.order_by(self._ThreadRow.updated_at.desc())
			)
			if status:
				stmt = stmt.where(self._ThreadRow.status == status)
			stmt = stmt.limit(capped)
			rows = session.scalars(stmt).all()
			out: list[dict[str, Any]] = []
			for row in rows:
				count = len(
					session.scalars(
						self._select(self._TurnRow.id).where(
							self._TurnRow.thread_id == row.id,
							self._TurnRow.tenant_id == tenant_id,
							self._TurnRow.workspace_id == workspace_id,
							self._TurnRow.principal_id == principal_id,
						)
					).all()
				)
				out.append(self._thread_dict(row, turn_count=count))
			return out

	def get_thread(
		self,
		thread_id: str,
		*,
		tenant_id: str,
		workspace_id: str,
		principal_id: str,
	) -> dict[str, Any] | None:
		with self._Session() as session:
			row = session.scalar(
				self._select(self._ThreadRow).where(
					self._ThreadRow.id == thread_id,
					self._ThreadRow.tenant_id == tenant_id,
					self._ThreadRow.workspace_id == workspace_id,
					self._ThreadRow.principal_id == principal_id,
				)
			)
			if row is None:
				return None
			count = len(
				session.scalars(
					self._select(self._TurnRow.id).where(self._TurnRow.thread_id == thread_id)
				).all()
			)
			return self._thread_dict(row, turn_count=count)

	def touch_thread(
		self,
		thread_id: str,
		*,
		tenant_id: str,
		workspace_id: str,
		principal_id: str,
		title: str | None = None,
	) -> dict[str, Any] | None:
		with self._Session() as session:
			row = session.scalar(
				self._select(self._ThreadRow).where(
					self._ThreadRow.id == thread_id,
					self._ThreadRow.tenant_id == tenant_id,
					self._ThreadRow.workspace_id == workspace_id,
					self._ThreadRow.principal_id == principal_id,
				)
			)
			if row is None:
				return None
			if title is not None and title.strip():
				row.title = title.strip()[:256]
			row.updated_at = datetime.now(UTC)
			session.commit()
			session.refresh(row)
			return self._thread_dict(row)

	def create_turn(
		self,
		*,
		session_id: str,
		library_id: str | None,
		question: str,
		answer: str,
		citations: list[dict[str, Any]],
		mode: str,
		refused: bool = False,
		refuse_reason: str | None = None,
		turn_id: str | None = None,
		thread_id: str | None = None,
		query_type: str | None = None,
		retrieval_plan: dict[str, Any] | None = None,
		retrieval_debug: dict[str, Any] | None = None,
		rewrite: str | None = None,
		rewritten_query: str | None = None,
		judge: dict[str, Any] | None = None,
		document_version_id: str | None = None,
		tenant_id: str | None = None,
		workspace_id: str | None = None,
		principal_id: str | None = None,
	) -> dict[str, Any]:
		resolved = turn_id or str(uuid4())
		with self._Session() as session:
			row = self._TurnRow(
				id=resolved,
				session_id=session_id,
				thread_id=thread_id,
				library_id=library_id,
				question=question,
				answer=answer,
				citations_json=json.dumps(citations, ensure_ascii=False),
				mode=mode,
				refused=1 if refused else 0,
				refuse_reason=refuse_reason,
				query_type=query_type,
				rewrite=rewrite,
				rewritten_query=rewritten_query,
				judge_json=json.dumps(judge, ensure_ascii=False) if judge is not None else None,
				retrieval_plan_json=(
					json.dumps(retrieval_plan, ensure_ascii=False)
					if retrieval_plan is not None
					else None
				),
				retrieval_debug_json=(
					json.dumps(retrieval_debug, ensure_ascii=False)
					if retrieval_debug is not None
					else None
				),
				document_version_id=document_version_id,
				tenant_id=tenant_id or "default",
				workspace_id=workspace_id or "default",
				principal_id=principal_id or "development",
			)
			session.add(row)
			if thread_id:
				thread = session.scalar(
					self._select(self._ThreadRow).where(self._ThreadRow.id == thread_id)
				)
				if thread is not None:
					thread.updated_at = datetime.now(UTC)
			session.commit()
			session.refresh(row)
			return self._turn_dict(row)

	def list_turns(
		self,
		*,
		library_id: str | None = None,
		session_id: str | None = None,
		thread_id: str | None = None,
		tenant_id: str | None = None,
		workspace_id: str | None = None,
		principal_id: str | None = None,
		limit: int = 50,
	) -> list[dict[str, Any]]:
		if not tenant_id or not workspace_id or not principal_id:
			raise ValueError("tenant_id, workspace_id and principal_id are required")
		capped = max(1, min(limit, 200))
		with self._Session() as session:
			stmt = self._select(self._TurnRow).order_by(self._TurnRow.created_at.desc())
			if library_id:
				stmt = stmt.where(self._TurnRow.library_id == library_id)
			if session_id:
				stmt = stmt.where(self._TurnRow.session_id == session_id)
			if thread_id:
				stmt = stmt.where(self._TurnRow.thread_id == thread_id)
			if tenant_id:
				stmt = stmt.where(self._TurnRow.tenant_id == tenant_id)
			if workspace_id:
				stmt = stmt.where(self._TurnRow.workspace_id == workspace_id)
			if principal_id:
				stmt = stmt.where(self._TurnRow.principal_id == principal_id)
			stmt = stmt.limit(capped)
			rows = session.scalars(stmt).all()
			return [self._turn_dict(row) for row in rows]

	def get_turn(
		self,
		turn_id: str,
		*,
		tenant_id: str,
		workspace_id: str,
		principal_id: str,
	) -> dict[str, Any] | None:
		with self._Session() as session:
			row = session.scalar(
				self._select(self._TurnRow).where(
					self._TurnRow.id == turn_id,
					self._TurnRow.tenant_id == tenant_id,
					self._TurnRow.workspace_id == workspace_id,
					self._TurnRow.principal_id == principal_id,
				)
			)
			return self._turn_dict(row) if row else None


_store: MetadataStore | None = None
_store_lock = threading.Lock()


def get_metadata_store(settings: Any | None = None) -> MetadataStore:
	"""Resolve metadata store. Postgres is required unless METADATA_BACKEND=json."""
	global _store
	from app.settings import get_settings

	cfg = settings or get_settings()
	with _store_lock:
		if _store is not None:
			return _store

		backend = (getattr(cfg, "metadata_backend", "postgres") or "postgres").strip().lower()
		if backend == "json":
			path = Path(getattr(cfg, "metadata_path", "data/metadata.json"))
			_store = JsonMetadataStore(path)
			logger.warning(
				"metadata.backend=json path=%s (explicit escape hatch; not for production)",
				path,
			)
			return _store

		database_url = (getattr(cfg, "database_url", "") or "").strip()
		if not database_url:
			raise RuntimeError(
				"DATABASE_URL is required when METADATA_BACKEND=postgres. "
				"Start Postgres via `docker compose up -d`, or set METADATA_BACKEND=json only for local tests."
			)
		try:
			_store = SqlAlchemyMetadataStore(_sqlalchemy_database_url(database_url))
		except Exception as exc:
			logger.exception("metadata.postgres_failed")
			raise RuntimeError(
				f"Postgres metadata store failed to initialize ({exc}). "
				"Fix DATABASE_URL / docker compose postgres — MeriKnow does not fall back to JSON."
			) from exc
		logger.info("metadata.backend=postgres")
		return _store


def probe_metadata_store(settings: Any | None = None) -> tuple[bool, str, str]:
	"""Return (ok, backend, detail). Used by health / startup."""
	from app.settings import get_settings

	cfg = settings or get_settings()
	backend = (cfg.metadata_backend or "postgres").strip().lower()
	if backend == "json":
		return True, "json", "explicit METADATA_BACKEND=json"
	try:
		store = get_metadata_store(cfg)
		# cheap round-trip
		store.list_libraries(scope=AccessScope.development(cfg))
		name = "postgres" if store.__class__.__name__.startswith("SqlAlchemy") else store.__class__.__name__
		return True, name, "ok"
	except Exception as exc:
		return False, "postgres", str(exc)


def reset_metadata_store() -> None:
	global _store
	with _store_lock:
		_store = None
