from __future__ import annotations

from typing import Any

import pytest

from app.security.access_scope import AccessScope
from app.services.ingest import jobs
from app.settings import Settings


class FakeMetadataStore:
	def __init__(self, documents: list[dict[str, Any]] | None = None) -> None:
		self.documents = documents or []

	def list_documents(
		self,
		library_id: str,
		*,
		scope: AccessScope,
	) -> list[dict[str, Any]]:
		assert library_id == "lib-test"
		assert scope == access_scope()
		return self.documents


class FakeRedis:
	default_queue_name = "arq:queue"

	def __init__(self, *, depth: int, job: object | None = None) -> None:
		self.depth = depth
		self.job = job if job is not None else object()
		self.enqueue_calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
		self.close_calls: list[bool] = []

	async def zcard(self, queue_name: str) -> int:
		assert queue_name == self.default_queue_name
		return self.depth

	async def enqueue_job(self, *args: Any, **kwargs: Any) -> object | None:
		self.enqueue_calls.append((args, kwargs))
		return self.job

	async def aclose(self, *, close_connection_pool: bool) -> None:
		self.close_calls.append(close_connection_pool)


def access_scope() -> AccessScope:
	return AccessScope(
		tenant_id="tenant-1",
		workspace_id="workspace-1",
		principal_id="principal-1",
		group_ids=("group-b", "group-a"),
	)


@pytest.mark.asyncio
async def test_enqueue_ingest_job_calls_redis_below_queue_limit(
	monkeypatch: pytest.MonkeyPatch,
) -> None:
	redis = FakeRedis(depth=4)
	settings = Settings(
		ingest_queue_max_depth=5,
		ingest_max_inflight_per_library=2,
	)

	monkeypatch.setattr(
		jobs,
		"get_metadata_store",
		lambda _settings: FakeMetadataStore([{"status": "processing"}]),
	)

	async def fake_redis_pool(_settings: Settings) -> FakeRedis:
		return redis

	monkeypatch.setattr(jobs, "_redis_pool", fake_redis_pool)

	created = await jobs.enqueue_ingest_job(
		doc_id="doc-1",
		library_id="lib-test",
		access_scope=access_scope(),
		settings=settings,
	)

	assert created is redis.job
	assert len(redis.enqueue_calls) == 1
	args, kwargs = redis.enqueue_calls[0]
	assert args == (
		jobs.INGEST_JOB_NAME,
		"doc-1",
		{
			"tenant_id": "tenant-1",
			"workspace_id": "workspace-1",
			"principal_id": "principal-1",
			"group_ids": ["group-b", "group-a"],
		},
	)
	assert kwargs["_job_id"].startswith("ingest:doc-1:")
	assert redis.close_calls == [True]


@pytest.mark.asyncio
async def test_enqueue_ingest_job_rejects_full_queue_and_closes_redis(
	monkeypatch: pytest.MonkeyPatch,
) -> None:
	redis = FakeRedis(depth=5)
	settings = Settings(ingest_queue_max_depth=5)
	monkeypatch.setattr(
		jobs,
		"get_metadata_store",
		lambda _settings: FakeMetadataStore(),
	)

	async def fake_redis_pool(_settings: Settings) -> FakeRedis:
		return redis

	monkeypatch.setattr(jobs, "_redis_pool", fake_redis_pool)

	with pytest.raises(RuntimeError, match="索引队列已满"):
		await jobs.enqueue_ingest_job(
			doc_id="doc-1",
			library_id="lib-test",
			access_scope=access_scope(),
			settings=settings,
		)

	assert redis.enqueue_calls == []
	assert redis.close_calls == [True]


@pytest.mark.asyncio
async def test_enqueue_ingest_job_closes_redis_when_enqueue_fails(
	monkeypatch: pytest.MonkeyPatch,
) -> None:
	redis = FakeRedis(depth=0)
	redis.job = None
	settings = Settings(ingest_queue_max_depth=5)
	monkeypatch.setattr(
		jobs,
		"get_metadata_store",
		lambda _settings: FakeMetadataStore(),
	)

	async def fake_redis_pool(_settings: Settings) -> FakeRedis:
		return redis

	monkeypatch.setattr(jobs, "_redis_pool", fake_redis_pool)

	with pytest.raises(RuntimeError, match="任务未创建"):
		await jobs.enqueue_ingest_job(
			doc_id="doc-1",
			library_id="lib-test",
			access_scope=access_scope(),
			settings=settings,
		)

	assert len(redis.enqueue_calls) == 1
	assert redis.close_calls == [True]
