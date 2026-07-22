from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.schemas import DocumentResponse, LibraryCreateRequest, LibraryResponse
from app.services.metadata import MetadataStore, get_metadata_store
from app.settings import Settings, get_settings

router = APIRouter(tags=["libraries"])


def get_meta(settings: Settings = Depends(get_settings)) -> MetadataStore:
	return get_metadata_store(settings)


@router.get("/libraries", response_model=list[LibraryResponse])
def list_libraries(meta: MetadataStore = Depends(get_meta)) -> list[LibraryResponse]:
	return [LibraryResponse.model_validate(item) for item in meta.list_libraries()]


@router.post("/libraries", response_model=LibraryResponse)
def create_library(
	body: LibraryCreateRequest,
	meta: MetadataStore = Depends(get_meta),
) -> LibraryResponse:
	try:
		row = meta.create_library(name=body.name, library_id=body.library_id)
	except ValueError as exc:
		raise HTTPException(status_code=400, detail=str(exc)) from exc
	return LibraryResponse.model_validate(row)


@router.get("/libraries/{library_id}", response_model=LibraryResponse)
def get_library(library_id: str, meta: MetadataStore = Depends(get_meta)) -> LibraryResponse:
	row = meta.get_library(library_id)
	if row is None:
		raise HTTPException(status_code=404, detail="library not found")
	return LibraryResponse.model_validate(row)


@router.get("/libraries/{library_id}/documents", response_model=list[DocumentResponse])
def list_documents(
	library_id: str,
	meta: MetadataStore = Depends(get_meta),
) -> list[DocumentResponse]:
	if meta.get_library(library_id) is None:
		raise HTTPException(status_code=404, detail="library not found")
	return [DocumentResponse.model_validate(item) for item in meta.list_documents(library_id)]


@router.get("/documents/{doc_id}", response_model=DocumentResponse)
def get_document(doc_id: str, meta: MetadataStore = Depends(get_meta)) -> DocumentResponse:
	row = meta.get_document(doc_id)
	if row is None:
		raise HTTPException(status_code=404, detail="document not found")
	return DocumentResponse.model_validate(row)
