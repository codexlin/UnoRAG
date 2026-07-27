"""DEPRECATION: FastAPI browser/product ingest write paths — permanently retired (410).

对外入口永久废弃；禁止新调用方。
最早删除版本：正式 GO 后的下一 major；删除前置：确认无调用日志、契约测试仍覆盖 410、发布迁移说明。
Product uploads: Next.js → app.jobs → lifecycle_worker.
No env switch can re-enable these routes.
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
	"""Always fail closed — no env switch can re-enable FastAPI ingest writes.

	DEPRECATION: 永久废弃对外入口；禁止新调用方。
	最早删除版本：正式 GO 后的下一 major；删除前置：确认无调用日志、契约测试仍覆盖 410、发布迁移说明。
	"""
	raise HTTPException(
		status_code=410,
		detail={
			"message": FASTAPI_INGEST_GONE_DETAIL,
			"code": "legacy_ingest_writes_disabled",
			"deprecated": True,
		},
	)
