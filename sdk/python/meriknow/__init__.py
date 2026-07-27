"""MeriKnow Python SDK — thin HTTP adapter for Knowledge API v1."""

from __future__ import annotations

from meriknow.client import MeriKnow, MeriKnowClient
from meriknow.errors import (
    ErrorCode,
    MeriKnowAPIError,
    MeriKnowError,
    MeriKnowTransportError,
    MeriKnowVersionError,
)
from meriknow.models import (
    AskResponse,
    Citation,
    RetrieveFilters,
    RetrieveResponse,
)

__all__ = [
    "AskResponse",
    "Citation",
    "ErrorCode",
    "MeriKnow",
    "MeriKnowAPIError",
    "MeriKnowClient",
    "MeriKnowError",
    "MeriKnowTransportError",
    "MeriKnowVersionError",
    "RetrieveFilters",
    "RetrieveResponse",
    "__version__",
]

__version__ = "0.1.0"
