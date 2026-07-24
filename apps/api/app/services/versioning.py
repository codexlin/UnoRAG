"""Deprecated stub for pre-lifecycle document_version_id derivation.

L6 product ingest must pass real Control Plane UUIDs. This helper remains only
for legacy unit fixtures and migration-era code paths that still opt into
LEGACY_INGEST_WRITES_ENABLED. New call sites must not use it.
"""

from __future__ import annotations

import warnings


def derive_document_version_id(
	doc_id: str,
	*,
	content_hash: str | None = None,
	version: int = 1,
) -> str:
	"""Deprecated: prefer real app.document_versions.id UUIDs."""
	warnings.warn(
		"derive_document_version_id is deprecated; pass real document_version_id",
		DeprecationWarning,
		stacklevel=2,
	)
	resolved = (doc_id or "").strip() or "unknown"
	if content_hash and str(content_hash).strip():
		return f"{resolved}:{str(content_hash).strip()[:12]}"
	return f"{resolved}:v{max(1, int(version))}"
