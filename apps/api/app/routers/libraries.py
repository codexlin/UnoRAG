from __future__ import annotations

import logging
from pathlib import PurePosixPath

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from app.security.access_scope import AccessScope
from app.security.internal_context import RequestContext, require_internal_context
from app.schemas import (
	DocumentResponse,
	LibraryCreateRequest,
	LibraryResponse,
	LibraryUpdateRequest,
	UploadResponse,
)
from app.services.document_storage import DocumentStorage
from app.services.documents import clean_display_title
from app.services.ingest.jobs import enqueue_ingest_job, process_document_ingest
from app.services.ingest.router import V2_EXTENSIONS
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


def _document_response(row: dict) -> DocumentResponse:
	return DocumentResponse.model_validate(
		{
			**row,
			"has_file": bool(row.get("storage_key")),
		}
	)


def _unavailable_detail(capability, *, message: str) -> dict:
	return {
		"message": message,
		"requested_mode": capability.requested_mode,
		"effective_mode": capability.effective_mode,
		"degraded": capability.degraded,
		"live_ready": capability.live_ready,
		"ask_ready": capability.ask_ready,
		"reasons": capability.reasons,
	}


@router.get("/libraries", response_model=list[LibraryResponse])
def list_libraries(meta: MetadataStore = Depends(get_meta)) -> list[LibraryResponse]:
	return [LibraryResponse.model_validate(item) for item in meta.list_libraries()]


@router.post("/libraries", response_model=LibraryResponse)
def create_library(
	body: LibraryCreateRequest,
	meta: MetadataStore = Depends(get_meta),
) -> LibraryResponse:
	try:
		row = meta.create_library(
			name=body.name,
			library_id=body.library_id,
			description=body.description,
		)
	except ValueError as exc:
		raise HTTPException(status_code=400, detail=str(exc)) from exc
	return LibraryResponse.model_validate(row)


@router.patch("/libraries/{library_id}", response_model=LibraryResponse)
def update_library(
	library_id: str,
	body: LibraryUpdateRequest,
	meta: MetadataStore = Depends(get_meta),
) -> LibraryResponse:
	if "name" not in body.model_fields_set and "description" not in body.model_fields_set:
		raise HTTPException(status_code=400, detail="至少提供 name 或 description")
	row = meta.update_library(
		library_id,
		name=body.name if "name" in body.model_fields_set else None,
		description=body.description if "description" in body.model_fields_set else None,
		update_description="description" in body.model_fields_set,
	)
	if row is None:
		raise HTTPException(status_code=404, detail="library not found")
	return LibraryResponse.model_validate(row)


