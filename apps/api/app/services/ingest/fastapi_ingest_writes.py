"""FastAPI browser/product ingest write paths are permanently retired (410).

Product uploads: Next.js → app.jobs → lifecycle_worker.
"""

from __future__ import annotations

from fastapi import HTTPException

FASTAPI_INGEST_GONE_DETAIL = (
	"legacy FastAPI ingest writes are disabled; "
	"use the Next.js document lifecycle control plane "
	"(POST /api/libraries/{id}/documents and related routes)"
)

# Wire-compatible alias for existing clients / proxies.
LEGACY_INGEST_GONE_DETAIL = FASTAPI_INGEST_GONE_DETAIL


def reject_fastapi_ingest_writes() -> None:
	"""Always fail closed — no env switch can re-enable FastAPI ingest writes."""
	raise HTTPException(
		status_code=410,
		detail={
			"message": FASTAPI_INGEST_GONE_DETAIL,
			"code": "legacy_ingest_writes_disabled",
			"deprecated": True,
		},
	)
