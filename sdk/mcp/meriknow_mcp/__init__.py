"""MeriKnow MCP server — thin adapter over Knowledge API v1 via the Python SDK."""

from __future__ import annotations

from meriknow_mcp.server import create_server, main

__all__ = [
    "__version__",
    "create_server",
    "main",
]

__version__ = "0.1.0"
