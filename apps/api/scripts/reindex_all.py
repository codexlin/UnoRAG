#!/usr/bin/env python3
"""RETIRED: FastAPI /v1/documents/{id}/reindex always returns 410.

Product reindex path:
  1) apps/web scripts/backfill-lifecycle-versions.mjs --apply
  2) apps/api scripts/backfill_qdrant_lifecycle_payload.py --apply
  3) Control-plane POST /api/libraries/{libraryId}/documents/{docId}/reindex

ARQ / LEGACY_INGEST / INGEST_ASYNC paths have been removed.
"""

from __future__ import annotations

import sys


def main() -> int:
	print(
		"reindex_all.py is retired: FastAPI reindex returns 410.\n"
		"Use the Next.js document lifecycle control plane "
		"(POST /api/libraries/{id}/documents/{docId}/reindex).",
		file=sys.stderr,
	)
	return 2


if __name__ == "__main__":
	raise SystemExit(main())
