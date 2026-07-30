"""Narrow writer for the legacy public document metadata projection."""

from __future__ import annotations

import psycopg

from app.security.access_scope import AccessScope


class DocumentMetadataProjectionCleaner:
	"""Delete one projected document without granting the worker full API access."""

	def __init__(self, database_dsn: str) -> None:
		if not database_dsn.strip():
			raise ValueError("worker database DSN is required")
		self._database_dsn = database_dsn

	def delete_document(self, doc_id: str, *, scope: AccessScope) -> bool:
		with psycopg.connect(self._database_dsn) as connection:
			with connection.cursor() as cursor:
				cursor.execute(
					"""
					SELECT library_id
					FROM public.documents
					WHERE id = %s
					  AND tenant_id = %s
					  AND workspace_id = %s
					""",
					(doc_id, scope.tenant_id, scope.workspace_id),
				)
				projected = cursor.fetchone()
				if projected is None:
					return False
				library_id = str(projected[0])
				cursor.execute(
					"""
					SELECT pg_advisory_xact_lock(
						hashtextextended(%s::text, 0)
					)
					""",
					(library_id,),
				)
				cursor.execute(
					"""
					DELETE FROM public.documents
					WHERE id = %s
					  AND tenant_id = %s
					  AND workspace_id = %s
					RETURNING library_id
					""",
					(doc_id, scope.tenant_id, scope.workspace_id),
				)
				deleted = cursor.fetchone()
				if deleted is None:
					return False

				cursor.execute(
					"""
					WITH document_stats AS (
						SELECT
							count(*)::integer AS doc_count,
							count(*) FILTER (WHERE status = 'ready')::integer AS ready_count,
							bool_or(status = 'processing') AS has_processing
						FROM public.documents
						WHERE library_id = %s
						  AND tenant_id = %s
						  AND workspace_id = %s
					)
					UPDATE public.libraries AS library
					SET
						doc_count = stats.doc_count,
						ready_count = stats.ready_count,
						status = CASE
							WHEN stats.doc_count = 0 THEN 'empty'
							WHEN coalesce(stats.has_processing, false)
								OR stats.ready_count < stats.doc_count THEN 'indexing'
							ELSE 'ready'
						END,
						updated_at = now()
					FROM document_stats AS stats
					WHERE library.id = %s
					  AND library.tenant_id = %s
					  AND library.workspace_id = %s
					""",
					(
						library_id,
						scope.tenant_id,
						scope.workspace_id,
						library_id,
						scope.tenant_id,
						scope.workspace_id,
					),
				)
			connection.commit()
		return True
