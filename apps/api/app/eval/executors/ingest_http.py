"""Ingest-http executor — seed sync ingest (FastAPI upload is 410)."""

from __future__ import annotations

import os
from pathlib import Path
from tempfile import TemporaryDirectory

from app.eval.assertions import check_expect
from app.eval.fixtures import resolve_fixture_path
from app.eval.schemas import EvalCase, EvalCaseResult


def run_ingest_http(case: EvalCase) -> EvalCaseResult:
	"""Seed sync ingest (FastAPI upload is 410); keeps ingest_http expect shape."""
	from fastapi.testclient import TestClient

	from app.main import app
	from app.services.metadata import reset_metadata_store
	from app.settings import get_settings
	from tests.support.seed import SeedIngestError, seed_upload_document

	fixture_name = case.fixture or ""
	keys = (
		"ASK_MODE",
		"DASHSCOPE_API_KEY",
		"OPENAI_API_KEY",
		"METADATA_BACKEND",
		"METADATA_PATH",
		"DOCUMENT_STORAGE_DIR",
		"STUB_INGEST_SIMULATE",
	)
	previous = {key: os.environ.get(key) for key in keys}
	with TemporaryDirectory(prefix="meriknow-eval-http-") as tmp_dir:
		os.environ.update(
			{
				"ASK_MODE": "stub",
				"DASHSCOPE_API_KEY": "",
				"OPENAI_API_KEY": "",
				"METADATA_BACKEND": "json",
				"METADATA_PATH": str(Path(tmp_dir) / "metadata.json"),
				"DOCUMENT_STORAGE_DIR": str(Path(tmp_dir) / "documents"),
				"STUB_INGEST_SIMULATE": "true",
			}
		)
		get_settings.cache_clear()
		reset_metadata_store()
		try:
			client = TestClient(app)
			lib_id = case.library_id or f"lib-eval-{case.id}"
			created = client.post(
				"/v1/libraries",
				json={"name": f"eval-{case.id}", "library_id": lib_id},
			)
			if created.status_code != 200:
				return EvalCaseResult(
					id=case.id,
					ok=False,
					kind=case.kind,
					errors=[f"create library failed: {created.status_code} {created.text}"],
					observed={"http_status": created.status_code, "detail": created.text},
				)

			path = resolve_fixture_path(fixture_name)
			content = path.read_bytes()
			filename = path.name
			mime = {
				".md": "text/markdown",
				".txt": "text/plain",
				".pdf": "application/pdf",
				".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				".html": "text/html",
				".htm": "text/html",
				".csv": "text/csv",
			}.get(path.suffix.lower(), "application/octet-stream")

			http_status = 200
			detail = ""
			doc_status = None
			error = None
			doc_id = None
			payload_status = None
			try:
				payload = seed_upload_document(
					library_id=lib_id,
					filename=filename,
					content=content,
					content_type=mime,
				)
				doc_id = payload.get("doc_id")
				doc_status = payload.get("status")
				payload_status = payload.get("status")
			except SeedIngestError as exc:
				http_status = exc.http_status
				detail = exc.message
				doc_id = exc.doc_id
				doc_status = exc.doc_status
				error = exc.message

			docs = client.get(f"/v1/libraries/{lib_id}/documents")
			doc_row = None
			if docs.status_code == 200:
				rows = docs.json()
				if doc_id:
					doc_row = next((row for row in rows if row.get("id") == doc_id), None)
				elif rows:
					doc_row = rows[0]
			if doc_row:
				doc_status = doc_row.get("status") or doc_status
				error = doc_row.get("error") or error

			observed = {
				"http_status": http_status,
				"detail": detail or error or "",
				"doc_status": doc_status,
				"error": error or detail,
				"doc_id": doc_id or (doc_row or {}).get("id"),
				"payload_status": payload_status,
			}
			errors = check_expect(case.expect, observed)
			return EvalCaseResult(
				id=case.id,
				ok=not errors,
				kind=case.kind,
				errors=errors,
				observed=observed,
			)
		finally:
			reset_metadata_store()
			for key, value in previous.items():
				if value is None:
					os.environ.pop(key, None)
				else:
					os.environ[key] = value
			get_settings.cache_clear()
