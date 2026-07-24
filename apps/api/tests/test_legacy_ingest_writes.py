from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import app
from app.services.ingest import jobs
from app.services.ingest.legacy_writes import (
	LEGACY_INGEST_GONE_DETAIL,
	ensure_legacy_arq_enqueue_allowed,
	reject_legacy_ingest_writes,
)
from app.settings import Settings, get_settings
from tests.conftest import create_library

client = TestClient(app)


def test_reject_legacy_ingest_writes_default_off() -> None:
	settings = Settings(legacy_ingest_writes_enabled=False)
	with pytest.raises(HTTPException) as exc:
		reject_legacy_ingest_writes(settings)
	assert exc.value.status_code == 410
	assert exc.value.detail["code"] == "legacy_ingest_writes_disabled"


def test_arq_enqueue_disabled_without_legacy_flag(
	monkeypatch: pytest.MonkeyPatch,
) -> None:
	settings = Settings(legacy_ingest_writes_enabled=False)
	with pytest.raises(RuntimeError, match="ARQ ingest enqueue disabled"):
		ensure_legacy_arq_enqueue_allowed(settings)

	monkeypatch.setattr(
		jobs,
		"get_metadata_store",
		lambda _settings: object(),
	)

	async def boom(_settings: Settings):
		raise AssertionError("redis must not be opened when ARQ is disabled")

	monkeypatch.setattr(jobs, "_redis_pool", boom)

	with pytest.raises(RuntimeError, match="ARQ ingest enqueue disabled"):
		# asyncio.run via pytest-asyncio style avoided; call ensure directly above.
		ensure_legacy_arq_enqueue_allowed(settings)


@pytest.mark.asyncio
async def test_enqueue_ingest_job_refuses_when_disabled(
	monkeypatch: pytest.MonkeyPatch,
) -> None:
	from app.security.access_scope import AccessScope

	settings = Settings(legacy_ingest_writes_enabled=False)

	async def boom(_settings: Settings):
		raise AssertionError("must not open redis")

	monkeypatch.setattr(jobs, "_redis_pool", boom)

	with pytest.raises(RuntimeError, match="ARQ ingest enqueue disabled"):
		await jobs.enqueue_ingest_job(
			doc_id="doc-1",
			library_id="lib-1",
			access_scope=AccessScope(
				tenant_id="t",
				workspace_id="w",
				principal_id="p",
				group_ids=(),
			),
			settings=settings,
		)


def test_upload_returns_410_when_legacy_disabled(
	monkeypatch: pytest.MonkeyPatch,
) -> None:
	monkeypatch.setenv("LEGACY_INGEST_WRITES_ENABLED", "false")
	get_settings.cache_clear()
	lib_id = create_library(client, library_id="lib-legacy-off")
	response = client.post(
		"/v1/ingest/upload",
		data={"library_id": lib_id},
		files={
			"file": (
				"gone.md",
				"# gone\n".encode("utf-8"),
				"text/markdown",
			)
		},
	)
	assert response.status_code == 410
	body = response.json()
	detail = body.get("detail") or {}
	assert detail.get("code") == "legacy_ingest_writes_disabled"
	assert LEGACY_INGEST_GONE_DETAIL in str(detail.get("message") or detail)
	get_settings.cache_clear()


def test_production_forbids_legacy_ingest_writes() -> None:
	with pytest.raises(ValidationError, match="LEGACY_INGEST_WRITES_ENABLED"):
		Settings(
			app_env="production",
			internal_auth_enabled=True,
			internal_auth_secret="x" * 32,
			internal_auth_replay_backend="redis",
			active_generation_gate_enabled=True,
			legacy_ingest_writes_enabled=True,
		)
