from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from app.schemas import Citation, RetrieveRequest, RetrieveResponse
from app.security.access_scope import AccessScope
from app.security.internal_context import RequestContext, require_internal_context
from app.services.ask_defaults import ASK_DEFAULTS
from app.services.ask_overrides import effective_ask_settings
from app.services.ask_trace import resolve_trace_id
from app.services.retrieval import RetrievalService
from app.services.runtime import resolve_runtime
from app.settings import Settings, get_settings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["retrieve"])


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


def get_retrieval_service(
	settings: Settings = Depends(get_settings),
	context: RequestContext = Depends(require_internal_context),
) -> RetrievalService:
	capability = resolve_runtime(settings)
	if not capability.ask_ready:
		raise HTTPException(
			status_code=503,
			detail=_unavailable_detail(
				capability,
				message="retrieve unavailable: live mode requires embeddings and reachable Qdrant",
			),
		)
	return RetrievalService(
		settings,
		access_scope=AccessScope.from_request_context(context),
	)


@router.post("/retrieve", response_model=RetrieveResponse)
def retrieve(
	body: RetrieveRequest,
	request: Request,
	settings: Settings = Depends(get_settings),
	context: RequestContext = Depends(require_internal_context),
) -> RetrieveResponse:
	library_id = body.library_id.strip()
	if not library_id:
		raise HTTPException(status_code=400, detail="library_id is required")
	query = body.query.strip()
	if not query:
		raise HTTPException(status_code=400, detail="query is required")

	capability = resolve_runtime(settings)
	if not capability.ask_ready:
		raise HTTPException(
			status_code=503,
			detail=_unavailable_detail(
				capability,
				message="retrieve unavailable: live mode requires embeddings and reachable Qdrant",
			),
		)

	effective = effective_ask_settings(
		settings,
		body.ask_overrides,
		question=query,
	)
	service = RetrievalService(
		effective,
		access_scope=AccessScope.from_request_context(context),
	)

	top_k = body.top_k
	if top_k is None:
		top_k = int(
			getattr(effective, "retrieve_top_k", ASK_DEFAULTS.retrieve_top_k)
		)

	trace_id = resolve_trace_id(
		x_request_id=request.headers.get("x-request-id"),
		request_id=context.request_id,
	)
	try:
		hits = service.search(
			query=query,
			library_id=library_id,
			top_k=top_k,
			filters=body.filters,
		)
	except ValueError as exc:
		raise HTTPException(status_code=400, detail=str(exc)) from exc

	citations = [Citation.model_validate(item) for item in hits]
	debug = dict(service.last_debug or {})
	debug["trace_id"] = trace_id
	debug["principal_id"] = context.principal_id
	debug["auth_source"] = context.auth_source

	refused = len(citations) == 0
	return RetrieveResponse(
		query=query,
		library_id=library_id,
		citations=citations,
		refused=refused,
		refuse_reason="no_matching_evidence" if refused else None,
		retrieval_mode=str(debug.get("retrieval_mode") or "dense"),
		retrieval_debug=debug,
	)
