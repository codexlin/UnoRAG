"""Shared sync document ingest for tests / scripts (not the product path).

Product ingest: Next.js → app.jobs → lifecycle_worker.
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import uuid4

from app.security.access_scope import AccessScope, resolve_access_scope
from app.services.document_storage import DocumentStorage
from app.services.ingest.pipeline import prepare_ingest
from app.services.metadata import get_metadata_store
from app.services.retrieval import IngestService
from app.services.runtime import resolve_runtime
from app.settings import Settings, get_settings

logger = logging.getLogger(__name__)


def process_document_ingest(
	doc_id: str,
	*,
	settings: Settings | None = None,
	access_scope: AccessScope | None = None,
) -> dict[str, Any]:
	"""Parse + embed a stored document. Idempotent if not in processing."""
	settings = settings or get_settings()
	scope = resolve_access_scope(settings, access_scope)
	meta = get_metadata_store(settings)
	storage = DocumentStorage(settings)

	doc = meta.get_document(doc_id, scope=scope)
	if doc is None:
		logger.warning("ingest.job.missing doc_id=%s", doc_id)
		return {"ok": False, "doc_id": doc_id, "error": "document not found"}

	status = str(doc.get("status") or "")
	if status != "processing":
		logger.info(
			"ingest.job.skip doc_id=%s status=%s",
			doc_id,
			status,
		)
		return {
			"ok": True,
			"doc_id": doc_id,
			"skipped": True,
			"status": status,
			"chunk_count": int(doc.get("chunk_count") or 0),
			"title": str(doc.get("name") or ""),
			"filename": str(doc.get("filename") or ""),
			"library_id": str(doc.get("library_id") or ""),
			"simulated": False,
			"mode": resolve_runtime(settings).effective_mode,
			"notice": None,
			"parser_report": doc.get("parser_report"),
			"pipeline": None,
		}

	storage_key = doc.get("storage_key")
	if not storage_key:
		meta.update_document(
			doc_id,
			status="failed",
			error="原文未保留，请重新上传",
			scope=scope,
		)
		return {"ok": False, "doc_id": doc_id, "error": "原文未保留，请重新上传"}

	try:
		content = storage.read(str(storage_key))
	except FileNotFoundError:
		meta.update_document(
			doc_id,
			status="failed",
			error="原文未保留，请重新上传",
			scope=scope,
		)
		return {"ok": False, "doc_id": doc_id, "error": "原文未保留，请重新上传"}

	library_id = str(doc["library_id"])
	filename = str(doc["filename"])
	display_name = str(doc["name"])
	capability = resolve_runtime(settings)

	try:
		prepared = prepare_ingest(
			settings=settings,
			filename=filename,
			content=content,
			library_id=library_id,
			display_name=display_name,
			content_type=doc.get("content_type"),
			doc_id=doc_id,
		)
	except ValueError as exc:
		meta.update_document(doc_id, status="failed", error=str(exc), scope=scope)
		return {"ok": False, "doc_id": doc_id, "error": str(exc)}

	live = capability.live_ready
	stub_simulate = capability.requested_mode == "stub" and settings.stub_ingest_simulate
	if not live and not stub_simulate:
		meta.update_document(
			doc_id,
			status="failed",
			error="ingest requires live mode",
			scope=scope,
		)
		return {"ok": False, "doc_id": doc_id, "error": "ingest requires live mode"}

	report = prepared.parser_report.to_public_dict()
	notice = prepared.notice()
	try:
		if live:
			# Test/script helper path: mint a UUID so payloads stay schema-valid.
			# Product ingest must pass app.document_versions.id from the worker.
			result = IngestService(
				settings,
				access_scope=scope,
			).ingest_ir_chunks(
				library_id=library_id,
				title=prepared.title,
				chunks=prepared.chunks,
				doc_id=doc_id,
				filename=prepared.filename,
				parser_report=report,
				document_version_id=str(uuid4()),
			)
			simulated = False
			mode = "live"
		else:
			result = {
				"library_id": library_id,
				"doc_id": doc_id,
				"title": prepared.title,
				"chunk_count": len(prepared.chunks),
				"simulated": True,
			}
			simulated = True
			mode = "stub"
		meta.update_document(
			doc_id,
			status="ready",
			chunk_count=result["chunk_count"],
			error=None,
			parser_report=report,
			scope=scope,
		)
	except ValueError as exc:
		meta.update_document(
			doc_id,
			status="failed",
			error=str(exc),
			parser_report=report,
			scope=scope,
		)
		return {"ok": False, "doc_id": doc_id, "error": str(exc)}
	except Exception as exc:
		logger.exception("ingest.job.failed doc_id=%s", doc_id)
		meta.update_document(
			doc_id,
			status="failed",
			error=str(exc),
			parser_report=report,
			scope=scope,
		)
		return {"ok": False, "doc_id": doc_id, "error": str(exc)}

	logger.info(
		"ingest.job.done doc_id=%s library_id=%s chunks=%s mode=%s",
		doc_id,
		library_id,
		result["chunk_count"],
		mode,
	)
	return {
		"ok": True,
		"doc_id": doc_id,
		"library_id": library_id,
		"title": prepared.title,
		"filename": prepared.filename,
		"chunk_count": result["chunk_count"],
		"status": "ready",
		"mode": mode,
		"simulated": simulated,
		"notice": notice,
		"parser_report": report,
		"pipeline": prepared.pipeline,
	}
