from __future__ import annotations

from fastapi import APIRouter

from app.schemas import HealthResponse
from app.settings import get_settings

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
	settings = get_settings()
	return HealthResponse(
		status="ok",
		service=settings.app_name,
		env=settings.app_env,
		ask_mode=settings.ask_mode,
		graph="stub",
	)
