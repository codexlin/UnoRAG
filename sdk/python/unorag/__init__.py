"""UnoRAG Python SDK — thin HTTP adapter for Knowledge API v1."""

from __future__ import annotations

from unorag.client import UnoRAG, UnoRAGClient
from unorag.errors import (
    ErrorCode,
    UnoRAGAPIError,
    UnoRAGError,
    UnoRAGTransportError,
    UnoRAGVersionError,
)
from unorag.models import (
    AskResponse,
    Citation,
    RetrieveFilters,
    RetrieveResponse,
)

__all__ = [
    "AskResponse",
    "Citation",
    "ErrorCode",
    "UnoRAG",
    "UnoRAGAPIError",
    "UnoRAGClient",
    "UnoRAGError",
    "UnoRAGTransportError",
    "UnoRAGVersionError",
    "RetrieveFilters",
    "RetrieveResponse",
    "__version__",
]

__version__ = "0.1.0"
