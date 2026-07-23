from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from app.schemas import ArchiveTurnResponse, Citation
from app.services.metadata import MetadataStore, get_metadata_store
from app.settings import Settings, get_settings

router = APIRouter(tags=["archive"])


def get_meta(settings: Settings = Depends(get_settings)) -> MetadataStore:
	return get_metadata_store(settings)


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
		document_version_id=row.get("document_version_id"),
		tenant_id=row.get("tenant_id"),
		created_at=row.get("created_at") or "",
	)


@router.get("/archive", response_model=list[ArchiveTurnResponse])
def list_archive(
	library_id: str | None = Query(default=None),
	session_id: str | None = Query(default=None),
	limit: int = Query(default=50, ge=1, le=200),
	meta: MetadataStore = Depends(get_meta),
) -> list[ArchiveTurnResponse]:
	rows = meta.list_turns(library_id=library_id, session_id=session_id, limit=limit)
	return [_to_turn_response(row) for row in rows]


@router.get("/archive/{turn_id}", response_model=ArchiveTurnResponse)
def get_archive_turn(
	turn_id: str,
	meta: MetadataStore = Depends(get_meta),
) -> ArchiveTurnResponse:
	row = meta.get_turn(turn_id)
	if row is None:
		raise HTTPException(status_code=404, detail="turn not found")
	return _to_turn_response(row)