@router.get("/libraries/{library_id}", response_model=LibraryResponse)
def get_library(library_id: str, meta: MetadataStore = Depends(get_meta)) -> LibraryResponse:
	row = meta.get_library(library_id)
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
	library = meta.get_library(library_id)
	if library is None:
		raise HTTPException(status_code=404, detail="library not found")

	documents = meta.list_documents(library_id)
	capability = resolve_runtime(settings)
	chunk_failures: list[str] = []
	storage_failures: list[str] = []

	for doc in documents:
		doc_id = str(doc["id"])
		if capability.live_ready:
			try:
				IngestService(settings, access_scope=access_scope).delete_document_chunks(
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

	# live 模式下向量清除硬失败：不继续删元数据，避免「库没了但向量还在」
	if capability.live_ready and chunk_failures:
		raise HTTPException(
			status_code=502,
			detail=(
				"删除知识库向量失败，已中止元数据删除："
				f"{', '.join(chunk_failures[:5])}"
				+ ("…" if len(chunk_failures) > 5 else "")
			),
		)

	try:
		ok = meta.delete_library(library_id)
	except Exception as exc:
		logger.exception("delete_library_metadata_failed library_id=%s", library_id)
		raise HTTPException(
			status_code=500,
			detail=f"删除知识库元数据失败: {exc}",
		) from exc

	if not ok:
		raise HTTPException(status_code=500, detail="删除知识库失败：库已不存在或写入失败")

	return {
		"ok": True,
		"library_id": library_id,
		"deleted_documents": len(documents),
		"storage_warnings": storage_failures,
	}


@router.get("/libraries/{library_id}/documents", response_model=list[DocumentResponse])
def list_documents(
	library_id: str,
	meta: MetadataStore = Depends(get_meta),
) -> list[DocumentResponse]:
	if meta.get_library(library_id) is None:
		raise HTTPException(status_code=404, detail="library not found")
	return [_document_response(item) for item in meta.list_documents(library_id)]


@router.get("/documents/{doc_id}", response_model=DocumentResponse)
def get_document(doc_id: str, meta: MetadataStore = Depends(get_meta)) -> DocumentResponse:
	row = meta.get_document(doc_id)
	if row is None:
		raise HTTPException(status_code=404, detail="document not found")
	return _document_response(row)


@router.delete("/documents/{doc_id}")
def delete_document(
	doc_id: str,
	settings: Settings = Depends(get_settings),
	meta: MetadataStore = Depends(get_meta),
	storage: DocumentStorage = Depends(get_document_storage),
	access_scope: AccessScope = Depends(get_access_scope),
) -> dict[str, object]:
	doc = meta.get_document(doc_id)
	if doc is None:
		raise HTTPException(status_code=404, detail="document not found")

	capability = resolve_runtime(settings)
	if capability.live_ready:
		try:
			IngestService(settings, access_scope=access_scope).delete_document_chunks(
				doc_id=doc_id,
				library_id=str(doc["library_id"]),
			)
		except Exception as exc:
			logger.warning("delete_document_chunks_failed doc_id=%s err=%s", doc_id, exc)

	storage_key = doc.get("storage_key")
	if storage_key:
		try:
			storage.delete(str(storage_key))
		except Exception as exc:
			logger.warning("delete_document_storage_failed doc_id=%s err=%s", doc_id, exc)

	meta.delete_document(doc_id)
	return {"ok": True, "doc_id": doc_id}


@router.post(
	"/documents/{doc_id}/replace",
	response_model=UploadResponse,
	responses={202: {"model": UploadResponse}},
)
async def replace_document(
	doc_id: str,
	file: UploadFile = File(...),
	settings: Settings = Depends(get_settings),
	meta: MetadataStore = Depends(get_meta),
	storage: DocumentStorage = Depends(get_document_storage),
	access_scope: AccessScope = Depends(get_access_scope),
) -> UploadResponse | JSONResponse:
	"""用新文件覆盖同一文档：清旧向量与原文，保留 doc_id，再入队索引。"""
	doc = meta.get_document(doc_id)
	if doc is None:
		raise HTTPException(status_code=404, detail="document not found")

	if str(doc.get("status") or "") == "processing":
		raise HTTPException(status_code=409, detail="文档正在索引中，请稍后再替换")

	content = await file.read()
	if not content:
		raise HTTPException(status_code=400, detail="Empty file")
	if len(content) > settings.max_upload_bytes:
		raise HTTPException(
			status_code=413,
			detail=f"文件过大，上限 {settings.max_upload_bytes} 字节",
		)

	filename = (file.filename or "untitled.txt").strip() or "untitled.txt"
	suffix = PurePosixPath(filename).suffix.lower()
	if suffix not in V2_EXTENSIONS:
		raise HTTPException(
			status_code=400,
			detail=f"unsupported file type: {suffix or '(none)'}; use txt/md/pdf/docx/csv/xlsx",
		)

	library_id = str(doc["library_id"])
	capability = resolve_runtime(settings)
	live = capability.live_ready
	stub_simulate = capability.requested_mode == "stub" and settings.stub_ingest_simulate
	if not live and not stub_simulate:
		raise HTTPException(
			status_code=503,
			detail=_unavailable_detail(
				capability,
				message="ingest requires live mode with LLM key and reachable Qdrant",
			),
		)

	# 库内其它同名文档一并清掉，保持「同库同名唯一」
	for other in meta.list_documents(library_id):
		if str(other["id"]) == doc_id:
			continue
		if str(other.get("filename") or "") != filename:
			continue
		other_id = str(other["id"])
		try:
			if live:
				IngestService(settings, access_scope=access_scope).delete_document_chunks(
					doc_id=other_id,
					library_id=library_id,
				)
		except Exception as exc:
			logger.warning("replace.peer_delete_vectors_failed doc_id=%s err=%s", other_id, exc)
		peer_key = other.get("storage_key")
		if peer_key:
			try:
				storage.delete(str(peer_key))
			except Exception as exc:
				logger.warning("replace.peer_delete_storage_failed doc_id=%s err=%s", other_id, exc)
		meta.delete_document(other_id)

	# 清当前文档向量（live 失败则中止，避免孤儿点）
	if live:
		try:
			IngestService(settings, access_scope=access_scope).delete_document_chunks(
				doc_id=doc_id,
				library_id=library_id,
			)
		except Exception as exc:
			logger.exception("replace.delete_vectors_failed doc_id=%s", doc_id)
			raise HTTPException(
				status_code=502,
				detail=f"清除旧向量失败，已中止替换: {exc}",
			) from exc

	old_key = doc.get("storage_key")
	if old_key:
		try:
			storage.delete(str(old_key))
		except Exception as exc:
			logger.warning("replace.delete_storage_failed doc_id=%s err=%s", doc_id, exc)

	title = clean_display_title(PurePosixPath(filename).stem, filename=filename)
	content_type = file.content_type or {
		".txt": "text/plain",
		".md": "text/markdown",
		".markdown": "text/markdown",
		".pdf": "application/pdf",
		".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".csv": "text/csv",
		".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	}.get(suffix, "application/octet-stream")

	storage_key = storage.save(library_id, doc_id, filename, content)
	meta.update_document(
		doc_id,
		name=title,
		filename=filename,
		content_type=content_type,
		storage_key=storage_key,
		size_bytes=len(content),
		status="processing",
		chunk_count=0,
		parser_report={},
		clear_error=True,
	)

	mode = "live" if live else "stub"
	if settings.ingest_async:
		try:
			await enqueue_ingest_job(
				doc_id=doc_id,
				library_id=library_id,
				access_scope=access_scope,
				settings=settings,
			)
		except RuntimeError as exc:
			meta.update_document(doc_id, status="failed", error=str(exc))
			raise HTTPException(status_code=429, detail=str(exc)) from exc
		except Exception as exc:
			logger.exception("replace.enqueue_failed doc_id=%s", doc_id)
			meta.update_document(doc_id, status="failed", error=f"入队失败: {exc}")
			raise HTTPException(status_code=503, detail=f"索引队列不可用: {exc}") from exc
		payload = UploadResponse(
			library_id=library_id,
			doc_id=doc_id,
			title=title,
			filename=filename,
			chunk_count=0,
			status="processing",
			mode=mode,
			simulated=False,
			accepted=True,
		)
		return JSONResponse(status_code=202, content=payload.model_dump())

	result = process_document_ingest(
		doc_id,
		settings=settings,
		access_scope=access_scope,
	)
	if not result.get("ok"):
		raise HTTPException(
			status_code=400,
			detail=str(result.get("error") or "replace ingest failed"),
		)
	return UploadResponse(
		library_id=library_id,
		doc_id=doc_id,
		title=str(result.get("title") or title),
		filename=str(result.get("filename") or filename),
		chunk_count=int(result.get("chunk_count") or 0),
		status="ready",
		mode=str(result.get("mode") or mode),
		simulated=bool(result.get("simulated")),
		accepted=False,
		notice=result.get("notice"),
		parser_report=result.get("parser_report"),
		pipeline=result.get("pipeline"),
	)


@router.post(
	"/documents/{doc_id}/reindex",
	response_model=UploadResponse,
	responses={202: {"model": UploadResponse}},
)
async def reindex_document(
	doc_id: str,
	settings: Settings = Depends(get_settings),
	meta: MetadataStore = Depends(get_meta),
	storage: DocumentStorage = Depends(get_document_storage),
	access_scope: AccessScope = Depends(get_access_scope),
) -> UploadResponse | JSONResponse:
	doc = meta.get_document(doc_id)
	if doc is None:
		raise HTTPException(status_code=404, detail="document not found")

	storage_key = doc.get("storage_key")
	if not storage_key:
		raise HTTPException(status_code=409, detail="原文未保留，请重新上传")

	try:
		storage.read(str(storage_key))
	except FileNotFoundError:
		raise HTTPException(status_code=409, detail="原文未保留，请重新上传") from None

	library_id = str(doc["library_id"])
	filename = str(doc["filename"])
	title = str(doc["name"])
	capability = resolve_runtime(settings)

	live = capability.live_ready
	stub_simulate = capability.requested_mode == "stub" and settings.stub_ingest_simulate
	if not live and not stub_simulate:
		raise HTTPException(
			status_code=503,
			detail=_unavailable_detail(
				capability,
				message="ingest requires live mode with LLM key and reachable Qdrant",
			),
		)

	if str(doc.get("status") or "") == "processing":
		raise HTTPException(status_code=409, detail="文档正在索引中")

	meta.update_document(doc_id, status="processing", error=None)
	mode = "live" if live else "stub"

	if settings.ingest_async:
		try:
			await enqueue_ingest_job(
				doc_id=doc_id,
				library_id=library_id,
				access_scope=access_scope,
				settings=settings,
			)
		except RuntimeError as exc:
			meta.update_document(doc_id, status="failed", error=str(exc))
			raise HTTPException(status_code=429, detail=str(exc)) from exc
		except Exception as exc:
			logger.exception("reindex.enqueue_failed doc_id=%s", doc_id)
			meta.update_document(doc_id, status="failed", error=f"入队失败: {exc}")
			raise HTTPException(
				status_code=503,
				detail=f"索引队列不可用: {exc}",
			) from exc
		payload = UploadResponse(
			library_id=library_id,
			doc_id=doc_id,
			title=title,
			filename=filename,
			chunk_count=int(doc.get("chunk_count") or 0),
			status="processing",
			mode=mode,
			simulated=False,
			accepted=True,
		)
		return JSONResponse(status_code=202, content=payload.model_dump())

	result = process_document_ingest(
		doc_id,
		settings=settings,
		access_scope=access_scope,
	)
	if not result.get("ok"):
		raise HTTPException(
			status_code=400,
			detail=str(result.get("error") or "reindex failed"),
		)
	return UploadResponse(
		library_id=library_id,
		doc_id=doc_id,
		title=str(result.get("title") or title),
		filename=str(result.get("filename") or filename),
		chunk_count=int(result.get("chunk_count") or 0),
		status="ready",
		mode=str(result.get("mode") or mode),
		simulated=bool(result.get("simulated")),
		accepted=False,
		notice=result.get("notice"),
		parser_report=result.get("parser_report"),
		pipeline=result.get("pipeline"),
	)


@router.get("/documents/{doc_id}/download")
def download_document(
	doc_id: str,
	meta: MetadataStore = Depends(get_meta),
	storage: DocumentStorage = Depends(get_document_storage),
) -> FileResponse:
	doc = meta.get_document(doc_id)
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
