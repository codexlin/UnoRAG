"""AskGraph turn persistence (archived threads → metadata store)."""

from __future__ import annotations

import logging
from typing import Any

from app.schemas import Citation

logger = logging.getLogger(__name__)


def single_document_version_id(citations: list[Citation]) -> str | None:
	"""Turn 只有一个文档版本时提供便捷字段；完整快照仍以 citations 为准。"""
	version_ids = {
		item.document_version_id
		for item in citations
		if item.document_version_id
	}
	return next(iter(version_ids)) if len(version_ids) == 1 else None


def persist_turn(
	*,
	session_id: str,
	library_id: str | None,
	question: str,
	answer: str,
	citations: list[Citation],
	mode: str,
	refused: bool,
	refuse_reason: str | None,
	thread_id: str | None = None,
	query_type: str | None = None,
	retrieval_plan: dict[str, Any] | None = None,
	retrieval_debug: dict[str, Any] | None = None,
	rewrite: str | None = None,
	rewritten_query: str | None = None,
	judge: dict[str, Any] | None = None,
	document_version_id: str | None = None,
	tenant_id: str | None = None,
	workspace_id: str | None = None,
	principal_id: str | None = None,
) -> dict[str, Any]:
	# Default-temp: only archived (thread-bound) turns are written to durable storage.
	if not thread_id:
		return {"persisted": False, "persist_error": None}
	try:
		from app.services.metadata import get_metadata_store

		get_metadata_store().create_turn(
			session_id=session_id,
			thread_id=thread_id,
			library_id=library_id,
			question=question,
			answer=answer,
			citations=[item.model_dump() for item in citations],
			mode=mode,
			refused=refused,
			refuse_reason=refuse_reason,
			query_type=query_type,
			retrieval_plan=retrieval_plan,
			retrieval_debug=retrieval_debug,
			rewrite=rewrite,
			rewritten_query=rewritten_query,
			judge=judge,
			document_version_id=document_version_id,
			tenant_id=tenant_id,
			workspace_id=workspace_id,
			principal_id=principal_id,
		)
		return {"persisted": True, "persist_error": None}
	except Exception as exc:
		logger.exception(
			"ask.persist_turn_failed session_id=%s thread_id=%s",
			session_id,
			thread_id,
		)
		return {"persisted": False, "persist_error": str(exc)}
