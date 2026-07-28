"""Tests for UnoRAG MCP tools (mock UnoRAG client — no live server)."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock

import pytest
from unorag import (
    AskResponse,
    Citation,
    ErrorCode,
    UnoRAGAPIError,
    UnoRAGError,
    UnoRAGTransportError,
    UnoRAGVersionError,
    RetrieveResponse,
)
from unorag_mcp.formatting import error_payload, filters_mapping, response_to_dict
from unorag_mcp.server import create_server


TRACE = "11111111-1111-4111-8111-111111111111"

CITATION = Citation(
    id="c1",
    index=1,
    title="政策",
    snippet="三日内补交",
    score=0.91,
    document_id="d1",
    filename="policy.md",
    page=None,
    page_start=None,
    page_end=None,
    section_path=None,
    table_id=None,
    row_start=None,
    row_end=None,
    record_type="chunk",
)


def _mock_client(**methods: Any) -> MagicMock:
    client = MagicMock()
    for name, value in methods.items():
        getattr(client, name).side_effect = value if callable(value) else None
        if not callable(value):
            getattr(client, name).return_value = value
    return client


async def _call_tool(mcp, name: str, arguments: dict[str, Any]):
    return await mcp.call_tool(name, arguments)


@pytest.mark.asyncio
async def test_lists_retrieve_and_ask_tools():
    mcp = create_server(client_factory=lambda: _mock_client())
    tools = await mcp.list_tools()
    names = sorted(t.name for t in tools)
    assert names == ["ask", "retrieve"]


@pytest.mark.asyncio
async def test_retrieve_maps_to_sdk_and_returns_contract_shape():
    retrieve_response = RetrieveResponse(
        api_version="v1",
        trace_id=TRACE,
        query="病假证明几天内补交？",
        library_id="lib_1",
        citations=(CITATION,),
        refused=False,
        refuse_reason=None,
        retrieval_mode="dense",
    )
    client = _mock_client(retrieve=retrieve_response)
    mcp = create_server(client_factory=lambda: client)

    result = await _call_tool(
        mcp,
        "retrieve",
        {
            "query": "病假证明几天内补交？",
            "library_id": "lib_1",
            "top_k": 6,
            "filters": {"record_type": "chunk", "doc_id": "doc-9"},
        },
    )

    # FastMCP may return (content, structured) or CallToolResult depending on version
    payload = _tool_payload(result)
    assert payload["api_version"] == "v1"
    assert payload["trace_id"] == TRACE
    assert payload["refused"] is False
    assert payload["citations"][0]["filename"] == "policy.md"

    client.retrieve.assert_called_once_with(
        query="病假证明几天内补交？",
        library_id="lib_1",
        top_k=6,
        filters={"record_type": "chunk", "doc_id": "doc-9"},
    )
    client.close.assert_called_once()


@pytest.mark.asyncio
async def test_ask_maps_to_sdk():
    ask_response = AskResponse(
        api_version="v1",
        trace_id=TRACE,
        session_id="demo-1",
        question="病假证明几天内补交？",
        answer="应在三日内补交。",
        citations=(),
        refused=False,
        refuse_reason=None,
        retrieval_mode="dense",
    )
    client = _mock_client(ask=ask_response)
    mcp = create_server(client_factory=lambda: client)

    result = await _call_tool(
        mcp,
        "ask",
        {
            "question": "病假证明几天内补交？",
            "library_id": "lib_1",
            "session_id": "demo-1",
        },
    )

    payload = _tool_payload(result)
    assert payload["answer"] == "应在三日内补交。"
    assert payload["session_id"] == "demo-1"
    client.ask.assert_called_once_with(
        question="病假证明几天内补交？",
        library_id="lib_1",
        session_id="demo-1",
    )


@pytest.mark.asyncio
async def test_retrieve_refused_true_is_success_not_tool_error():
    refused = RetrieveResponse(
        api_version="v1",
        trace_id=TRACE,
        query="无关问题",
        library_id="lib_1",
        citations=(),
        refused=True,
        refuse_reason="no_relevant_evidence",
        retrieval_mode="dense",
    )
    client = _mock_client(retrieve=refused)
    mcp = create_server(client_factory=lambda: client)

    result = await _call_tool(
        mcp, "retrieve", {"query": "无关问题", "library_id": "lib_1"}
    )

    payload = _tool_payload(result)
    assert payload["refused"] is True
    assert payload["citations"] == []
    assert payload["refuse_reason"] == "no_relevant_evidence"
    client.close.assert_called_once()


@pytest.mark.asyncio
async def test_unknown_filter_keys_are_invalid_request():
    client = _mock_client(retrieve=MagicMock())
    mcp = create_server(client_factory=lambda: client)

    with pytest.raises(Exception) as caught:
        await _call_tool(
            mcp,
            "retrieve",
            {
                "query": "q",
                "library_id": "lib_1",
                "filters": {"record_type": "chunk", "ask_overrides": "x"},
            },
        )

    envelope = json.loads(_exception_text(caught.value))
    assert envelope["error"]["code"] == "invalid_request"
    assert envelope["error"]["details"]["fields"] == ["ask_overrides"]
    client.retrieve.assert_not_called()


def test_filters_mapping_rejects_unknown_keys():
    with pytest.raises(UnoRAGAPIError) as caught:
        filters_mapping({"doc_id": "d1", "extra": "nope", "foo": "bar"})
    assert caught.value.code == ErrorCode.INVALID_REQUEST
    assert caught.value.details["fields"] == ["extra", "foo"]


@pytest.mark.asyncio
async def test_version_error_is_unexpected_api_version_tool_error():
    def boom(**_: Any) -> None:
        raise UnoRAGVersionError(
            "unexpected API version",
            expected="1",
            actual="2",
        )

    client = _mock_client(ask=boom)
    mcp = create_server(client_factory=lambda: client)

    with pytest.raises(Exception) as caught:
        await _call_tool(mcp, "ask", {"question": "q", "library_id": "lib_1"})

    envelope = json.loads(_exception_text(caught.value))
    assert envelope["error"]["code"] == "unexpected_api_version"
    assert envelope["error"]["retryable"] is False
    assert envelope["error"]["details"] == {"expected": "1", "actual": "2"}


@pytest.mark.asyncio
async def test_factory_config_error_surfaces_client_error_envelope():
    def missing_env() -> MagicMock:
        raise UnoRAGError("base_url is required (or set UNORAG_BASE_URL)")

    mcp = create_server(client_factory=missing_env)

    with pytest.raises(Exception) as caught:
        await _call_tool(
            mcp, "retrieve", {"query": "q", "library_id": "lib_1"}
        )

    envelope = json.loads(_exception_text(caught.value))
    assert envelope["error"]["code"] == "client_error"
    assert "UNORAG_BASE_URL" in envelope["error"]["message"]
    assert envelope["error"]["retryable"] is False


@pytest.mark.asyncio
async def test_api_error_surfaces_stable_code_as_tool_error():
    def boom(**_: Any) -> None:
        raise UnoRAGAPIError(
            code=ErrorCode.INVALID_REQUEST,
            message="request contains unsupported fields",
            request_id=TRACE,
            retryable=False,
            details={"fields": ["ask_overrides"]},
            status_code=400,
        )

    client = _mock_client(ask=boom)
    mcp = create_server(client_factory=lambda: client)

    with pytest.raises(Exception) as caught:
        await _call_tool(mcp, "ask", {"question": "q", "library_id": "lib_1"})

    # FastMCP may wrap as ToolError / ExceptionGroup / RuntimeError with JSON text
    text = _exception_text(caught.value)
    envelope = json.loads(text)
    assert envelope["error"]["code"] == "invalid_request"
    assert envelope["error"]["request_id"] == TRACE
    assert envelope["error"]["retryable"] is False
    assert envelope["error"]["details"] == {"fields": ["ask_overrides"]}


@pytest.mark.asyncio
async def test_transport_error_is_retryable_tool_error():
    def boom(**_: Any) -> None:
        raise UnoRAGTransportError("request timed out")

    client = _mock_client(retrieve=boom)
    mcp = create_server(client_factory=lambda: client)

    with pytest.raises(Exception) as caught:
        await _call_tool(
            mcp, "retrieve", {"query": "q", "library_id": "lib_1"}
        )

    envelope = json.loads(_exception_text(caught.value))
    assert envelope["error"]["code"] == "transport_error"
    assert envelope["error"]["retryable"] is True


def test_response_to_dict_roundtrip():
    response = RetrieveResponse(
        api_version="v1",
        trace_id=TRACE,
        query="q",
        library_id="lib_1",
        citations=(CITATION,),
        refused=False,
        refuse_reason=None,
        retrieval_mode="dense",
    )
    data = response_to_dict(response)
    assert data["citations"][0]["score"] == pytest.approx(0.91)
    assert set(data.keys()) >= {
        "api_version",
        "trace_id",
        "query",
        "library_id",
        "citations",
        "refused",
        "refuse_reason",
        "retrieval_mode",
    }


def test_error_payload_maps_rate_limit():
    err = UnoRAGAPIError(
        code=ErrorCode.RATE_LIMIT_EXCEEDED,
        message="slow down",
        request_id=TRACE,
        retryable=True,
        status_code=429,
        retry_after="12",
    )
    payload = error_payload(err)
    assert payload["error"]["code"] == "rate_limit_exceeded"
    assert payload["error"]["retry_after"] == "12"


def _tool_payload(result: Any) -> dict[str, Any]:
    """Normalize FastMCP call_tool return shapes across SDK versions."""
    if isinstance(result, tuple) and len(result) >= 1:
        # Newer FastMCP: (list[Content], structured_dict | None)
        content, structured = result[0], result[1] if len(result) > 1 else None
        if isinstance(structured, dict):
            return structured
        if isinstance(content, list) and content:
            text = getattr(content[0], "text", None)
            if text:
                return json.loads(text)
        raise AssertionError(f"unexpected tuple tool result: {result!r}")

    if isinstance(result, dict):
        return result

    # CallToolResult-like
    structured = getattr(result, "structuredContent", None) or getattr(
        result, "structured_content", None
    )
    if isinstance(structured, dict):
        return structured
    content = getattr(result, "content", None)
    if content:
        text = getattr(content[0], "text", None)
        if text:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
    raise AssertionError(f"unexpected tool result: {result!r}")


def _exception_text(exc: BaseException) -> str:
    """Extract JSON error text from FastMCP / pytest exception wrappers."""
    message = str(exc)
    # Prefer a JSON object substring if present
    start = message.find("{")
    end = message.rfind("}")
    if start != -1 and end != -1 and end > start:
        candidate = message[start : end + 1]
        try:
            json.loads(candidate)
            return candidate
        except json.JSONDecodeError:
            pass
    # ExceptionGroup (Python 3.11+)
    sub = getattr(exc, "exceptions", None)
    if sub:
        return _exception_text(sub[0])
    cause = getattr(exc, "__cause__", None)
    if cause is not None:
        return _exception_text(cause)
    return message
