"""Serialize SDK responses / errors for MCP tool results."""

from __future__ import annotations

import json
from dataclasses import asdict
from typing import Any, Mapping

from unorag import (
    AskResponse,
    ErrorCode,
    UnoRAGAPIError,
    UnoRAGError,
    UnoRAGTransportError,
    UnoRAGVersionError,
    RetrieveResponse,
)

ALLOWED_FILTER_KEYS = frozenset(
    {"record_type", "doc_id", "table_id", "document_version_id"}
)


def response_to_dict(response: RetrieveResponse | AskResponse) -> dict[str, Any]:
    """Convert frozen dataclass responses to JSON-serializable dicts."""
    return asdict(response)


def error_payload(exc: BaseException) -> dict[str, Any]:
    """Map SDK exceptions to a stable error envelope (aligned with public v1)."""
    if isinstance(exc, UnoRAGAPIError):
        code = exc.code.value if isinstance(exc.code, ErrorCode) else str(exc.code)
        error: dict[str, Any] = {
            "code": code,
            "message": exc.message,
            "retryable": bool(exc.retryable),
        }
        if exc.request_id is not None:
            error["request_id"] = exc.request_id
        if exc.details:
            error["details"] = dict(exc.details)
        if exc.status_code is not None:
            error["status_code"] = exc.status_code
        if exc.retry_after is not None:
            error["retry_after"] = exc.retry_after
        return {"error": error}

    if isinstance(exc, UnoRAGVersionError):
        return {
            "error": {
                "code": "unexpected_api_version",
                "message": str(exc),
                "retryable": False,
                "details": {
                    "expected": exc.expected,
                    "actual": exc.actual,
                },
            }
        }

    if isinstance(exc, UnoRAGTransportError):
        return {
            "error": {
                "code": "transport_error",
                "message": str(exc),
                "retryable": True,
            }
        }

    if isinstance(exc, UnoRAGError):
        return {
            "error": {
                "code": "client_error",
                "message": str(exc),
                "retryable": False,
            }
        }

    return {
        "error": {
            "code": "internal_error",
            "message": str(exc),
            "retryable": False,
        }
    }


def error_text(exc: BaseException) -> str:
    """JSON text payload for MCP ``isError`` tool results."""
    return json.dumps(error_payload(exc), ensure_ascii=False)


def filters_mapping(filters: Mapping[str, Any] | None) -> dict[str, str] | None:
    """Normalize optional filters for ``UnoRAG.retrieve``.

    Unknown keys are rejected with ``invalid_request`` (aligned with HTTP v1),
    not silently dropped.
    """
    if filters is None:
        return None
    unknown = sorted(key for key in filters if key not in ALLOWED_FILTER_KEYS)
    if unknown:
        raise UnoRAGAPIError(
            code=ErrorCode.INVALID_REQUEST,
            message="request contains unsupported fields",
            retryable=False,
            details={"fields": unknown},
        )
    out: dict[str, str] = {}
    for key in ("record_type", "doc_id", "table_id", "document_version_id"):
        value = filters.get(key)
        if value is not None:
            out[key] = str(value)
    return out or None
