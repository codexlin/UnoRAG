from __future__ import annotations

from fastapi import APIRouter

from app.schemas import HealthResponse
from app.services.runtime import resolve_runtime
from app.settings import get_settings

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
	settings = get_settings()
	capability = resolve_runtime(settings)
	return HealthResponse(
		status="ok",
		service=settings.app_name,
		env=settings.app_env,
		ask_mode=capability.requested_mode,
		effective_mode=capability.effective_mode,
		graph=capability.graph,
		degraded=capability.degraded,
		has_llm_key=capability.has_llm_key,
		qdrant_ok=capability.qdrant_ok,
		reasons=list(capability.reasons),
	)
