"""stdio MCP server exposing Knowledge API v1 ``retrieve`` / ``ask`` tools.

Thin adapter: all HTTP and auth live in the ``meriknow`` Python SDK.
This module does not embed RAG, embeddings, or Qdrant.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Optional

from mcp.server.fastmcp import FastMCP
from meriknow import MeriKnow, MeriKnowError

from meriknow_mcp.formatting import (
    error_text,
    filters_mapping,
    response_to_dict,
)

ClientFactory = Callable[[], MeriKnow]


def create_server(
    *,
    client_factory: Optional[ClientFactory] = None,
    name: str = "meriknow",
) -> FastMCP:
    """Build an MCP server whose tools map 1:1 to public API v1.

    ``client_factory`` defaults to ``MeriKnow`` (env: ``MERIKNOW_BASE_URL``,
    ``MERIKNOW_SERVICE_KEY``). Tests inject a mock factory — no live HTTP.
    """
    factory: ClientFactory = client_factory or MeriKnow
    mcp = FastMCP(name)

    @mcp.tool()
    def retrieve(
        query: str,
        library_id: str,
        top_k: Optional[int] = None,
        filters: Optional[dict[str, str]] = None,
    ) -> dict[str, Any]:
        """Retrieve evidence from a MeriKnow library (POST /api/v1/retrieve).

        Params match frozen public API v1. ``refused`` with empty citations is a
        normal business outcome, not a tool error.

        Args:
            query: Search query (1–4000 chars).
            library_id: Target library id (1–128 chars).
            top_k: Optional result count (1–50).
            filters: Optional object with only ``record_type``, ``doc_id``,
                ``table_id``, ``document_version_id``. Unknown keys →
                ``invalid_request``.
        """
        try:
            client = factory()
            try:
                result = client.retrieve(
                    query=query,
                    library_id=library_id,
                    top_k=top_k,
                    filters=filters_mapping(filters),
                )
                return response_to_dict(result)
            finally:
                close = getattr(client, "close", None)
                if callable(close):
                    close()
        except MeriKnowError as exc:
            raise RuntimeError(error_text(exc)) from exc

    @mcp.tool()
    def ask(
        question: str,
        library_id: str,
        session_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Ask a grounded question against a MeriKnow library (POST /api/v1/ask).

        Params match frozen public API v1. ``refused`` with empty citations is a
        normal business outcome, not a tool error.

        Args:
            question: User question (1–4000 chars).
            library_id: Target library id (1–128 chars).
            session_id: Optional customer-opaque id (≤256); does not create a
                Workspace archive thread.
        """
        try:
            client = factory()
            try:
                result = client.ask(
                    question=question,
                    library_id=library_id,
                    session_id=session_id,
                )
                return response_to_dict(result)
            finally:
                close = getattr(client, "close", None)
                if callable(close):
                    close()
        except MeriKnowError as exc:
            raise RuntimeError(error_text(exc)) from exc

    return mcp


def main() -> None:
    """stdio entrypoint for Cursor / Claude Desktop MCP configs."""
    create_server().run(transport="stdio")


if __name__ == "__main__":
    main()
