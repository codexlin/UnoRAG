from __future__ import annotations

import json
import logging
from collections.abc import Iterator

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from app.graph import AskGraphService
from app.schemas import (
	AskRequest,
	AskResponse,
	IngestRequest,
	IngestResponse,
	UploadResponse,
)
from app.services.documents import extract_text
from app.services.metadata import MetadataStore, get_metadata_store
from app.services.retrieval import IngestService
from app.services.runtime import resolve_runtime
from app.settings import Settings, get_settings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ask"])


def get_ask_service(settings: Settings = Depends(get_settings)) -> AskGraphService:
	capability = resolve_runtime(settings)
	return AskGraphService(settings, capability=capability)


def get_meta(settings: Settings = Depends(get_settings)) -> MetadataStore:
	return get_metadata_store(settings)


@router.post("/ask", response_model=AskResponse)
def ask(
	body: AskRequest,
	service: AskGraphService = Depends(get_ask_service),
) -> AskResponse:
	return service.ask(
		question=body.question,
		library_id=body.library_id,
		session_id=body.session_id,
	)


@router.post("/ask/stream")
def ask_stream(
	body: AskRequest,
	service: AskGraphService = Depends(get_ask_service),
) -> StreamingResponse:
	def sse(event: str, data: object) -> str:
		return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

	def generate() -> Iterator[str]:
		try:
			for item in service.iter_ask_events(
				question=body.question,
				library_id=body.library_id,
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
) -> IngestResponse:
	capability = resolve_runtime(settings)
	if capability.effective_mode != "live":
		if not settings.stub_ingest_simulate:
			raise HTTPException(
				status_code=503,
				detail={
					"message": "ingest requires live mode with LLM key and reachable Qdrant",
					"requested_mode": capability.requested_mode,
					"effective_mode": capability.effective_mode,
					"reasons": capability.reasons,
				},
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
			result = IngestService(settings).simulate_ingest(
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
		result = IngestService(settings).ingest_text(
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


@router.post("/ingest/upload", response_model=UploadResponse)
async def ingest_upload(
	library_id: str = Form(...),
	file: UploadFile = File(...),
	display_name: str | None = Form(default=None),
	settings: Settings = Depends(get_settings),
	meta: MetadataStore = Depends(get_meta),
) -> UploadResponse:
	capability = resolve_runtime(settings)
	content = await file.read()
	if not content:
		raise HTTPException(status_code=400, detail="Empty file")

	filename = file.filename or "untitled.txt"
	try:
		parsed = extract_text(
			filename=filename,
			content=content,
			content_type=file.content_type,
		)
	except ValueError as exc:
		raise HTTPException(status_code=400, detail=str(exc)) from exc

	from app.services.documents import clean_display_title

	title = clean_display_title(
		(display_name or "").strip() or parsed.title,
		filename=parsed.filename,
	)

	if meta.get_library(library_id) is None:
		raise HTTPException(status_code=404, detail=f"library not found: {library_id}")

	doc = meta.create_document(
		library_id=library_id,
		name=title,
		filename=parsed.filename,
		content_type=parsed.content_type,
		status="processing",
	)

	live = capability.effective_mode == "live"
	if not live and not settings.stub_ingest_simulate:
		meta.update_document(
			doc["id"],
			status="failed",
			error="ingest requires live mode",
		)
		raise HTTPException(
			status_code=503,
			detail={
				"message": "ingest requires live mode with LLM key and reachable Qdrant",
				"requested_mode": capability.requested_mode,
				"effective_mode": capability.effective_mode,
				"reasons": capability.reasons,
				"doc_id": doc["id"],
				"status": "failed",
			},
		)

	try:
		if live:
			result = IngestService(settings).ingest_text(
				library_id=library_id,
				title=title,
				text=parsed.text,
				doc_id=doc["id"],
				filename=parsed.filename,
			)
			simulated = False
			mode = "live"
		else:
			result = IngestService(settings).simulate_ingest(
				library_id=library_id,
				title=title,
				text=parsed.text,
				doc_id=doc["id"],
			)
			simulated = True
			mode = "stub"
		meta.update_document(
			doc["id"],
			status="ready",
			chunk_count=result["chunk_count"],
			error=None,
		)
	except ValueError as exc:
		meta.update_document(doc["id"], status="failed", error=str(exc))
		raise HTTPException(status_code=400, detail=str(exc)) from exc
	except Exception as exc:
		meta.update_document(doc["id"], status="failed", error=str(exc))
		raise HTTPException(status_code=502, detail=f"upload ingest failed: {exc}") from exc

	return UploadResponse(
		library_id=library_id,
		doc_id=doc["id"],
		title=title,
		filename=parsed.filename,
		chunk_count=result["chunk_count"],
		status="ready",
		mode=mode,
		simulated=simulated,
	)
