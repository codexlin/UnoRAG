from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from pathlib import PurePosixPath
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse

from app.graph import AskGraphService
from app.security.access_scope import AccessScope
from app.security.internal_context import RequestContext, require_internal_context
from app.schemas import (
	AskRequest,
	AskResponse,
	IngestRequest,
	IngestResponse,
	UploadResponse,
)
from app.services.document_storage import DocumentStorage
from app.services.documents import clean_display_title
from app.services.ingest.jobs import enqueue_ingest_job, process_document_ingest
from app.services.ingest.pipeline import prepare_ingest
from app.services.ingest.router import V2_EXTENSIONS
from app.services.metadata import MetadataStore, get_metadata_store
from app.services.retrieval import IngestService
from app.services.runtime import resolve_runtime
from app.settings import Settings, get_settings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ask"])


def _unavailable_detail(capability, *, message: str) -> dict:
	return {
		"message": message,
		"requested_mode": capability.requested_mode,
		"effective_mode": capability.effective_mode,
		"degraded": capability.degraded,
		"live_ready": capability.live_ready,
		"ask_ready": capability.ask_ready,
		"reasons": capability.reasons,
	}


def get_ask_service(
	settings: Settings = Depends(get_settings),
	context: RequestContext = Depends(require_internal_context),
) -> AskGraphService:
	capability = resolve_runtime(settings)
	if not capability.ask_ready:
		raise HTTPException(
			status_code=503,
			detail=_unavailable_detail(
				capability,
				message="ask unavailable: live mode requires LLM key and reachable Qdrant",
			),
		)
	return AskGraphService(
		settings,
		capability=capability,
		access_scope=AccessScope.from_request_context(context),
	)


def get_meta(settings: Settings = Depends(get_settings)) -> MetadataStore:
	return get_metadata_store(settings)


def _require_library_id(library_id: str | None) -> str:
	resolved = (library_id or "").strip()
	if not resolved:
		raise HTTPException(status_code=400, detail="library_id is required")
	return resolved


@router.post("/ask", response_model=AskResponse)
def ask(
	body: AskRequest,
	service: AskGraphService = Depends(get_ask_service),
) -> AskResponse:
	library_id = _require_library_id(body.library_id)
	return service.ask(
		question=body.question,
		library_id=library_id,
		session_id=body.session_id,
	)


@router.post("/ask/stream")
def ask_stream(
	body: AskRequest,
	service: AskGraphService = Depends(get_ask_service),
) -> StreamingResponse:
	library_id = _require_library_id(body.library_id)

	def sse(event: str, data: object) -> str:
		return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

	def generate() -> Iterator[str]:
		try:
			for item in service.iter_ask_events(
				question=body.question,
				library_id=library_id,
				session_id=body.session_id,
			):
				yield sse(str(item["event"]), item["data"])
		except Exception as exc:
			logger.exception("ask.stream.error")
			yield sse("error", {"message": f"流式问答失败：{exc}"})

	return StreamingResponse(
		generate(),
		media_type="text/event-stream",
		headers={
			"Cache-Control": "no-cache",
			"X-Accel-Buffering": "no",
		},
	)


@router.post("/ingest", response_model=IngestResponse)
def ingest(
	body: IngestRequest,
	settings: Settings = Depends(get_settings),
	meta: MetadataStore = Depends(get_meta),
	context: RequestContext = Depends(require_internal_context),
) -> IngestResponse:
	access_scope = AccessScope.from_request_context(context)
	capability = resolve_runtime(settings)
	if not capability.live_ready:
		if capability.requested_mode == "stub" and settings.stub_ingest_simulate:
			if meta.get_library(body.library_id) is None:
				meta.create_library(name=body.library_id, library_id=body.library_id)
			doc = meta.create_document(
				library_id=body.library_id,
				name=body.title,
				filename=f"{body.title}.txt",
				content_type="text/plain",
				doc_id=body.doc_id,
				status="processing",
			)
			try:
				result = IngestService(settings, access_scope=access_scope).simulate_ingest(
					library_id=body.library_id,
					title=body.title,
					text=body.text,
					doc_id=doc["id"],
				)
				meta.update_document(doc["id"], status="ready", chunk_count=result["chunk_count"], error=None)
			except Exception as exc:
				meta.update_document(doc["id"], status="failed", error=str(exc))
				raise HTTPException(status_code=400, detail=str(exc)) from exc
			return IngestResponse(
				library_id=body.library_id,
				doc_id=doc["id"],
				title=body.title,
				chunk_count=result["chunk_count"],
				mode="stub",
				status="ready",
				simulated=True,
			)
		raise HTTPException(
			status_code=503,
			detail=_unavailable_detail(
				capability,
				message="ingest requires live mode with LLM key and reachable Qdrant",
			),
		)

	if meta.get_library(body.library_id) is None:
		meta.create_library(name=body.library_id, library_id=body.library_id)
	doc = meta.create_document(
		library_id=body.library_id,
		name=body.title,
		filename=f"{body.title}.txt",
		content_type="text/plain",
		doc_id=body.doc_id,
		status="processing",
	)
	try:
		result = IngestService(settings, access_scope=access_scope).ingest_text(
			library_id=body.library_id,
			title=body.title,
			text=body.text,
			doc_id=doc["id"],
		)
		meta.update_document(doc["id"], status="ready", chunk_count=result["chunk_count"], error=None)
	except ValueError as exc:
		meta.update_document(doc["id"], status="failed", error=str(exc))
		raise HTTPException(status_code=400, detail=str(exc)) from exc
	except Exception as exc:
		meta.update_document(doc["id"], status="failed", error=str(exc))
		raise HTTPException(status_code=502, detail=f"ingest failed: {exc}") from exc
	return IngestResponse(**result, mode="live", status="ready", simulated=False)


