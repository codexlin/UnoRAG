"""L6 kill-switch for FastAPI browser/product ingest write paths."""

from __future__ import annotations

from fastapi import HTTPException

from app.settings import Settings

LEGACY_INGEST_GONE_DETAIL = (
	"legacy FastAPI ingest writes are disabled; "
	"use the Next.js document lifecycle control plane "
	"(POST /api/libraries/{id}/documents and related routes)"
)


def reject_legacy_ingest_writes(settings: Settings) -> None:
	"""Fail closed unless LEGACY_INGEST_WRITES_ENABLED is explicitly true."""
	if settings.allows_legacy_ingest_writes:
		return
	raise HTTPException(
		status_code=410,
		detail={
			"message": LEGACY_INGEST_GONE_DETAIL,
			"code": "legacy_ingest_writes_disabled",
			"deprecated": True,
		},
	)


def ensure_legacy_arq_enqueue_allowed(settings: Settings) -> None:
	"""ARQ ingest enqueue is part of the retired product write path."""
	if settings.allows_legacy_ingest_writes:
		return
	raise RuntimeError(
		"ARQ ingest enqueue disabled; document.ingest jobs must be claimed "
		"from app.jobs by the lifecycle worker"
	)
