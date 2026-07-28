#!/usr/bin/env python3
"""Tag legacy Qdrant points with generation_id + ACL from app lifecycle tables.

Preferred full repair is control-plane reindex (new generation + embeddings).
This script only set_payloads metadata so active-generation / ACL gates can
fail-closed without a full re-embed.

Usage:
  cd apps/api
  DATABASE_URL=postgresql://... \\
  QDRANT_URL=http://127.0.0.1:6333 \\
    uv run python scripts/backfill_qdrant_lifecycle_payload.py

  # write payloads
  ... uv run python scripts/backfill_qdrant_lifecycle_payload.py --apply

  # optional filters
  ... --library-id <rag_library_id> --limit 500
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from typing import Any

import psycopg
from qdrant_client import QdrantClient
from qdrant_client.http import models as qm


def _load_active_map(conn: psycopg.Connection, library_id: str | None) -> dict[tuple[str, str], dict[str, Any]]:
	sql = """
		SELECT
			library.rag_library_id,
			document.rag_document_id,
			document.organization_id::text AS organization_id,
			document.workspace_id::text AS workspace_id,
			version.id::text AS document_version_id,
			version.generation_id::text AS generation_id,
			version.pipeline_version,
			COALESCE((
				SELECT array_agg(acl.subject_id::text ORDER BY acl.subject_id)
				FROM app.document_acl AS acl
				WHERE acl.document_id = document.id
				  AND acl.subject_type = 'user'
				  AND acl.permission = 'read'
			), ARRAY[]::text[]) AS allowed_principal_ids,
			COALESCE((
				SELECT array_agg(acl.subject_id::text ORDER BY acl.subject_id)
				FROM app.document_acl AS acl
				WHERE acl.document_id = document.id
				  AND acl.subject_type = 'group'
				  AND acl.permission = 'read'
			), ARRAY[]::text[]) AS allowed_group_ids
		FROM app.document_active_versions AS active
		JOIN app.documents AS document ON document.id = active.document_id
		JOIN app.libraries AS library ON library.id = document.library_id
		JOIN app.document_versions AS version ON version.id = active.version_id
		WHERE document.status NOT IN ('deleted', 'deleting')
	"""
	params: list[Any] = []
	if library_id:
		sql += " AND library.rag_library_id = %s"
		params.append(library_id)
	rows = conn.execute(sql, params).fetchall()
	mapping: dict[tuple[str, str], dict[str, Any]] = {}
	for row in rows:
		mapping[(row[0], row[1])] = {
			"organization_id": row[2],
			"workspace_id": row[3],
			"document_version_id": row[4],
			"generation_id": row[5],
			"pipeline_version": row[6] or "legacy-backfill",
			"allowed_principal_ids": list(row[7] or []),
			"allowed_group_ids": list(row[8] or []),
			"acl_scope": "document" if (row[7] or row[8]) else "workspace",
			"lifecycle_visibility": "active",
		}
	return mapping


def main(argv: list[str] | None = None) -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--apply", action="store_true", help="write set_payload (default dry-run)")
	parser.add_argument("--library-id", default=None, help="filter by rag library id")
	parser.add_argument("--limit", type=int, default=0, help="max points to scan (0=all)")
	parser.add_argument(
		"--collection",
		default=os.environ.get("QDRANT_COLLECTION", "unorag"),
	)
	parser.add_argument(
		"--qdrant-url",
		default=os.environ.get("QDRANT_URL", "http://127.0.0.1:6333"),
	)
	parser.add_argument(
		"--database-url",
		default=os.environ.get("DATABASE_URL") or os.environ.get("JOB_TEST_DATABASE_URL"),
	)
	args = parser.parse_args(argv)
	if not args.database_url:
		print("DATABASE_URL is required", file=sys.stderr)
		return 2

	summary: dict[str, Any] = {
		"mode": "apply" if args.apply else "dry-run",
		"scanned": 0,
		"already_tagged": 0,
		"would_update": 0,
		"updated": 0,
		"missing_active": 0,
		"by_library": defaultdict(int),
	}

	with psycopg.connect(args.database_url) as conn:
		active_map = _load_active_map(conn, args.library_id)

	client = QdrantClient(url=args.qdrant_url, check_compatibility=False)
	offset = None
	scanned = 0
	while True:
		points, offset = client.scroll(
			collection_name=args.collection,
			limit=128,
			offset=offset,
			with_payload=True,
			with_vectors=False,
		)
		if not points:
			break
		for point in points:
			if args.limit and scanned >= args.limit:
				offset = None
				break
			scanned += 1
			payload = point.payload or {}
			library_id = str(payload.get("library_id") or "")
			doc_id = str(payload.get("doc_id") or "")
			if args.library_id and library_id != args.library_id:
				continue
			if payload.get("generation_id") and payload.get("document_version_id"):
				# Still refresh ACL/tenant if missing, else skip.
				if payload.get("tenant_id") and payload.get("workspace_id"):
					summary["already_tagged"] += 1
					continue
			meta = active_map.get((library_id, doc_id))
			if meta is None:
				summary["missing_active"] += 1
				continue
			summary["would_update"] += 1
			summary["by_library"][library_id] += 1
			if not args.apply:
				continue
			client.set_payload(
				collection_name=args.collection,
				payload={
					"document_version_id": meta["document_version_id"],
					"generation_id": meta["generation_id"],
					"lifecycle_visibility": meta["lifecycle_visibility"],
					"pipeline_version": meta["pipeline_version"],
					"tenant_id": meta["organization_id"],
					"workspace_id": meta["workspace_id"],
					"acl_scope": meta["acl_scope"],
					"acl_principal_ids": meta["allowed_principal_ids"],
					"acl_group_ids": meta["allowed_group_ids"],
				},
				points=[point.id],
			)
			summary["updated"] += 1
		if offset is None or (args.limit and scanned >= args.limit):
			break

	summary["scanned"] = scanned
	summary["by_library"] = dict(summary["by_library"])
	print(json.dumps(summary, ensure_ascii=False, indent=2))
	if not args.apply:
		print("dry-run only; re-run with --apply to set_payload", file=sys.stderr)
	if summary["missing_active"] and args.apply:
		print(
			"warning: points without active app version were skipped; "
			"run backfill-lifecycle-versions then control-plane reindex",
			file=sys.stderr,
		)
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
