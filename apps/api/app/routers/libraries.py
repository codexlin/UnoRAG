from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.security.access_scope import AccessScope
from app.security.internal_context import RequestContext, require_internal_context
from app.schemas import (
	DocumentResponse,
	LibraryCreateRequest,
	LibraryProjectionRequest,
	LibraryResponse,
	LibraryUpdateRequest,
	UploadResponse,
)
from app.services.document_storage import DocumentStorage
from app.services.ingest.fastapi_ingest_writes import reject_fastapi_ingest_writes
from app.services.metadata import MetadataStore, get_metadata_store
from app.services.retrieval import IngestService
from app.services.runtime import resolve_runtime
from app.settings import Settings, get_settings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["libraries"])


def get_meta(settings: Settings = Depends(get_settings)) -> MetadataStore:
	return get_metadata_store(settings)


def get_document_storage(settings: Settings = Depends(get_settings)) -> DocumentStorage:
	return DocumentStorage(settings)


def get_access_scope(
	context: RequestContext = Depends(require_internal_context),
) -> AccessScope:
	return AccessScope.from_request_context(context)


def get_service_access_scope(
	context: RequestContext = Depends(require_internal_context),
) -> AccessScope:
	if context.auth_source not in {"service", "development"}:
		raise HTTPException(
			status_code=403,
			detail="service request context required",
		)
	return AccessScope.from_request_context(context)


def _document_response(row: dict) -> DocumentResponse:
	return DocumentResponse.model_validate(
		{
			**row,
			"has_file": bool(row.get("storage_key")),
		}
	)


@router.put(
	"/internal/projections/libraries/{library_id}",
	response_model=LibraryResponse,
)
def upsert_library_projection(
	library_id: str,
	body: LibraryProjectionRequest,
	meta: MetadataStore = Depends(get_meta),
	access_scope: AccessScope = Depends(get_service_access_scope),
) -> LibraryResponse:
	"""Idempotent Control Plane -> RAG metadata projection."""
	current = meta.get_library(library_id, scope=access_scope)
	if current is None:
		try:
			row = meta.create_library(
				name=body.name,
				library_id=library_id,
				description=body.description,
				scope=access_scope,
			)
		except ValueError:
			# A concurrent replay may have created the same global RAG id.
			row = meta.get_library(library_id, scope=access_scope)
			if row is None:
				raise HTTPException(status_code=409, detail="library id conflict") from None
	else:
		row = meta.update_library(
			library_id,
			name=body.name,
			description=body.description,
			update_description=True,
			scope=access_scope,
		)
	if row is None:
		raise HTTPException(status_code=409, detail="library projection failed")
	return LibraryResponse.model_validate(row)


def _delete_library_resources(
	library_id: str,
	*,
	settings: Settings,
	meta: MetadataStore,
	storage: DocumentStorage,
	access_scope: AccessScope,
	missing_ok: bool,
) -> dict[str, object]:
	library = meta.get_library(library_id, scope=access_scope)
	if library is None:
		if missing_ok:
			return {
				"ok": True,
				"library_id": library_id,
				"deleted_documents": 0,
				"already_absent": True,
			}
		raise HTTPException(status_code=404, detail="library not found")

	documents = meta.list_documents(library_id, scope=access_scope)
	capability = resolve_runtime(settings)
	if capability.requested_mode == "live" and not capability.live_ready:
		raise HTTPException(
			status_code=503,
			detail="RAG runtime unavailable; library cleanup will be retried",
		)

	chunk_failures: list[str] = []
	storage_failures: list[str] = []
	ingest = (
		IngestService(settings, access_scope=access_scope)
		if capability.live_ready
		else None
	)
	for doc in documents:
		doc_id = str(doc["id"])
		if ingest is not None:
			try:
				ingest.delete_document_chunks(
					doc_id=doc_id,
					library_id=library_id,
				)
			except Exception as exc:
				logger.warning(
					"delete_library_chunks_failed library_id=%s doc_id=%s err=%s",
					library_id,
					doc_id,
					exc,
				)
				chunk_failures.append(doc_id)

		storage_key = doc.get("storage_key")
		if storage_key:
			try:
				storage.delete(str(storage_key))
			except Exception as exc:
				logger.warning(
					"delete_library_storage_failed library_id=%s doc_id=%s err=%s",
					library_id,
					doc_id,
					exc,
				)
				storage_failures.append(doc_id)

	if chunk_failures or storage_failures:
		failures = sorted(set([*chunk_failures, *storage_failures]))
		raise HTTPException(
			status_code=502,
			detail=(
				"library resource cleanup failed; metadata retained for retry: "
				f"{', '.join(failures[:5])}"
				+ ("..." if len(failures) > 5 else "")
			),
		)

	try:
		ok = meta.delete_library(library_id, scope=access_scope)
	except Exception as exc:
		logger.exception("delete_library_metadata_failed library_id=%s", library_id)
		raise HTTPException(
			status_code=500,
			detail=f"library metadata cleanup failed: {exc}",
		) from exc
	if not ok:
		if missing_ok and meta.get_library(library_id, scope=access_scope) is None:
			return {
				"ok": True,
				"library_id": library_id,
				"deleted_documents": len(documents),
				"already_absent": True,
			}
		raise HTTPException(
			status_code=500,
			detail="library metadata cleanup lost a concurrent update",
		)
	return {
		"ok": True,
		"library_id": library_id,
		"deleted_documents": len(documents),
		"already_absent": False,
	}


