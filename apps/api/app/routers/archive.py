from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from app.security.internal_context import RequestContext, require_internal_context
from app.schemas import (
	ArchiveDebugResponse,
	ArchiveThreadRequest,
	ArchiveTurnInput,
	ArchiveTurnResponse,
	Citation,
	ThreadDetailResponse,
	ThreadResponse,
)
from app.services.ask_trace import sanitize_retrieval_debug
from app.services.metadata import MetadataStore, get_metadata_store
from app.settings import Settings, get_settings

router = APIRouter(tags=["archive"])


def get_meta(settings: Settings = Depends(get_settings)) -> MetadataStore:
	return get_metadata_store(settings)


def _safe_debug(row: dict) -> dict | None:
	raw = row.get("retrieval_debug")
	return sanitize_retrieval_debug(raw if isinstance(raw, dict) else None)


def _to_turn_response(row: dict) -> ArchiveTurnResponse:
	citations = []
	for item in row.get("citations") or []:
		try:
			payload = dict(item)
			if not payload.get("text"):
				payload["text"] = str(payload.get("snippet") or "")
			if not payload.get("snippet") and payload.get("text"):
				payload["snippet"] = str(payload["text"])[:280]
			citations.append(Citation.model_validate(payload))
		except Exception:
			continue
	return ArchiveTurnResponse(
		id=row["id"],
		session_id=row["session_id"],
		thread_id=row.get("thread_id"),
		library_id=row.get("library_id"),
		question=row.get("question") or "",
		answer=row.get("answer") or "",
		citations=citations,
		mode=row.get("mode") or "stub",
		refused=bool(row.get("refused")),
		refuse_reason=row.get("refuse_reason"),
		query_type=row.get("query_type"),
		rewrite=row.get("rewrite"),
		rewritten_query=row.get("rewritten_query"),
		judge=row.get("judge") if isinstance(row.get("judge"), dict) else None,
		retrieval_plan=(
			row.get("retrieval_plan") if isinstance(row.get("retrieval_plan"), dict) else None
		),
		retrieval_debug=_safe_debug(row),
		document_version_id=row.get("document_version_id"),
		tenant_id=row.get("tenant_id"),
		created_at=row.get("created_at") or "",
	)


def _to_debug_response(row: dict) -> ArchiveDebugResponse:
	debug = _safe_debug(row) or {}
	return ArchiveDebugResponse(
		turn_id=row["id"],
		session_id=row["session_id"],
		thread_id=row.get("thread_id"),
		library_id=row.get("library_id"),
		created_at=row.get("created_at") or "",
		refused=bool(row.get("refused")),
		refuse_reason=row.get("refuse_reason"),
		trace_id=str(debug["trace_id"]) if debug.get("trace_id") is not None else None,
		question_hash=(
			str(debug["question_hash"]) if debug.get("question_hash") is not None else None
		),
		retrieval_debug=debug,
	)


def _to_thread_response(row: dict) -> ThreadResponse:
	return ThreadResponse(
		id=row["id"],
		session_id=row.get("session_id"),
		library_id=row.get("library_id"),
		title=row.get("title") or "未命名会话",
		status=row.get("status") or "active",
		tenant_id=row.get("tenant_id"),
		workspace_id=row.get("workspace_id"),
		principal_id=row.get("principal_id"),
		turn_count=int(row.get("turn_count") or 0),
		created_at=row.get("created_at") or "",
		updated_at=row.get("updated_at") or "",
	)


def _default_title(turns: list[ArchiveTurnInput]) -> str:
	first = (turns[0].question or "").strip()
	if not first:
		return "未命名会话"
	return first[:80]


def _turns_chronological(turns: list[dict]) -> list[dict]:
	"""Return oldest→newest for replay labels (list_turns may be newest-first)."""
	if not turns:
		return []
	return sorted(
		turns,
		key=lambda item: (item.get("created_at") or "", item.get("id") or ""),
	)


@router.post("/threads", response_model=ThreadDetailResponse)
def archive_thread(
	body: ArchiveThreadRequest,
	meta: MetadataStore = Depends(get_meta),
	context: RequestContext = Depends(require_internal_context),
) -> ThreadDetailResponse:
	"""Explicit archive: persist client temp turns into a Thread (appears in history)."""
	title = (body.title or "").strip() or _default_title(body.turns)
	session_id = (body.session_id or "").strip() or None
	library_id = (body.library_id or "").strip() or None
	thread = meta.create_thread(
		title=title,
		session_id=session_id,
		library_id=library_id,
		status="active",
		tenant_id=context.tenant_id,
		workspace_id=context.workspace_id,
		principal_id=context.principal_id,
	)
	stored: list[ArchiveTurnResponse] = []
	# Persist in chronological order (client usually sends oldest→newest).
	for item in body.turns:
		row = meta.create_turn(
			session_id=session_id or thread["id"],
			thread_id=thread["id"],
			library_id=(item.library_id or library_id),
			question=item.question,
			answer=item.answer or "",
			citations=[c.model_dump() for c in item.citations],
			mode=item.mode or "stub",
			refused=bool(item.refused),
			refuse_reason=item.refuse_reason,
			tenant_id=context.tenant_id,
			workspace_id=context.workspace_id,
			principal_id=context.principal_id,
		)
		stored.append(_to_turn_response(row))
	refreshed = meta.get_thread(
		thread["id"],
		tenant_id=context.tenant_id,
		workspace_id=context.workspace_id,
		principal_id=context.principal_id,
	) or thread
	detail = _to_thread_response(refreshed)
	return ThreadDetailResponse(**detail.model_dump(), turns=stored)


