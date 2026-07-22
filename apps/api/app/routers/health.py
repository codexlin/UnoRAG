from __future__ import annotations

from fastapi import APIRouter

from app.schemas import HealthResponse
from app.services.metadata import probe_metadata_store
from app.services.runtime import resolve_runtime
from app.settings import get_settings

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
	settings = get_settings()
	capability = resolve_runtime(settings)
	meta_ok, meta_backend, meta_detail = probe_metadata_store(settings)
	reasons = list(capability.reasons)
	if not meta_ok:
		reasons.append(f"metadata_unavailable: {meta_detail}")
	degraded = capability.degraded or not meta_ok
	status = "ok" if meta_ok else "degraded"
	return HealthResponse(
		status=status,
		service=settings.app_name,
		env=settings.app_env,
		ask_mode=capability.requested_mode,
		effective_mode=capability.effective_mode,
		graph=capability.graph,
		degraded=degraded,
		has_llm_key=capability.has_llm_key,
		qdrant_ok=capability.qdrant_ok,
		reasons=reasons,
		hybrid_enabled=settings.hybrid_enabled,
		metadata_backend=meta_backend,
		metadata_ok=meta_ok,
	)