@router.delete("/internal/projections/libraries/{library_id}")
def delete_library_projection(
	library_id: str,
	settings: Settings = Depends(get_settings),
	meta: MetadataStore = Depends(get_meta),
	storage: DocumentStorage = Depends(get_document_storage),
	access_scope: AccessScope = Depends(get_service_access_scope),
) -> dict[str, object]:
	"""Idempotently remove a derived RAG library projection."""
	return _delete_library_resources(
		library_id,
		settings=settings,
		meta=meta,
		storage=storage,
		access_scope=access_scope,
		missing_ok=True,
	)


@router.get("/libraries", response_model=list[LibraryResponse])
def list_libraries(
	meta: MetadataStore = Depends(get_meta),
	access_scope: AccessScope = Depends(get_access_scope),
) -> list[LibraryResponse]:
	return [
		LibraryResponse.model_validate(item)
		for item in meta.list_libraries(scope=access_scope)
	]


@router.post("/libraries", response_model=LibraryResponse)
def create_library(
	body: LibraryCreateRequest,
	meta: MetadataStore = Depends(get_meta),
	access_scope: AccessScope = Depends(get_access_scope),
) -> LibraryResponse:
	try:
		row = meta.create_library(
			name=body.name,
			library_id=body.library_id,
			description=body.description,
			scope=access_scope,
		)
	except ValueError as exc:
		raise HTTPException(status_code=400, detail=str(exc)) from exc
	return LibraryResponse.model_validate(row)


@router.patch("/libraries/{library_id}", response_model=LibraryResponse)
def update_library(
	library_id: str,
	body: LibraryUpdateRequest,
	meta: MetadataStore = Depends(get_meta),
	access_scope: AccessScope = Depends(get_access_scope),
) -> LibraryResponse:
	if "name" not in body.model_fields_set and "description" not in body.model_fields_set:
		raise HTTPException(status_code=400, detail="至少提供 name 或 description")
	row = meta.update_library(
		library_id,
		name=body.name if "name" in body.model_fields_set else None,
		description=body.description if "description" in body.model_fields_set else None,
		update_description="description" in body.model_fields_set,
		scope=access_scope,
	)
	if row is None:
		raise HTTPException(status_code=404, detail="library not found")
	return LibraryResponse.model_validate(row)


@router.get("/libraries/{library_id}", response_model=LibraryResponse)
def get_library(
	library_id: str,
	meta: MetadataStore = Depends(get_meta),
	access_scope: AccessScope = Depends(get_access_scope),
) -> LibraryResponse:
	row = meta.get_library(library_id, scope=access_scope)
	if row is None:
		raise HTTPException(status_code=404, detail="library not found")
	return LibraryResponse.model_validate(row)


@router.delete("/libraries/{library_id}")
def delete_library(
	library_id: str,
	settings: Settings = Depends(get_settings),
	meta: MetadataStore = Depends(get_meta),
	storage: DocumentStorage = Depends(get_document_storage),
	access_scope: AccessScope = Depends(get_access_scope),
) -> dict[str, object]:
	return _delete_library_resources(
		library_id,
		settings=settings,
		meta=meta,
		storage=storage,
		access_scope=access_scope,
		missing_ok=False,
	)


@router.get("/libraries/{library_id}/documents", response_model=list[DocumentResponse])
def list_documents(
	library_id: str,
	meta: MetadataStore = Depends(get_meta),
	access_scope: AccessScope = Depends(get_access_scope),
) -> list[DocumentResponse]:
	if meta.get_library(library_id, scope=access_scope) is None:
		raise HTTPException(status_code=404, detail="library not found")
	return [
		_document_response(item)
		for item in meta.list_documents(library_id, scope=access_scope)
	]


@router.get("/documents/{doc_id}", response_model=DocumentResponse)
def get_document(
	doc_id: str,
	meta: MetadataStore = Depends(get_meta),
	access_scope: AccessScope = Depends(get_access_scope),
) -> DocumentResponse:
	row = meta.get_document(doc_id, scope=access_scope)
	if row is None:
		raise HTTPException(status_code=404, detail="document not found")
	return _document_response(row)


@router.delete("/documents/{doc_id}")
def delete_document(doc_id: str) -> dict[str, object]:
	"""Deprecated: use Next.js DELETE .../documents/{id} (document.delete job)."""
	_ = doc_id
	reject_fastapi_ingest_writes()


@router.post(
	"/documents/{doc_id}/replace",
	response_model=UploadResponse,
	responses={410: {"description": "FastAPI ingest writes permanently disabled"}},
)
async def replace_document(
	doc_id: str,
	file: UploadFile = File(...),
) -> UploadResponse:
	"""Deprecated: use Next.js POST .../documents/{id}/versions."""
	_ = (doc_id, file)
	reject_fastapi_ingest_writes()


@router.post(
	"/documents/{doc_id}/reindex",
	response_model=UploadResponse,
	responses={410: {"description": "FastAPI ingest writes permanently disabled"}},
)
async def reindex_document(doc_id: str) -> UploadResponse:
	"""Deprecated: use Next.js POST .../documents/{id}/reindex."""
	_ = doc_id
	reject_fastapi_ingest_writes()


@router.get("/documents/{doc_id}/download")
def download_document(
	doc_id: str,
	meta: MetadataStore = Depends(get_meta),
	storage: DocumentStorage = Depends(get_document_storage),
	access_scope: AccessScope = Depends(get_access_scope),
) -> FileResponse:
	doc = meta.get_document(doc_id, scope=access_scope)
	if doc is None:
		raise HTTPException(status_code=404, detail="document not found")

	storage_key = doc.get("storage_key")
	if not storage_key:
		raise HTTPException(status_code=409, detail="原文未保留，请重新上传")

	path = storage.path_for(str(storage_key))
	if not path.is_file():
		raise HTTPException(status_code=409, detail="原文未保留，请重新上传")

	return FileResponse(
		path=path,
		filename=str(doc["filename"]),
		media_type=str(doc.get("content_type") or "application/octet-stream"),
	)
