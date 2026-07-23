"""Document ingest jobs — shared by sync upload fallback and ARQ worker."""

from __future__ import annotations

import logging
from typing import Any

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings
from arq.jobs import Job

from app.services.document_storage import DocumentStorage
from app.services.ingest.pipeline import prepare_ingest
from app.services.metadata import MetadataStore, get_metadata_store
from app.services.retrieval import IngestService
from app.services.runtime import resolve_runtime
from app.settings import Settings, get_settings

logger = logging.getLogger(__name__)

INGEST_JOB_NAME = "ingest_document"


def process_document_ingest(
	doc_id: str,
	*,
	settings: Settings | None = None,
) -> dict[str, Any]:
	"""Parse + embed a stored document. Idempotent if not in processing."""
	settings = settings or get_settings()
	meta = get_metadata_store(settings)
	storage = DocumentStorage(settings)

	doc = meta.get_document(doc_id)
	if doc is None:
		logger.warning("ingest.job.missing doc_id=%s", doc_id)
		return {"ok": False, "doc_id": doc_id, "error": "document not found"}

	status = str(doc.get("status") or "")
	if status != "processing":
		logger.info(
			"ingest.job.skip doc_id=%s status=%s",
			doc_id,
			status,
		)
		return {
			"ok": True,
			"doc_id": doc_id,
			"skipped": True,
			"status": status,
			"chunk_count": int(doc.get("chunk_count") or 0),
			"title": str(doc.get("name") or ""),
			"filename": str(doc.get("filename") or ""),
			"library_id": str(doc.get("library_id") or ""),
			"simulated": False,
			"mode": resolve_runtime(settings).effective_mode,
			"notice": None,
			"parser_report": doc.get("parser_report"),
			"pipeline": None,
		}

	storage_key = doc.get("storage_key")
	if not storage_key:
		meta.update_document(doc_id, status="failed", error="原文未保留，请重新上传")
		return {"ok": False, "doc_id": doc_id, "error": "原文未保留，请重新上传"}

	try:
		content = storage.read(str(storage_key))
	except FileNotFoundError:
		meta.update_document(doc_id, status="failed", error="原文未保留，请重新上传")
		return {"ok": False, "doc_id": doc_id, "error": "原文未保留，请重新上传"}

	library_id = str(doc["library_id"])
	filename = str(doc["filename"])
	display_name = str(doc["name"])
	capability = resolve_runtime(settings)

	try:
		prepared = prepare_ingest(
			settings=settings,
			filename=filename,
			content=content,
			library_id=library_id,
			display_name=display_name,
			content_type=doc.get("content_type"),
			doc_id=doc_id,
		)
	except ValueError as exc:
		meta.update_document(doc_id, status="failed", error=str(exc))
		return {"ok": False, "doc_id": doc_id, "error": str(exc)}

	live = capability.live_ready
	stub_simulate = capability.requested_mode == "stub" and settings.stub_ingest_simulate
	if not live and not stub_simulate:
		meta.update_document(doc_id, status="failed", error="ingest requires live mode")
		return {"ok": False, "doc_id": doc_id, "error": "ingest requires live mode"}

	report = prepared.parser_report.to_public_dict()
	notice = prepared.notice()
	try:
		if live:
			result = IngestService(settings).ingest_ir_chunks(
				library_id=library_id,
				title=prepared.title,
				chunks=prepared.chunks,
				doc_id=doc_id,
				filename=prepared.filename,
				parser_report=report,
			)
			simulated = False
			mode = "live"
		else:
			result = {
				"library_id": library_id,
				"doc_id": doc_id,
				"title": prepared.title,
				"chunk_count": len(prepared.chunks),
				"simulated": True,
			}
			simulated = True
			mode = "stub"
		meta.update_document(
			doc_id,
			status="ready",
			chunk_count=result["chunk_count"],
			error=None,
			parser_report=report,
		)
	except ValueError as exc:
		meta.update_document(doc_id, status="failed", error=str(exc), parser_report=report)
		return {"ok": False, "doc_id": doc_id, "error": str(exc)}
	except Exception as exc:
		logger.exception("ingest.job.failed doc_id=%s", doc_id)
		meta.update_document(doc_id, status="failed", error=str(exc), parser_report=report)
		return {"ok": False, "doc_id": doc_id, "error": str(exc)}

	logger.info(
		"ingest.job.done doc_id=%s library_id=%s chunks=%s mode=%s",
		doc_id,
		library_id,
		result["chunk_count"],
		mode,
	)
	return {
		"ok": True,
		"doc_id": doc_id,
		"library_id": library_id,
		"title": prepared.title,
		"filename": prepared.filename,
		"chunk_count": result["chunk_count"],
		"status": "ready",
		"mode": mode,
		"simulated": simulated,
		"notice": notice,
		"parser_report": report,
		"pipeline": prepared.pipeline,
	}


async def _redis_pool(settings: Settings) -> ArqRedis:
	return await create_pool(RedisSettings.from_dsn(settings.redis_url))


async def queue_depth(redis: ArqRedis) -> int:
	try:
		return int(await redis.zcard(redis.default_queue_name))
	except Exception:
		logger.exception("ingest.queue_depth_failed")
		return 0


async def enqueue_ingest_job(
	*,
	doc_id: str,
	library_id: str,
	settings: Settings | None = None,
) -> Job | None:
	"""Enqueue ARQ job. Raises RuntimeError on Redis/backpressure failures."""
	from uuid import uuid4

	settings = settings or get_settings()
	meta = get_metadata_store(settings)
	inflight = sum(
		1
		for row in meta.list_documents(library_id)
		if str(row.get("status") or "") == "processing"
	)
	# 当前文档已计入 processing；超限时拒绝（允许等于上限）
	if inflight > settings.ingest_max_inflight_per_library:
		raise RuntimeError(
			f"知识库进行中的索引任务过多（{inflight}），请稍后重试"
		)

	redis = await _redis_pool(settings)
	try:
		depth = await queue_depth(redis)
		if depth >= settings.ingest_queue_max_depth:
			raise RuntimeError(
				f"索引队列已满（{depth}），请稍后重试"
			)
		# 每次入队使用唯一 job_id，避免重索引被旧 result 去重吞掉
		job = await redis.enqueue_job(
			INGEST_JOB_NAME,
			doc_id,
			_job_id=f"ingest:{doc_id}:{uuid4().hex}",
		)
		if job is None:
			raise RuntimeError("入队失败：任务未创建")
		logger.info(
			"ingest.enqueued doc_id=%s library_id=%s job=%s depth=%s",
			doc_id,
			library_id,
			getattr(job, "job_id", None),
			depth,
		)
		return job
	finally:
		await redis.aclose(close_connection_pool=True)


async def ingest_document(ctx: dict[str, Any], doc_id: str) -> dict[str, Any]:
	"""ARQ worker entrypoint."""
	_ = ctx
	return process_document_ingest(doc_id)
