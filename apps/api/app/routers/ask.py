from __future__ import annotations

import json
import logging
from collections.abc import Iterator

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse

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
from app.services.ask_trace import resolve_trace_id
from app.services.ingest.fastapi_ingest_writes import reject_fastapi_ingest_writes
from app.services.metadata import MetadataStore, get_metadata_store
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


def _require_library_id(library_id: str | None) -> str:
	resolved = (library_id or "").strip()
	if not resolved:
		raise HTTPException(status_code=400, detail="library_id is required")
	return resolved


def _trace_id_for_request(request: Request, context: RequestContext) -> str:
	return resolve_trace_id(
		x_request_id=request.headers.get("x-request-id"),
		request_id=context.request_id,
	)


def get_meta(settings: Settings = Depends(get_settings)) -> MetadataStore:
	return get_metadata_store(settings)


def _resolve_thread_id(
	thread_id: str | None,
	*,
	meta: MetadataStore,
	context: RequestContext,
) -> str | None:
	resolved = (thread_id or "").strip() or None
	if not resolved:
		return None
	row = meta.get_thread(
		resolved,
		tenant_id=context.tenant_id,
		workspace_id=context.workspace_id,
		principal_id=context.principal_id,
	)
	if row is None or row.get("status") == "hidden":
		raise HTTPException(status_code=404, detail="thread not found")
	return resolved


@router.post("/ask", response_model=AskResponse)
def ask(
	body: AskRequest,
	request: Request,
	service: AskGraphService = Depends(get_ask_service),
	meta: MetadataStore = Depends(get_meta),
	context: RequestContext = Depends(require_internal_context),
) -> AskResponse:
	library_id = _require_library_id(body.library_id)
	thread_id = _resolve_thread_id(body.thread_id, meta=meta, context=context)
	return service.ask(
		question=body.question,
		library_id=library_id,
		session_id=body.session_id,
		thread_id=thread_id,
		trace_id=_trace_id_for_request(request, context),
		ask_overrides=body.ask_overrides,
	)


@router.post("/ask/stream")
def ask_stream(
	body: AskRequest,
	request: Request,
	service: AskGraphService = Depends(get_ask_service),
	meta: MetadataStore = Depends(get_meta),
	context: RequestContext = Depends(require_internal_context),
) -> StreamingResponse:
	library_id = _require_library_id(body.library_id)
	thread_id = _resolve_thread_id(body.thread_id, meta=meta, context=context)
	trace_id = _trace_id_for_request(request, context)

	def sse(event: str, data: object) -> str:
		return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

	def generate() -> Iterator[str]:
		try:
			for item in service.iter_ask_events(
				question=body.question,
				library_id=library_id,
				session_id=body.session_id,
				thread_id=thread_id,
				trace_id=trace_id,
				ask_overrides=body.ask_overrides,
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
			"X-Request-Id": trace_id,
		},
	)


@router.post("/ingest", response_model=IngestResponse)
def ingest(
	body: IngestRequest,
) -> IngestResponse:
	"""Deprecated: product ingest uses the lifecycle control plane + app.jobs."""
	_ = body
	reject_fastapi_ingest_writes()


@router.post(
	"/ingest/upload",
	response_model=UploadResponse,
	responses={410: {"description": "FastAPI ingest writes permanently disabled"}},
)
async def ingest_upload(
	library_id: str = Form(...),
	file: UploadFile = File(...),
	display_name: str | None = Form(default=None),
) -> UploadResponse:
	"""Deprecated: browser uploads must use the Next.js control plane."""
	_ = (library_id, file, display_name)
	reject_fastapi_ingest_writes()
