"""Test harness: sync seed libraries/documents without FastAPI ingest HTTP (410).

Uses metadata store + DocumentStorage + process_document_ingest / IngestService.
Product uploads remain Next.js → app.jobs → lifecycle_worker.
"""

from __future__ import annotations

from pathlib import PurePosixPath
from typing import Any
from uuid import uuid4

from app.security.access_scope import AccessScope, resolve_access_scope
from app.services.document_storage import DocumentStorage
from app.services.documents import clean_display_title
from app.services.ingest.jobs import process_document_ingest
from app.services.ingest.router import V2_EXTENSIONS
from app.services.metadata import MetadataStore, get_metadata_store
from app.services.retrieval import IngestService
from app.services.runtime import resolve_runtime
from app.settings import Settings, get_settings

_CONTENT_TYPES = {
	".txt": "text/plain",
	".md": "text/markdown",
	".markdown": "text/markdown",
	".pdf": "application/pdf",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".csv": "text/csv",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


class SeedIngestError(Exception):
	"""Raised when a seed ingest step fails (mirrors former HTTP 4xx/5xx)."""

	def __init__(
		self,
		message: str,
		*,
		http_status: int = 400,
		doc_id: str | None = None,
		doc_status: str | None = None,
	) -> None:
		super().__init__(message)
		self.message = message
		self.http_status = http_status
		self.doc_id = doc_id
		self.doc_status = doc_status


def _scope(
	settings: Settings,
	access_scope: AccessScope | None,
) -> AccessScope:
	return resolve_access_scope(settings, access_scope)


def ensure_library(
	library_id: str,
	*,
	name: str | None = None,
	settings: Settings | None = None,
	access_scope: AccessScope | None = None,
	meta: MetadataStore | None = None,
) -> str:
	settings = settings or get_settings()
	scope = _scope(settings, access_scope)
	store = meta or get_metadata_store(settings)
	if store.get_library(library_id, scope=scope) is None:
		store.create_library(
			name=name or library_id,
			library_id=library_id,
			scope=scope,
		)
	return library_id


def seed_ingest_text(
	*,
	library_id: str,
	title: str,
	text: str,
	doc_id: str | None = None,
	settings: Settings | None = None,
	access_scope: AccessScope | None = None,
) -> dict[str, Any]:
	"""Stub/live text ingest equivalent of retired POST /v1/ingest."""
	settings = settings or get_settings()
	scope = _scope(settings, access_scope)
	meta = get_metadata_store(settings)
	ensure_library(library_id, settings=settings, access_scope=scope, meta=meta)
	capability = resolve_runtime(settings)

	doc = meta.create_document(
		library_id=library_id,
		name=title,
		filename=f"{title}.txt",
		content_type="text/plain",
		doc_id=doc_id,
		status="processing",
		scope=scope,
	)
	service = IngestService(settings, access_scope=scope)

	if not capability.live_ready:
		if capability.requested_mode == "stub" and settings.stub_ingest_simulate:
			try:
				result = service.simulate_ingest(
					library_id=library_id,
					title=title,
					text=text,
					doc_id=doc["id"],
				)
			except Exception as exc:
				meta.update_document(
					doc["id"],
					status="failed",
					error=str(exc),
					scope=scope,
				)
				raise SeedIngestError(
					str(exc),
					http_status=400,
					doc_id=doc["id"],
					doc_status="failed",
				) from exc
			meta.update_document(
				doc["id"],
				status="ready",
				chunk_count=result["chunk_count"],
				error=None,
				scope=scope,
			)
			return {
				"library_id": library_id,
				"doc_id": doc["id"],
				"title": title,
				"chunk_count": result["chunk_count"],
				"mode": "stub",
				"status": "ready",
				"simulated": True,
			}
		meta.update_document(
			doc["id"],
			status="failed",
			error="ingest requires live mode",
			scope=scope,
		)
		raise SeedIngestError(
			"ingest requires live mode with LLM key and reachable Qdrant",
			http_status=503,
			doc_id=doc["id"],
			doc_status="failed",
		)

	try:
		result = service.ingest_text(
			library_id=library_id,
			title=title,
			text=text,
			doc_id=doc["id"],
		)
	except ValueError as exc:
		meta.update_document(doc["id"], status="failed", error=str(exc), scope=scope)
		raise SeedIngestError(
			str(exc),
			http_status=400,
			doc_id=doc["id"],
			doc_status="failed",
		) from exc
	except Exception as exc:
		meta.update_document(doc["id"], status="failed", error=str(exc), scope=scope)
		raise SeedIngestError(
			f"ingest failed: {exc}",
			http_status=502,
			doc_id=doc["id"],
			doc_status="failed",
		) from exc

	meta.update_document(
		doc["id"],
		status="ready",
		chunk_count=result["chunk_count"],
		error=None,
		scope=scope,
	)
	return {**result, "mode": "live", "status": "ready", "simulated": False}


def seed_upload_document(
	*,
	library_id: str,
	filename: str,
	content: bytes,
	content_type: str | None = None,
	display_name: str | None = None,
	settings: Settings | None = None,
	access_scope: AccessScope | None = None,
	replace_same_name: bool = True,
) -> dict[str, Any]:
	"""Sync file ingest equivalent of retired POST /v1/ingest/upload."""
	settings = settings or get_settings()
	scope = _scope(settings, access_scope)
	meta = get_metadata_store(settings)
	storage = DocumentStorage(settings)
	ensure_library(library_id, settings=settings, access_scope=scope, meta=meta)

	if not content:
		raise SeedIngestError("Empty file", http_status=400)
	if len(content) > settings.max_upload_bytes:
		raise SeedIngestError(
			f"文件过大，上限 {settings.max_upload_bytes} 字节",
			http_status=413,
		)

	filename = (filename or "untitled.txt").strip() or "untitled.txt"
	suffix = PurePosixPath(filename).suffix.lower()
	if suffix not in V2_EXTENSIONS:
		raise SeedIngestError(
			f"unsupported file type: {suffix or '(none)'}; use txt/md/pdf/docx/csv/xlsx",
			http_status=400,
		)

	capability = resolve_runtime(settings)
	if replace_same_name:
		for old in meta.list_documents(library_id, scope=scope):
			if str(old.get("filename") or "") != filename:
				continue
			old_id = str(old["id"])
			old_key = old.get("storage_key")
			try:
				if capability.live_ready:
					IngestService(settings, access_scope=scope).delete_document_chunks(
						doc_id=old_id,
						library_id=library_id,
					)
			except Exception:
				pass
			if old_key:
				try:
					storage.delete(str(old_key))
				except Exception:
					pass
			meta.delete_document(old_id, scope=scope)

	title = clean_display_title(
		(display_name or "").strip() or PurePosixPath(filename).stem,
		filename=filename,
	)
	resolved_type = content_type or _CONTENT_TYPES.get(suffix, "application/octet-stream")
	doc_id = str(uuid4())
	doc = meta.create_document(
		library_id=library_id,
		name=title,
		filename=filename,
		content_type=resolved_type,
		doc_id=doc_id,
		status="processing",
		size_bytes=len(content),
		scope=scope,
	)
	storage_key = storage.save(library_id, doc["id"], filename, content)
	meta.update_document(doc["id"], storage_key=storage_key, scope=scope)

	live = capability.live_ready
	stub_simulate = capability.requested_mode == "stub" and settings.stub_ingest_simulate
	if not live and not stub_simulate:
		meta.update_document(
			doc["id"],
			status="failed",
			error="ingest requires live mode",
			scope=scope,
		)
		raise SeedIngestError(
			"ingest requires live mode with LLM key and reachable Qdrant",
			http_status=503,
			doc_id=doc["id"],
			doc_status="failed",
		)

	result = process_document_ingest(doc["id"], settings=settings, access_scope=scope)
	if not result.get("ok"):
		err = str(result.get("error") or "upload ingest failed")
		status = 400 if "empty" in err.lower() else 502
		raise SeedIngestError(
			err,
			http_status=status,
			doc_id=doc["id"],
			doc_status="failed",
		)

	return {
		"library_id": library_id,
		"doc_id": doc["id"],
		"title": str(result.get("title") or title),
		"filename": str(result.get("filename") or filename),
		"chunk_count": int(result.get("chunk_count") or 0),
		"status": "ready",
		"mode": str(result.get("mode") or ("live" if live else "stub")),
		"simulated": bool(result.get("simulated")),
		"accepted": False,
		"notice": result.get("notice"),
		"parser_report": result.get("parser_report"),
		"pipeline": result.get("pipeline"),
		"size_bytes": len(content),
	}


def seed_replace_document(
	doc_id: str,
	*,
	filename: str,
	content: bytes,
	content_type: str | None = None,
	settings: Settings | None = None,
	access_scope: AccessScope | None = None,
) -> dict[str, Any]:
	"""Sync replace equivalent of retired POST /v1/documents/{id}/replace."""
	settings = settings or get_settings()
	scope = _scope(settings, access_scope)
	meta = get_metadata_store(settings)
	storage = DocumentStorage(settings)

	doc = meta.get_document(doc_id, scope=scope)
	if doc is None:
		raise SeedIngestError("document not found", http_status=404)
	if str(doc.get("status") or "") == "processing":
		raise SeedIngestError("文档正在索引中，请稍后再替换", http_status=409)
	if not content:
		raise SeedIngestError("Empty file", http_status=400)

	filename = (filename or "untitled.txt").strip() or "untitled.txt"
	suffix = PurePosixPath(filename).suffix.lower()
	if suffix not in V2_EXTENSIONS:
		raise SeedIngestError(
			f"unsupported file type: {suffix or '(none)'}; use txt/md/pdf/docx/csv/xlsx",
			http_status=400,
		)

	library_id = str(doc["library_id"])
	capability = resolve_runtime(settings)
	live = capability.live_ready
	stub_simulate = capability.requested_mode == "stub" and settings.stub_ingest_simulate
	if not live and not stub_simulate:
		raise SeedIngestError(
			"ingest requires live mode with LLM key and reachable Qdrant",
			http_status=503,
		)

	for other in meta.list_documents(library_id, scope=scope):
		if str(other["id"]) == doc_id:
			continue
		if str(other.get("filename") or "") != filename:
			continue
		other_id = str(other["id"])
		try:
			if live:
				IngestService(settings, access_scope=scope).delete_document_chunks(
					doc_id=other_id,
					library_id=library_id,
				)
		except Exception:
			pass
		peer_key = other.get("storage_key")
		if peer_key:
			try:
				storage.delete(str(peer_key))
			except Exception:
				pass
		meta.delete_document(other_id, scope=scope)

	if live:
		try:
			IngestService(settings, access_scope=scope).delete_document_chunks(
				doc_id=doc_id,
				library_id=library_id,
			)
		except Exception as exc:
			raise SeedIngestError(
				f"清除旧向量失败，已中止替换: {exc}",
				http_status=502,
			) from exc

	old_key = doc.get("storage_key")
	if old_key:
		try:
			storage.delete(str(old_key))
		except Exception:
			pass

	title = clean_display_title(PurePosixPath(filename).stem, filename=filename)
	resolved_type = content_type or _CONTENT_TYPES.get(suffix, "application/octet-stream")
	storage_key = storage.save(library_id, doc_id, filename, content)
	meta.update_document(
		doc_id,
		name=title,
		filename=filename,
		content_type=resolved_type,
		storage_key=storage_key,
		size_bytes=len(content),
		status="processing",
		chunk_count=0,
		parser_report={},
		clear_error=True,
		scope=scope,
	)

	result = process_document_ingest(doc_id, settings=settings, access_scope=scope)
	if not result.get("ok"):
		raise SeedIngestError(
			str(result.get("error") or "replace ingest failed"),
			http_status=400,
			doc_id=doc_id,
			doc_status="failed",
		)
	return {
		"library_id": library_id,
		"doc_id": doc_id,
		"title": str(result.get("title") or title),
		"filename": str(result.get("filename") or filename),
		"chunk_count": int(result.get("chunk_count") or 0),
		"status": "ready",
		"mode": str(result.get("mode") or ("live" if live else "stub")),
		"simulated": bool(result.get("simulated")),
		"size_bytes": len(content),
	}


def seed_reindex_document(
	doc_id: str,
	*,
	settings: Settings | None = None,
	access_scope: AccessScope | None = None,
) -> dict[str, Any]:
	"""Sync reindex equivalent of retired POST /v1/documents/{id}/reindex."""
	settings = settings or get_settings()
	scope = _scope(settings, access_scope)
	meta = get_metadata_store(settings)
	storage = DocumentStorage(settings)

	doc = meta.get_document(doc_id, scope=scope)
	if doc is None:
		raise SeedIngestError("document not found", http_status=404)
	storage_key = doc.get("storage_key")
	if not storage_key:
		raise SeedIngestError("原文未保留，请重新上传", http_status=409)
	try:
		storage.read(str(storage_key))
	except FileNotFoundError as exc:
		raise SeedIngestError("原文未保留，请重新上传", http_status=409) from exc
	if str(doc.get("status") or "") == "processing":
		raise SeedIngestError("文档正在索引中", http_status=409)

	capability = resolve_runtime(settings)
	live = capability.live_ready
	stub_simulate = capability.requested_mode == "stub" and settings.stub_ingest_simulate
	if not live and not stub_simulate:
		raise SeedIngestError(
			"ingest requires live mode with LLM key and reachable Qdrant",
			http_status=503,
		)

	meta.update_document(doc_id, status="processing", error=None, scope=scope)
	result = process_document_ingest(doc_id, settings=settings, access_scope=scope)
	if not result.get("ok"):
		raise SeedIngestError(
			str(result.get("error") or "reindex failed"),
			http_status=400,
			doc_id=doc_id,
			doc_status="failed",
		)
	return {
		"library_id": str(doc["library_id"]),
		"doc_id": doc_id,
		"title": str(result.get("title") or doc["name"]),
		"filename": str(result.get("filename") or doc["filename"]),
		"chunk_count": int(result.get("chunk_count") or 0),
		"status": "ready",
		"mode": str(result.get("mode") or ("live" if live else "stub")),
		"simulated": bool(result.get("simulated")),
	}