@router.post(
	"/ingest/upload",
	response_model=UploadResponse,
	responses={202: {"model": UploadResponse}},
)
async def ingest_upload(
	library_id: str = Form(...),
	file: UploadFile = File(...),
	display_name: str | None = Form(default=None),
	settings: Settings = Depends(get_settings),
	meta: MetadataStore = Depends(get_meta),
	context: RequestContext = Depends(require_internal_context),
) -> UploadResponse | JSONResponse:
	access_scope = AccessScope.from_request_context(context)
	capability = resolve_runtime(settings)
	content = await file.read()
	if not content:
		raise HTTPException(status_code=400, detail="Empty file")
	if len(content) > settings.max_upload_bytes:
		raise HTTPException(
			status_code=413,
			detail=f"文件过大，上限 {settings.max_upload_bytes} 字节",
		)

	filename = (file.filename or "untitled.txt").strip() or "untitled.txt"
	suffix = PurePosixPath(filename).suffix.lower()
	if suffix not in V2_EXTENSIONS:
		raise HTTPException(
			status_code=400,
			detail=f"unsupported file type: {suffix or '(none)'}; use txt/md/pdf/docx/csv/xlsx",
		)
	if meta.get_library(library_id) is None:
		meta.create_library(name=library_id, library_id=library_id)

	# 同库同名文件覆盖：先清旧向量 + 元数据，避免脏 chunk 叠加
	doc_storage = DocumentStorage(settings)
	for old in meta.list_documents(library_id):
		if str(old.get("filename") or "") != filename:
			continue
		old_id = str(old["id"])
		old_storage_key = old.get("storage_key")
		try:
			if capability.live_ready:
				IngestService(settings, access_scope=access_scope).delete_document_chunks(
					doc_id=old_id,
					library_id=library_id,
				)
		except Exception as exc:
			logger.warning(
				"upload.replace_delete_vectors_failed doc_id=%s err=%s",
				old_id,
				exc,
			)
		if old_storage_key:
			try:
				doc_storage.delete(str(old_storage_key))
			except Exception as exc:
				logger.warning(
					"upload.replace_delete_storage_failed doc_id=%s err=%s",
					old_id,
					exc,
				)
		meta.delete_document(old_id)

	title = clean_display_title(
		(display_name or "").strip() or PurePosixPath(filename).stem,
		filename=filename,
	)
	content_type = file.content_type or {
		".txt": "text/plain",
		".md": "text/markdown",
		".markdown": "text/markdown",
		".pdf": "application/pdf",
		".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".csv": "text/csv",
		".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	}.get(suffix, "application/octet-stream")
	doc_id = str(uuid4())
	doc = meta.create_document(
		library_id=library_id,
		name=title,
		filename=filename,
		content_type=content_type,
		doc_id=doc_id,
		status="processing",
		size_bytes=len(content),
	)
	storage_key = doc_storage.save(library_id, doc["id"], filename, content)
	meta.update_document(doc["id"], storage_key=storage_key)

	live = capability.live_ready
	stub_simulate = capability.requested_mode == "stub" and settings.stub_ingest_simulate
	if not live and not stub_simulate:
		meta.update_document(
			doc["id"],
			status="failed",
			error="ingest requires live mode",
		)
		raise HTTPException(
			status_code=503,
			detail={
				**_unavailable_detail(
					capability,
					message="ingest requires live mode with LLM key and reachable Qdrant",
				),
				"doc_id": doc["id"],
				"status": "failed",
			},
		)

	mode = "live" if live else "stub"
	if settings.ingest_async:
		try:
			await enqueue_ingest_job(
				doc_id=doc["id"],
				library_id=library_id,
				access_scope=access_scope,
				settings=settings,
			)
		except RuntimeError as exc:
			meta.update_document(doc["id"], status="failed", error=str(exc))
			raise HTTPException(status_code=429, detail=str(exc)) from exc
		except Exception as exc:
			logger.exception("upload.enqueue_failed doc_id=%s", doc["id"])
			meta.update_document(
				doc["id"],
				status="failed",
				error=f"入队失败: {exc}",
			)
			raise HTTPException(
				status_code=503,
				detail=f"索引队列不可用: {exc}",
			) from exc
		payload = UploadResponse(
			library_id=library_id,
			doc_id=doc["id"],
			title=title,
			filename=filename,
			chunk_count=0,
			status="processing",
			mode=mode,
			simulated=False,
			accepted=True,
		)
		return JSONResponse(status_code=202, content=payload.model_dump())

	# 同步回退（INGEST_ASYNC=false）：同请求内跑完 ingest
	result = process_document_ingest(
		doc["id"],
		settings=settings,
		access_scope=access_scope,
	)
	if not result.get("ok"):
		raise HTTPException(
			status_code=400 if "empty" in str(result.get("error") or "").lower() else 502,
			detail=str(result.get("error") or "upload ingest failed"),
		)
	return UploadResponse(
		library_id=library_id,
		doc_id=doc["id"],
		title=str(result.get("title") or title),
		filename=str(result.get("filename") or filename),
		chunk_count=int(result.get("chunk_count") or 0),
		status="ready",
		mode=str(result.get("mode") or mode),
		simulated=bool(result.get("simulated")),
		accepted=False,
		notice=result.get("notice"),
		parser_report=result.get("parser_report"),
		pipeline=result.get("pipeline"),
	)
