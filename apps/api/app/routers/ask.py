from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.graph import AskGraphService
from app.schemas import AskRequest, AskResponse, IngestRequest, IngestResponse
from app.services.retrieval import IngestService
from app.services.runtime import resolve_runtime
from app.settings import Settings, get_settings

router = APIRouter(tags=["ask"])


def get_ask_service(settings: Settings = Depends(get_settings)) -> AskGraphService:
	capability = resolve_runtime(settings)
	return AskGraphService(settings, capability=capability)


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


@router.post("/ingest", response_model=IngestResponse)
def ingest(
	body: IngestRequest,
	settings: Settings = Depends(get_settings),
) -> IngestResponse:
	capability = resolve_runtime(settings)
	if capability.effective_mode != "live":
		raise HTTPException(
			status_code=503,
			detail={
				"message": "ingest requires live mode with LLM key and reachable Qdrant",
				"requested_mode": capability.requested_mode,
				"effective_mode": capability.effective_mode,
				"reasons": capability.reasons,
			},
		)
	try:
		result = IngestService(settings).ingest_text(
			library_id=body.library_id,
			title=body.title,
			text=body.text,
			doc_id=body.doc_id,
		)
	except ValueError as exc:
		raise HTTPException(status_code=400, detail=str(exc)) from exc
	except Exception as exc:
		raise HTTPException(status_code=502, detail=f"ingest failed: {exc}") from exc
	return IngestResponse(**result, mode="live")
