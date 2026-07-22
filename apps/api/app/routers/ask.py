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
from app.services.ingest.pipeline import prepare_ingest
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


def get_ask_service(settings: Settings = Depends(get_settings)) -> AskGraphService:
	capability = resolve_runtime(settings)
	if not capability.ask_ready:
		raise HTTPException(
			status_code=503,
			detail=_unavailable_detail(
				capability,
				message="ask unavailable: live mode requires LLM key and reachable Qdrant",
			),
		)
	return AskGraphService(settings, capability=capability)


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
) -> IngestResponse:
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
	if meta.get_library(library_id) is None:
		raise HTTPException(status_code=404, detail=f"library not found: {library_id}")

	# 同库同名文件覆盖：先清旧向量 + 元数据，避免脏 chunk 叠加
	for old in meta.list_documents(library_id):
		if str(old.get("filename") or "") != filename:
			continue
		old_id = str(old["id"])
		try:
			if capability.live_ready:
				IngestService(settings).delete_document_chunks(
					doc_id=old_id,
					library_id=library_id,
				)
		except Exception as exc:
			logger.warning(
				"upload.replace_delete_vectors_failed doc_id=%s err=%s",
				old_id,
				exc,
			)
		meta.delete_document(old_id)

	try:
		prepared = prepare_ingest(
			settings=settings,
			filename=filename,
			content=content,
			library_id=library_id,
			display_name=display_name,
			content_type=file.content_type,
		)
	except ValueError as exc:
		raise HTTPException(status_code=400, detail=str(exc)) from exc

	doc = meta.create_document(
		library_id=library_id,
		name=prepared.title,
		filename=prepared.filename,
		content_type=prepared.content_type,
		doc_id=prepared.doc_id,
		status="processing",
	)

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

	report = prepared.parser_report.to_public_dict()
	notice = prepared.notice()
	try:
		if live:
			result = IngestService(settings).ingest_ir_chunks(
				library_id=library_id,
				title=prepared.title,
				chunks=prepared.chunks,
				doc_id=doc["id"],
				filename=prepared.filename,
				parser_report=report,
			)
			simulated = False
			mode = "live"
		else:
			result = {
				"library_id": library_id,
				"doc_id": doc["id"],
				"title": prepared.title,
				"chunk_count": len(prepared.chunks),
				"simulated": True,
			}
			simulated = True
			mode = "stub"
		meta.update_document(
			doc["id"],
			status="ready",
			chunk_count=result["chunk_count"],
			error=None,
			parser_report=report,
		)
	except ValueError as exc:
		meta.update_document(doc["id"], status="failed", error=str(exc), parser_report=report)
		raise HTTPException(status_code=400, detail=str(exc)) from exc
	except Exception as exc:
		meta.update_document(doc["id"], status="failed", error=str(exc), parser_report=report)
		raise HTTPException(status_code=502, detail=f"upload ingest failed: {exc}") from exc

	return UploadResponse(
		library_id=library_id,
		doc_id=doc["id"],
		title=prepared.title,
		filename=prepared.filename,
		chunk_count=result["chunk_count"],
		status="ready",
		mode=mode,
		simulated=simulated,
		notice=notice,
		parser_report=report,
		pipeline=prepared.pipeline,
	)
