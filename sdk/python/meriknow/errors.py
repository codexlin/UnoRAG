"""Stable error mapping for MeriKnow Knowledge API v1."""

from __future__ import annotations

from enum import Enum
from typing import Any, Mapping, Optional


class ErrorCode(str, Enum):
    """Closed set of public v1 ``error.code`` values."""

    INVALID_REQUEST = "invalid_request"
    AUTHENTICATION_REQUIRED = "authentication_required"
    AUTHENTICATION_FAILED = "authentication_failed"
    INSUFFICIENT_SCOPE = "insufficient_scope"
    LIBRARY_ACCESS_DENIED = "library_access_denied"
    PAYLOAD_TOO_LARGE = "payload_too_large"
    UNSUPPORTED_MEDIA_TYPE = "unsupported_media_type"
    RATE_LIMIT_EXCEEDED = "rate_limit_exceeded"
    UPSTREAM_UNAVAILABLE = "upstream_unavailable"
    INVALID_UPSTREAM_RESPONSE = "invalid_upstream_response"
    SERVICE_UNAVAILABLE = "service_unavailable"
    POLICY_UNAVAILABLE = "policy_unavailable"
    AUTHENTICATION_BACKEND_UNAVAILABLE = "authentication_backend_unavailable"
    GATEWAY_MISCONFIGURED = "gateway_misconfigured"
    UPSTREAM_TIMEOUT = "upstream_timeout"

    @classmethod
    def from_value(cls, value: str) -> ErrorCode | str:
        try:
            return cls(value)
        except ValueError:
            return value


class MeriKnowError(Exception):
    """Base error for the MeriKnow SDK."""


class MeriKnowTransportError(MeriKnowError):
    """Network / transport failure before a MeriKnow error envelope is available."""

    def __init__(self, message: str, *, cause: Optional[BaseException] = None) -> None:
        super().__init__(message)
        self.cause = cause


class MeriKnowVersionError(MeriKnowError):
    """Response advertised an unexpected API major version."""

    def __init__(
        self,
        message: str,
        *,
        expected: str = "1",
        actual: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.expected = expected
        self.actual = actual


class MeriKnowAPIError(MeriKnowError):
    """Structured API error matching the frozen error envelope."""

    def __init__(
        self,
        *,
        code: ErrorCode | str,
        message: str,
        request_id: Optional[str] = None,
        retryable: bool = False,
        details: Optional[Mapping[str, Any]] = None,
        status_code: Optional[int] = None,
        retry_after: Optional[str] = None,
        api_version: Optional[str] = None,
    ) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.request_id = request_id
        self.retryable = retryable
        self.details = dict(details or {})
        self.status_code = status_code
        self.retry_after = retry_after
        self.api_version = api_version

    @classmethod
    def from_response(
        cls,
        *,
        status_code: int,
        body: Mapping[str, Any],
        headers: Mapping[str, str],
    ) -> MeriKnowAPIError:
        error = body.get("error") if isinstance(body.get("error"), Mapping) else {}
        if not isinstance(error, Mapping):
            error = {}
        raw_code = error.get("code")
        code: ErrorCode | str
        if isinstance(raw_code, str) and raw_code:
            code = ErrorCode.from_value(raw_code)
        else:
            code = f"http_{status_code}"
        message = str(error.get("message") or f"HTTP {status_code}")
        details = error.get("details")
        return cls(
            code=code,
            message=message,
            request_id=_as_optional_str(error.get("request_id"))
            or headers.get("x-request-id"),
            retryable=bool(error.get("retryable", False)),
            details=details if isinstance(details, Mapping) else {},
            status_code=status_code,
            retry_after=headers.get("retry-after"),
            api_version=headers.get("x-meriknow-api-version"),
        )


def _as_optional_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    return str(value)
