from __future__ import annotations

from fastapi import APIRouter

from app.schemas import HealthResponse
from app.security.internal_context import INTERNAL_AUTH_PROTOCOL
from app.services.active_generations import probe_active_generation_store
from app.services.ask_defaults import ASK_DEFAULTS
from app.services.metadata import probe_metadata_store
from app.services.runtime import resolve_runtime
from app.settings import get_settings

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
	settings = get_settings()
	capability = resolve_runtime(settings)
	meta_ok, meta_backend, meta_detail = probe_metadata_store(settings)
	active_gate_ok, active_gate_detail = probe_active_generation_store(settings)
	reasons = list(capability.reasons)
	if not meta_ok:
		reasons.append(f"metadata_unavailable: {meta_detail}")
	if not active_gate_ok:
		reasons.append(f"active_generation_gate_unavailable: {active_gate_detail}")
	ask_ready = capability.ask_ready
	degraded = (
		capability.degraded
		or not meta_ok
		or not active_gate_ok
		or not ask_ready
	)
	# Never report ok when ask/live is not ready or metadata is down
	status = (
		"ok"
		if meta_ok and active_gate_ok and ask_ready and not capability.degraded
		else "unavailable"
	)
	return HealthResponse(
		status=status,
		service=settings.app_name,
		env=settings.app_env,
		build_ref=settings.build_ref,
		internal_auth_protocol=INTERNAL_AUTH_PROTOCOL,
		ask_mode=capability.requested_mode,
		effective_mode=capability.effective_mode,
		graph=capability.graph,
		degraded=degraded,
		has_llm_key=capability.has_llm_key,
		qdrant_ok=capability.qdrant_ok,
		live_ready=capability.live_ready,
		ask_ready=ask_ready,
		reasons=reasons,
		hybrid_enabled=ASK_DEFAULTS.hybrid_enabled,
		metadata_backend=meta_backend,
		metadata_ok=meta_ok,
		active_generation_gate_enabled=settings.active_generation_gate_enabled,
		active_generation_gate_ok=active_gate_ok,
	)
