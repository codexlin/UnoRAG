"""Synchronous UnoRAG Knowledge API v1 HTTP client."""

from __future__ import annotations

import os
from typing import Any, Mapping, Optional, Union

import httpx

from unorag.errors import (
    UnoRAGAPIError,
    UnoRAGError,
    UnoRAGTransportError,
    UnoRAGVersionError,
)
from unorag.models import AskResponse, RetrieveFilters, RetrieveResponse

API_VERSION_HEADER = "X-UnoRAG-Api-Version"
API_VERSION_VALUE = "1"
DEFAULT_TIMEOUT = 60.0


class UnoRAG:
    """Thin sync adapter over ``POST /api/v1/retrieve`` and ``POST /api/v1/ask``.

    Environment defaults (when constructor args are omitted):

    - ``UNORAG_BASE_URL``
    - ``UNORAG_SERVICE_KEY``
    """

    def __init__(
        self,
        *,
        base_url: Optional[str] = None,
        service_key: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        transport: Optional[httpx.BaseTransport] = None,
        client: Optional[httpx.Client] = None,
    ) -> None:
        resolved_base = (base_url or os.environ.get("UNORAG_BASE_URL") or "").rstrip(
            "/"
        )
        resolved_key = service_key or os.environ.get("UNORAG_SERVICE_KEY") or ""
        if not resolved_base:
            raise UnoRAGError(
                "base_url is required (or set UNORAG_BASE_URL)"
            )
        if not resolved_key:
            raise UnoRAGError(
                "service_key is required (or set UNORAG_SERVICE_KEY)"
            )
        if not resolved_key.startswith("mk_svc_"):
            raise UnoRAGError(
                "service_key must start with 'mk_svc_' (UnoRAG Service Key)"
            )

        self._base_url = resolved_base
        self._owns_client = client is None
        headers = {
            "Authorization": f"Bearer {resolved_key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            API_VERSION_HEADER: API_VERSION_VALUE,
        }
        if client is not None:
            self._client = client
        else:
            self._client = httpx.Client(
                base_url=resolved_base,
                headers=headers,
                timeout=timeout,
                transport=transport,
            )

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> UnoRAG:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def retrieve(
        self,
        *,
        query: str,
        library_id: str,
        top_k: Optional[int] = None,
        filters: Optional[Union[RetrieveFilters, Mapping[str, str]]] = None,
    ) -> RetrieveResponse:
        """Call ``POST /api/v1/retrieve``. ``refused`` is a normal business outcome."""
        body: dict[str, Any] = {
            "query": query,
            "library_id": library_id,
        }
        if top_k is not None:
            body["top_k"] = top_k
        if filters is not None:
            if isinstance(filters, RetrieveFilters):
                filter_dict = filters.to_dict()
            else:
                filter_dict = dict(filters)
            if filter_dict:
                body["filters"] = filter_dict
        data = self._request_json("POST", "/api/v1/retrieve", body)
        return RetrieveResponse.from_dict(data)

    def ask(
        self,
        *,
        question: str,
        library_id: str,
        session_id: Optional[str] = None,
    ) -> AskResponse:
        """Call ``POST /api/v1/ask``. ``refused`` is a normal business outcome."""
        body: dict[str, Any] = {
            "question": question,
            "library_id": library_id,
        }
        if session_id is not None:
            body["session_id"] = session_id
        data = self._request_json("POST", "/api/v1/ask", body)
        return AskResponse.from_dict(data)

    def _request_json(
        self, method: str, path: str, body: Mapping[str, Any]
    ) -> dict[str, Any]:
        try:
            response = self._client.request(method, path, json=dict(body))
        except httpx.TimeoutException as exc:
            raise UnoRAGTransportError("request timed out", cause=exc) from exc
        except httpx.HTTPError as exc:
            raise UnoRAGTransportError(f"transport error: {exc}", cause=exc) from exc

        header_map = {k.lower(): v for k, v in response.headers.items()}
        api_version = header_map.get("x-unorag-api-version")
        if api_version is not None and api_version != API_VERSION_VALUE:
            raise UnoRAGVersionError(
                f"unexpected X-UnoRAG-Api-Version: {api_version!r}",
                expected=API_VERSION_VALUE,
                actual=api_version,
            )

        try:
            payload: Any = response.json() if response.content else {}
        except ValueError as exc:
            raise UnoRAGAPIError(
                code=f"http_{response.status_code}",
                message="response body is not valid JSON",
                request_id=header_map.get("x-request-id"),
                retryable=response.status_code >= 500,
                status_code=response.status_code,
                api_version=api_version,
            ) from exc

        if not isinstance(payload, dict):
            raise UnoRAGAPIError(
                code=f"http_{response.status_code}",
                message="response body must be a JSON object",
                request_id=header_map.get("x-request-id"),
                retryable=False,
                status_code=response.status_code,
                api_version=api_version,
            )

        if response.status_code >= 400:
            raise UnoRAGAPIError.from_response(
                status_code=response.status_code,
                body=payload,
                headers=header_map,
            )

        body_version = payload.get("api_version")
        if body_version is not None and body_version != "v1":
            raise UnoRAGVersionError(
                f"unexpected api_version in body: {body_version!r}",
                expected="v1",
                actual=str(body_version),
            )

        return payload


# Alias matching common client naming.
UnoRAGClient = UnoRAG