@router.get("/threads", response_model=list[ThreadResponse])
def list_threads(
	limit: int = Query(default=50, ge=1, le=200),
	meta: MetadataStore = Depends(get_meta),
	context: RequestContext = Depends(require_internal_context),
) -> list[ThreadResponse]:
	rows = meta.list_threads(
		tenant_id=context.tenant_id,
		workspace_id=context.workspace_id,
		principal_id=context.principal_id,
		status="active",
		limit=limit,
	)
	return [_to_thread_response(row) for row in rows]


@router.get("/threads/{thread_id}", response_model=ThreadDetailResponse)
def get_thread(
	thread_id: str,
	meta: MetadataStore = Depends(get_meta),
	context: RequestContext = Depends(require_internal_context),
) -> ThreadDetailResponse:
	row = meta.get_thread(
		thread_id,
		tenant_id=context.tenant_id,
		workspace_id=context.workspace_id,
		principal_id=context.principal_id,
	)
	if row is None or row.get("status") == "hidden":
		raise HTTPException(status_code=404, detail="thread not found")
	turns = meta.list_turns(
		thread_id=thread_id,
		tenant_id=context.tenant_id,
		workspace_id=context.workspace_id,
		principal_id=context.principal_id,
		limit=200,
	)
	# list_turns is newest-first; replay/continue need oldest→newest.
	# Prefer created_at (+ id tie-break). If timestamps collide, reverse preserves
	# insertion order better than an unstable same-second sort.
	turns_sorted = _turns_chronological(turns)
	detail = _to_thread_response(row)
	return ThreadDetailResponse(
		**detail.model_dump(),
		turns=[_to_turn_response(item) for item in turns_sorted],
	)


@router.post("/threads/{thread_id}/continue", response_model=ThreadDetailResponse)
def continue_thread(
	thread_id: str,
	meta: MetadataStore = Depends(get_meta),
	context: RequestContext = Depends(require_internal_context),
) -> ThreadDetailResponse:
	"""Open an archived thread for continue-chat (client then sends ask with thread_id)."""
	row = meta.touch_thread(
		thread_id,
		tenant_id=context.tenant_id,
		workspace_id=context.workspace_id,
		principal_id=context.principal_id,
	)
	if row is None:
		raise HTTPException(status_code=404, detail="thread not found")
	if row.get("status") == "hidden":
		raise HTTPException(status_code=404, detail="thread not found")
	turns = meta.list_turns(
		thread_id=thread_id,
		tenant_id=context.tenant_id,
		workspace_id=context.workspace_id,
		principal_id=context.principal_id,
		limit=200,
	)
	turns_sorted = _turns_chronological(turns)
	refreshed = meta.get_thread(
		thread_id,
		tenant_id=context.tenant_id,
		workspace_id=context.workspace_id,
		principal_id=context.principal_id,
	) or row
	detail = _to_thread_response(refreshed)
	return ThreadDetailResponse(
		**detail.model_dump(),
		turns=[_to_turn_response(item) for item in turns_sorted],
	)


@router.get("/archive", response_model=list[ArchiveTurnResponse])
def list_archive(
	library_id: str | None = Query(default=None),
	session_id: str | None = Query(default=None),
	thread_id: str | None = Query(default=None),
	limit: int = Query(default=50, ge=1, le=200),
	meta: MetadataStore = Depends(get_meta),
	context: RequestContext = Depends(require_internal_context),
) -> list[ArchiveTurnResponse]:
	rows = meta.list_turns(
		library_id=library_id,
		session_id=session_id,
		thread_id=thread_id,
		tenant_id=context.tenant_id,
		workspace_id=context.workspace_id,
		principal_id=context.principal_id,
		limit=limit,
	)
	return [_to_turn_response(row) for row in rows]


@router.get("/archive/{turn_id}", response_model=ArchiveTurnResponse)
def get_archive_turn(
	turn_id: str,
	meta: MetadataStore = Depends(get_meta),
	context: RequestContext = Depends(require_internal_context),
) -> ArchiveTurnResponse:
	row = meta.get_turn(
		turn_id,
		tenant_id=context.tenant_id,
		workspace_id=context.workspace_id,
		principal_id=context.principal_id,
	)
	if row is None:
		raise HTTPException(status_code=404, detail="turn not found")
	return _to_turn_response(row)


@router.get("/archive/{turn_id}/debug", response_model=ArchiveDebugResponse)
def get_archive_turn_debug(
	turn_id: str,
	meta: MetadataStore = Depends(get_meta),
	context: RequestContext = Depends(require_internal_context),
) -> ArchiveDebugResponse:
	"""Read sanitized retrieval_debug for adjudicate/retrieve replay (no UI required)."""
	row = meta.get_turn(
		turn_id,
		tenant_id=context.tenant_id,
		workspace_id=context.workspace_id,
		principal_id=context.principal_id,
	)
	if row is None:
		raise HTTPException(status_code=404, detail="turn not found")
	return _to_debug_response(row)
