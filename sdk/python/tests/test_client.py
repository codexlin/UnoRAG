"""Tests for MeriKnow Python SDK using httpx.MockTransport (no live server)."""

from __future__ import annotations

import json

import httpx
import pytest

from meriknow import (
    ErrorCode,
    MeriKnow,
    MeriKnowAPIError,
    MeriKnowVersionError,
    RetrieveFilters,
)


TRACE = "11111111-1111-4111-8111-111111111111"
HEADERS = {
    "Content-Type": "application/json",
    "X-Request-Id": TRACE,
    "X-MeriKnow-Api-Version": "1",
}


def _client(handler) -> MeriKnow:
    transport = httpx.MockTransport(handler)
    return MeriKnow(
        base_url="http://example.test",
        service_key="mk_svc_test_key_not_real",
        transport=transport,
    )


def test_retrieve_success_matches_contract():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/api/v1/retrieve"
        assert request.headers["Authorization"] == "Bearer mk_svc_test_key_not_real"
        assert request.headers["X-MeriKnow-Api-Version"] == "1"
        assert request.headers["Content-Type"] == "application/json"
        body = json.loads(request.content)
        assert body == {
            "query": "病假证明几天内补交？",
            "library_id": "lib_1",
            "top_k": 6,
        }
        return httpx.Response(
            200,
            headers=HEADERS,
            json={
                "api_version": "v1",
                "trace_id": TRACE,
                "query": "病假证明几天内补交？",
                "library_id": "lib_1",
                "citations": [
                    {
                        "id": "c1",
                        "index": 1,
                        "title": "政策",
                        "snippet": "三日内补交",
                        "score": 0.91,
                        "document_id": "d1",
                        "filename": "policy.md",
                        "page": None,
                        "page_start": None,
                        "page_end": None,
                        "section_path": None,
                        "table_id": None,
                        "row_start": None,
                        "row_end": None,
                        "record_type": "chunk",
                    }
                ],
                "refused": False,
                "refuse_reason": None,
                "retrieval_mode": "dense",
            },
        )

    with _client(handler) as client:
        result = client.retrieve(
            query="病假证明几天内补交？",
            library_id="lib_1",
            top_k=6,
        )

    assert result.api_version == "v1"
    assert result.trace_id == TRACE
    assert result.refused is False
    assert len(result.citations) == 1
    assert result.citations[0].filename == "policy.md"
    assert result.citations[0].score == pytest.approx(0.91)


def test_retrieve_with_filters():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["filters"] == {"record_type": "chunk", "doc_id": "doc-9"}
        return httpx.Response(
            200,
            headers=HEADERS,
            json={
                "api_version": "v1",
                "trace_id": TRACE,
                "query": "q",
                "library_id": "lib_1",
                "citations": [],
                "refused": True,
                "refuse_reason": "no_matching_evidence",
                "retrieval_mode": "dense",
            },
        )

    with _client(handler) as client:
        result = client.retrieve(
            query="q",
            library_id="lib_1",
            filters=RetrieveFilters(record_type="chunk", doc_id="doc-9"),
        )

    assert result.refused is True
    assert result.refuse_reason == "no_matching_evidence"
    assert result.citations == ()


def test_ask_success():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/ask"
        body = json.loads(request.content)
        assert body == {
            "question": "病假证明几天内补交？",
            "library_id": "lib_1",
            "session_id": "demo-1",
        }
        return httpx.Response(
            200,
            headers=HEADERS,
            json={
                "api_version": "v1",
                "trace_id": TRACE,
                "session_id": "demo-1",
                "question": "病假证明几天内补交？",
                "answer": "应在三日内补交。",
                "citations": [],
                "refused": False,
                "refuse_reason": None,
                "retrieval_mode": "dense",
            },
        )

    with _client(handler) as client:
        result = client.ask(
            question="病假证明几天内补交？",
            library_id="lib_1",
            session_id="demo-1",
        )

    assert result.answer == "应在三日内补交。"
    assert result.session_id == "demo-1"


def test_api_error_maps_stable_code():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            headers=HEADERS,
            json={
                "error": {
                    "code": "invalid_request",
                    "message": "request contains unsupported fields",
                    "request_id": TRACE,
                    "retryable": False,
                    "details": {"fields": ["ask_overrides"]},
                }
            },
        )

    with _client(handler) as client:
        with pytest.raises(MeriKnowAPIError) as caught:
            client.ask(question="q", library_id="lib_1")

    err = caught.value
    assert err.code == ErrorCode.INVALID_REQUEST
    assert err.retryable is False
    assert err.request_id == TRACE
    assert err.status_code == 400
    assert err.details == {"fields": ["ask_overrides"]}


def test_rate_limit_includes_retry_after():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            headers={**HEADERS, "Retry-After": "12"},
            json={
                "error": {
                    "code": "rate_limit_exceeded",
                    "message": "slow down",
                    "request_id": TRACE,
                    "retryable": True,
                }
            },
        )

    with _client(handler) as client:
        with pytest.raises(MeriKnowAPIError) as caught:
            client.retrieve(query="q", library_id="lib_1")

    assert caught.value.code == ErrorCode.RATE_LIMIT_EXCEEDED
    assert caught.value.retryable is True
    assert caught.value.retry_after == "12"


def test_rejects_unexpected_api_version_header():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={
                "Content-Type": "application/json",
                "X-Request-Id": TRACE,
                "X-MeriKnow-Api-Version": "2",
            },
            json={"api_version": "v2"},
        )

    with _client(handler) as client:
        with pytest.raises(MeriKnowVersionError):
            client.retrieve(query="q", library_id="lib_1")


def test_env_defaults(monkeypatch):
    monkeypatch.setenv("MERIKNOW_BASE_URL", "http://env.test")
    monkeypatch.setenv("MERIKNOW_SERVICE_KEY", "mk_svc_from_env")

    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers["Authorization"]
        seen["host"] = request.url.host
        return httpx.Response(
            200,
            headers=HEADERS,
            json={
                "api_version": "v1",
                "trace_id": TRACE,
                "query": "q",
                "library_id": "lib_1",
                "citations": [],
                "refused": False,
                "refuse_reason": None,
                "retrieval_mode": "dense",
            },
        )

    transport = httpx.MockTransport(handler)
    with MeriKnow(transport=transport) as client:
        client.retrieve(query="q", library_id="lib_1")

    assert seen["auth"] == "Bearer mk_svc_from_env"
    assert seen["host"] == "env.test"


def test_rejects_non_service_key():
    with pytest.raises(Exception, match="mk_svc_"):
        MeriKnow(base_url="http://example.test", service_key="sk-wrong")
