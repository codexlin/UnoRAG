from __future__ import annotations

import json
import logging
import threading
from abc import ABC, abstractmethod
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from uuid import UUID, uuid4

from sqlalchemy import DateTime, Integer, MetaData, String, Text, create_engine, func, select, text
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

	def __init__(
		self,
		database_url: str,
		*,
		conversation_store_schema: str = "public",
		conversation_database_url: str | None = None,
	) -> None:
		resolved_conversation_schema = conversation_store_schema.strip().lower()
		if resolved_conversation_schema not in {"public", "app"}:
			raise ValueError("conversation_store_schema must be public or app")
		self._conversation_store_schema = resolved_conversation_schema

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
		self._conversation_engine = (
			create_engine(conversation_database_url, pool_pre_ping=True)
			if self._conversation_store_schema == "app" and conversation_database_url
			else self._engine
		)
		try:
			from sqlalchemy import text as sql_text

			with self._engine.connect() as conn:
				conn.execute(
					sql_text(
						"""
						SELECT
							library.tenant_id,
							document.parser_report,
							thread.principal_id,
							turn.retrieval_debug_json
						FROM public.libraries AS library
						LEFT JOIN public.documents AS document ON false
						LEFT JOIN public.threads AS thread ON false
						LEFT JOIN public.turns AS turn ON false
						LIMIT 0
						"""
					)
				)
			if self._conversation_store_schema == "app":
				with self._conversation_engine.connect() as conn:
					conn.execute(
						sql_text(
							"""
							SELECT
								thread.organization_id,
								thread.session_id,
								turn.sequence,
								turn.citations,
								turn.debug
							FROM app.threads AS thread
							LEFT JOIN app.turns AS turn ON false
							LIMIT 0
							"""
						)
					)
		except Exception as exc:
			logger.exception("metadata.schema_validation_failed")
			migration_hint = (
				"run the web Drizzle migrations through 0015"
				if self._conversation_store_schema == "app"
				else "run scripts/apply_rag_migrations.py with MIGRATOR_DATABASE_URL"
			)
			raise RuntimeError(
				f"Postgres metadata schema is missing or outdated; {migration_hint}"
			) from exc
		self._Session = sessionmaker(bind=self._engine, expire_on_commit=False, class_=Session)
		self._ConversationSession = sessionmaker(
			bind=self._conversation_engine,
			expire_on_commit=False,
			class_=Session,
		)

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

	@staticmethod
	def _app_uuid(value: str | UUID | None, field: str) -> UUID:
		if value is None or not str(value).strip():
			raise ValueError(f"{field} is required in app conversation mode")
		try:
			return UUID(str(value))
		except (TypeError, ValueError) as exc:
			raise ValueError(f"{field} must be a UUID in app conversation mode") from exc

	@staticmethod
	def _app_optional_uuid(value: str | UUID | None) -> UUID | None:
		if value is None or not str(value).strip():
			return None
		try:
			return UUID(str(value))
		except (TypeError, ValueError):
			return None

	def _app_scope(
		self,
		*,
		tenant_id: str | None,
		workspace_id: str | None,
		principal_id: str | None,
	) -> dict[str, UUID]:
		return {
			"organization_id": self._app_uuid(tenant_id, "tenant_id"),
			"workspace_id": self._app_uuid(workspace_id, "workspace_id"),
			"principal_id": self._app_uuid(principal_id, "principal_id"),
		}

	def _app_thread_payload(
		self,
		row: Any,
		*,
		turn_count: int | None = None,
	) -> dict[str, Any]:
		payload = {
			"id": str(row["id"]),
			"session_id": row["session_id"],
			"library_id": row["rag_library_id"],
			"title": row["title"] or "未命名会话",
			"status": row["status"],
			"tenant_id": str(row["organization_id"]),
			"workspace_id": str(row["workspace_id"]),
			"principal_id": str(row["principal_id"]),
			"created_at": self._dt(row["created_at"]),
			"updated_at": self._dt(row["updated_at"]),
		}
		if turn_count is not None:
			payload["turn_count"] = int(turn_count)
		return payload

	def _app_turn_payload(self, row: Any) -> dict[str, Any]:
		debug = row["debug"] if isinstance(row["debug"], dict) else {}
		citations = row["citations"] if isinstance(row["citations"], list) else []

		def _debug_object(key: str) -> dict[str, Any] | None:
			value = debug.get(key)
			return value if isinstance(value, dict) else None

		return {
			"id": str(row["id"]),
			"session_id": str(row["session_id"]),
			"thread_id": str(row["thread_id"]),
			"library_id": row["rag_library_id"],
			"question": row["question"],
			"answer": row["answer"],
			"citations": citations,
			"mode": debug.get("mode") if isinstance(debug.get("mode"), str) else "live",
			"refused": debug.get("refused") is True,
			"refuse_reason": (
				debug.get("refuse_reason")
				if isinstance(debug.get("refuse_reason"), str)
				else None
			),
			"query_type": (
				debug.get("query_type")
				if isinstance(debug.get("query_type"), str)
				else None
			),
			"rewrite": debug.get("rewrite") if isinstance(debug.get("rewrite"), str) else None,
			"rewritten_query": (
				debug.get("rewritten_query")
				if isinstance(debug.get("rewritten_query"), str)
				else None
			),
			"judge": _debug_object("judge"),
			"retrieval_plan": _debug_object("retrieval_plan"),
			"retrieval_debug": _debug_object("retrieval_debug"),
			"document_version_id": (
				debug.get("document_version_id")
				if isinstance(debug.get("document_version_id"), str)
				else None
			),
			"tenant_id": str(row["organization_id"]),
			"workspace_id": str(row["workspace_id"]),
			"principal_id": str(row["principal_id"]),
			"created_at": self._dt(row["created_at"]),
		}

	@staticmethod
	def _app_pairs_sql(extra_where: str = "") -> str:
		return f"""
			SELECT
				assistant.id,
				assistant.thread_id,
				assistant.organization_id,
				assistant.workspace_id,
				assistant.principal_id,
				COALESCE(thread.session_id, thread.id::text) AS session_id,
				thread.rag_library_id,
				question.content AS question,
				assistant.content AS answer,
				assistant.citations,
				assistant.debug,
				assistant.created_at
			FROM app.turns AS assistant
			JOIN app.threads AS thread
				ON thread.id = assistant.thread_id
				AND thread.organization_id = assistant.organization_id
				AND thread.workspace_id = assistant.workspace_id
				AND thread.principal_id = assistant.principal_id
			JOIN LATERAL (
				SELECT candidate.content
				FROM app.turns AS candidate
				WHERE candidate.thread_id = assistant.thread_id
					AND candidate.organization_id = assistant.organization_id
					AND candidate.workspace_id = assistant.workspace_id
					AND candidate.principal_id = assistant.principal_id
					AND candidate.role = 'user'
					AND candidate.sequence < assistant.sequence
					AND NOT EXISTS (
						SELECT 1
						FROM app.turns AS consumed
						WHERE consumed.thread_id = assistant.thread_id
							AND consumed.organization_id = assistant.organization_id
							AND consumed.workspace_id = assistant.workspace_id
							AND consumed.principal_id = assistant.principal_id
							AND consumed.role = 'assistant'
							AND consumed.sequence > candidate.sequence
							AND consumed.sequence < assistant.sequence
					)
				ORDER BY candidate.sequence DESC
				LIMIT 1
			) AS question ON true
			WHERE assistant.role = 'assistant'
				AND assistant.organization_id = :organization_id
				AND assistant.workspace_id = :workspace_id
				AND assistant.principal_id = :principal_id
				{extra_where}
		"""

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
		if self._conversation_store_schema == "app":
			scope = self._app_scope(
				tenant_id=tenant_id,
				workspace_id=workspace_id,
				principal_id=principal_id,
			)
			resolved = self._app_uuid(thread_id, "thread_id") if thread_id else uuid4()
			resolved_status = status if status in {"active", "hidden"} else "active"
			if session_id is not None and len(session_id) > 128:
				raise ValueError("session_id exceeds 128 characters")
			with self._ConversationSession.begin() as session:
				row = session.execute(
					text(
						"""
						INSERT INTO app.threads (
							id, organization_id, workspace_id, principal_id,
							session_id, rag_library_id, title, status
						)
						VALUES (
							:id, :organization_id, :workspace_id, :principal_id,
							:session_id, :rag_library_id, :title, :status
						)
						RETURNING *
						"""
					),
					{
						**scope,
						"id": resolved,
						"session_id": session_id,
						"rag_library_id": library_id,
						"title": (title or "").strip()[:256] or "未命名会话",
						"status": resolved_status,
					},
				).mappings().one()
				return self._app_thread_payload(row, turn_count=0)

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
		if self._conversation_store_schema == "app":
			scope = self._app_scope(
				tenant_id=tenant_id,
				workspace_id=workspace_id,
				principal_id=principal_id,
			)
			capped = max(1, min(limit, 200))
			status_clause = "AND thread.status = :status" if status else ""
			with self._ConversationSession() as session:
				rows = session.execute(
					text(
						f"""
						SELECT
							thread.*,
							COUNT(turn.id) FILTER (WHERE turn.role = 'assistant') AS turn_count
						FROM app.threads AS thread
						LEFT JOIN app.turns AS turn
							ON turn.thread_id = thread.id
							AND turn.organization_id = thread.organization_id
							AND turn.workspace_id = thread.workspace_id
							AND turn.principal_id = thread.principal_id
						WHERE thread.organization_id = :organization_id
							AND thread.workspace_id = :workspace_id
							AND thread.principal_id = :principal_id
							{status_clause}
						GROUP BY thread.id
						ORDER BY thread.updated_at DESC, thread.created_at DESC, thread.id DESC
						LIMIT :limit
						"""
					),
					{**scope, "status": status, "limit": capped},
				).mappings().all()
				return [
					self._app_thread_payload(row, turn_count=row["turn_count"])
					for row in rows
				]

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
		if self._conversation_store_schema == "app":
			resolved_thread_id = self._app_optional_uuid(thread_id)
			if resolved_thread_id is None:
				return None
			scope = self._app_scope(
				tenant_id=tenant_id,
				workspace_id=workspace_id,
				principal_id=principal_id,
			)
			with self._ConversationSession() as session:
				row = session.execute(
					text(
						"""
						SELECT
							thread.*,
							COUNT(turn.id) FILTER (WHERE turn.role = 'assistant') AS turn_count
						FROM app.threads AS thread
						LEFT JOIN app.turns AS turn
							ON turn.thread_id = thread.id
							AND turn.organization_id = thread.organization_id
							AND turn.workspace_id = thread.workspace_id
							AND turn.principal_id = thread.principal_id
						WHERE thread.id = :thread_id
							AND thread.organization_id = :organization_id
							AND thread.workspace_id = :workspace_id
							AND thread.principal_id = :principal_id
						GROUP BY thread.id
						"""
					),
					{**scope, "thread_id": resolved_thread_id},
				).mappings().one_or_none()
				return (
					self._app_thread_payload(row, turn_count=row["turn_count"])
					if row
					else None
				)

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
		if self._conversation_store_schema == "app":
			resolved_thread_id = self._app_optional_uuid(thread_id)
			if resolved_thread_id is None:
				return None
			scope = self._app_scope(
				tenant_id=tenant_id,
				workspace_id=workspace_id,
				principal_id=principal_id,
			)
			values = {
				**scope,
				"thread_id": resolved_thread_id,
				"title": title.strip()[:256] if title and title.strip() else None,
			}
			with self._ConversationSession.begin() as session:
				row = session.execute(
					text(
						"""
						UPDATE app.threads
						SET
							title = COALESCE(:title, title),
							updated_at = now()
						WHERE id = :thread_id
							AND organization_id = :organization_id
							AND workspace_id = :workspace_id
							AND principal_id = :principal_id
							AND status = 'active'
						RETURNING *
						"""
					),
					values,
				).mappings().one_or_none()
				return self._app_thread_payload(row) if row else None

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
		if self._conversation_store_schema == "app":
			scope = self._app_scope(
				tenant_id=tenant_id,
				workspace_id=workspace_id,
				principal_id=principal_id,
			)
			resolved_thread_id = self._app_uuid(thread_id, "thread_id")
			resolved_turn_id = self._app_uuid(turn_id, "turn_id") if turn_id else uuid4()
			user_turn_id = uuid4()
			debug = {
				"mode": mode,
				"refused": bool(refused),
				"refuse_reason": refuse_reason,
				"query_type": query_type,
				"rewrite": rewrite,
				"rewritten_query": rewritten_query,
				"judge": judge,
				"retrieval_plan": retrieval_plan,
				"retrieval_debug": retrieval_debug,
				"document_version_id": document_version_id,
			}
			with self._ConversationSession.begin() as session:
				thread = session.execute(
					text(
						"""
						SELECT id, session_id, rag_library_id
						FROM app.threads
						WHERE id = :thread_id
							AND organization_id = :organization_id
							AND workspace_id = :workspace_id
							AND principal_id = :principal_id
							AND status = 'active'
						FOR UPDATE
						"""
					),
					{**scope, "thread_id": resolved_thread_id},
				).mappings().one_or_none()
				if thread is None:
					raise ValueError("active thread not found in the requested scope")
				if library_id != thread["rag_library_id"]:
					raise ValueError("library_id does not match the scoped thread")
				if thread["session_id"] is not None and session_id != thread["session_id"]:
					raise ValueError("session_id does not match the scoped thread")

				latest = session.execute(
					text(
						"""
						SELECT COALESCE(MAX(sequence), 0)
						FROM app.turns
						WHERE thread_id = :thread_id
							AND organization_id = :organization_id
							AND workspace_id = :workspace_id
							AND principal_id = :principal_id
						"""
					),
					{**scope, "thread_id": resolved_thread_id},
				).scalar_one()
				user_sequence = int(latest) + 1
				session.execute(
					text(
						"""
						INSERT INTO app.turns (
							id, thread_id, organization_id, workspace_id, principal_id,
							sequence, role, content, citations, debug, status
						)
						VALUES
							(
								:user_id, :thread_id, :organization_id, :workspace_id,
								:principal_id, :user_sequence, 'user', :question,
								'[]'::jsonb, NULL, 'complete'
							),
							(
								:assistant_id, :thread_id, :organization_id, :workspace_id,
								:principal_id, :assistant_sequence, 'assistant', :answer,
								CAST(:citations AS jsonb), CAST(:debug AS jsonb), 'complete'
							)
						"""
					),
					{
						**scope,
						"thread_id": resolved_thread_id,
						"user_id": user_turn_id,
						"assistant_id": resolved_turn_id,
						"user_sequence": user_sequence,
						"assistant_sequence": user_sequence + 1,
						"question": question,
						"answer": answer,
						"citations": json.dumps(citations, ensure_ascii=False),
						"debug": json.dumps(debug, ensure_ascii=False),
					},
				)
				session.execute(
					text(
						"""
						UPDATE app.threads
						SET updated_at = now()
						WHERE id = :thread_id
							AND organization_id = :organization_id
							AND workspace_id = :workspace_id
							AND principal_id = :principal_id
						"""
					),
					{**scope, "thread_id": resolved_thread_id},
				)
				created = session.execute(
					text(self._app_pairs_sql("AND assistant.id = :turn_id")),
					{**scope, "turn_id": resolved_turn_id},
				).mappings().one()
				return self._app_turn_payload(created)

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
		if self._conversation_store_schema == "app":
			scope = self._app_scope(
				tenant_id=tenant_id,
				workspace_id=workspace_id,
				principal_id=principal_id,
			)
			parameters: dict[str, Any] = {
				**scope,
				"limit": max(1, min(limit, 200)),
			}
			clauses: list[str] = []
			if library_id:
				clauses.append("AND thread.rag_library_id = :library_id")
				parameters["library_id"] = library_id
			if session_id:
				clauses.append(
					"AND COALESCE(thread.session_id, thread.id::text) = :session_id"
				)
				parameters["session_id"] = session_id
			if thread_id:
				resolved_thread_id = self._app_optional_uuid(thread_id)
				if resolved_thread_id is None:
					return []
				clauses.append("AND assistant.thread_id = :thread_id")
				parameters["thread_id"] = resolved_thread_id
			query = (
				self._app_pairs_sql("\n".join(clauses))
				+ "\nORDER BY assistant.sequence DESC, assistant.id DESC\nLIMIT :limit"
			)
			with self._ConversationSession() as session:
				rows = session.execute(text(query), parameters).mappings().all()
				return [self._app_turn_payload(row) for row in rows]

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
		if self._conversation_store_schema == "app":
			resolved_turn_id = self._app_optional_uuid(turn_id)
			if resolved_turn_id is None:
				return None
			scope = self._app_scope(
				tenant_id=tenant_id,
				workspace_id=workspace_id,
				principal_id=principal_id,
			)
			with self._ConversationSession() as session:
				row = session.execute(
					text(self._app_pairs_sql("AND assistant.id = :turn_id")),
					{**scope, "turn_id": resolved_turn_id},
				).mappings().one_or_none()
				return self._app_turn_payload(row) if row else None

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
			_store = SqlAlchemyMetadataStore(
				_sqlalchemy_database_url(database_url),
				conversation_store_schema=getattr(
					cfg,
					"conversation_store_schema",
					"public",
				),
				conversation_database_url=(
					_sqlalchemy_database_url(
						getattr(cfg, "conversation_database_url", "")
					)
					if getattr(cfg, "conversation_database_url", "").strip()
					else None
				),
			)
		except Exception as exc:
			logger.exception("metadata.postgres_failed")
			raise RuntimeError(
				f"Postgres metadata store failed to initialize ({exc}). "
				"Fix DATABASE_URL / docker compose postgres — UnoRAG does not fall back to JSON."
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
