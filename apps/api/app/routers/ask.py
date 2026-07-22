from __future__ import annotations

from fastapi import APIRouter, Depends

from app.graph import AskGraphService
from app.schemas import AskRequest, AskResponse
from app.settings import Settings, get_settings

router = APIRouter(tags=["ask"])


def get_ask_service() -> AskGraphService:
	return AskGraphService()


@router.post("/ask", response_model=AskResponse)
def ask(
	body: AskRequest,
	settings: Settings = Depends(get_settings),
	service: AskGraphService = Depends(get_ask_service),
) -> AskResponse:
	return service.ask(
		question=body.question,
		library_id=body.library_id,
		session_id=body.session_id,
		mode=settings.ask_mode,
	)
