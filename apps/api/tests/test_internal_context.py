from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import app
from app.security.internal_context import verify_internal_context
from app.settings import Settings, get_settings

NODE_TOKEN = (
	"eyJ2IjoxLCJpc3MiOiJtZXJpa25vdy1jb250cm9sLXBsYW5lIiwidGVuYW50X2lkIjoi"
	"b3JnLTEiLCJ3b3Jrc3BhY2VfaWQiOiJ3cy0xIiwicHJpbmNpcGFsX2lkIjoidXNlci0x"
	"IiwiZ3JvdXBfaWRzIjpbImdyb3VwLTEiXSwicmVxdWVzdF9pZCI6InJlcS0xIiwianRp"
	"IjoianRpLTEiLCJhdXRoX3NvdXJjZSI6InNlc3Npb24iLCJtZXRob2QiOiJQT1NUIiwi"
	"dGFyZ2V0IjoiL3YxL2Fzaz9tb2RlPWh5YnJpZCIsImJvZHlfc2hhMjU2IjoiZjUyZmZm"
	"NzVlNTRhODIyZmU4MGFlMDkwMGFkZDEzNDk2NTE2Zjg5OTJhMmMyOGFkZjIzMGIxZmE5"
	"MmQ2YzFkZCIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwMDYwfQ"
)
NODE_SIGNATURE = "agSGvYulQybCN_0IBnaSDnWckoXlelqqOHOpKsYYYro"
TEST_SECRET = "test-secret-32-characters-minimum!"


def _signed_headers(
	*,
	method: str,
	target: str,
	jti: str | None = None,
	body: bytes | None = None,
	tenant_id: str = "org-1",
	workspace_id: str = "ws-1",
	principal_id: str = "user-1",
	auth_source: str = "session",
) -> dict[str, str]:
	now = int(time.time())
	request_id = jti or str(uuid4())
	payload = {
		"v": 1,
		"iss": "meriknow-control-plane",
		"tenant_id": tenant_id,
		"workspace_id": workspace_id,
		"principal_id": principal_id,
		"group_ids": ["group-1"],
		"request_id": request_id,
		"jti": request_id,
		"auth_source": auth_source,
		"method": method,
		"target": target,
		"body_sha256": hashlib.sha256(body).hexdigest() if body is not None else None,
		"iat": now,
		"exp": now + 60,
	}
	token = base64.urlsafe_b64encode(
		json.dumps(payload, separators=(",", ":")).encode()
	).decode().rstrip("=")
	signature = base64.urlsafe_b64encode(
		hmac.new(TEST_SECRET.encode(), token.encode(), hashlib.sha256).digest()
	).decode().rstrip("=")
	return {
		"x-meriknow-context": token,
		"x-meriknow-signature": signature,
	}


def test_node_hmac_vector_is_accepted_by_python() -> None:
	context = verify_internal_context(
		token=NODE_TOKEN,
		signature=NODE_SIGNATURE,
		secret=TEST_SECRET,
		now=1_700_000_030,
	)

	assert context.tenant_id == "org-1"
	assert context.workspace_id == "ws-1"
	assert context.principal_id == "user-1"
	assert context.group_ids == ("group-1",)
	assert context.request_id == "req-1"
	assert context.method == "POST"
	assert context.target == "/v1/ask?mode=hybrid"
	assert context.body_sha256 == (
		"f52fff75e54a822fe80ae0900add13496516f8992a2c28adf230b1fa92d6c1dd"
	)


def test_invalid_internal_signature_is_rejected() -> None:
	try:
		verify_internal_context(
			token=NODE_TOKEN,
			signature="invalid",
			secret=TEST_SECRET,
			now=1_700_000_030,
		)
	except HTTPException as exc:
		assert exc.status_code == 401
	else:
		raise AssertionError("invalid signature was accepted")


def test_invalid_internal_timestamps_are_rejected() -> None:
	payload = json.loads(
		base64.urlsafe_b64decode(f"{NODE_TOKEN}{'=' * (-len(NODE_TOKEN) % 4)}")
	)
	payload["iat"] = "not-a-timestamp"
	token = base64.urlsafe_b64encode(
		json.dumps(payload, separators=(",", ":")).encode()
	).decode().rstrip("=")
	signature = base64.urlsafe_b64encode(
		hmac.new(TEST_SECRET.encode(), token.encode(), hashlib.sha256).digest()
	).decode().rstrip("=")

	with pytest.raises(HTTPException) as exc_info:
		verify_internal_context(
			token=token,
			signature=signature,
			secret=TEST_SECRET,
			now=1_700_000_030,
		)

	assert exc_info.value.status_code == 401
	assert exc_info.value.detail == "invalid internal request context timestamps"


def test_v1_requires_context_when_internal_auth_enabled(monkeypatch) -> None:
	monkeypatch.setenv("INTERNAL_AUTH_ENABLED", "true")
	monkeypatch.setenv("INTERNAL_AUTH_SECRET", TEST_SECRET)
	monkeypatch.setenv("INTERNAL_AUTH_REPLAY_BACKEND", "memory")
	get_settings.cache_clear()
	client = TestClient(app)

	response = client.get("/v1/libraries")

	assert response.status_code == 401
	assert response.json()["detail"] == "internal request context required"


def test_internal_context_is_bound_to_target_and_one_time_use(monkeypatch) -> None:
	monkeypatch.setenv("INTERNAL_AUTH_ENABLED", "true")
	monkeypatch.setenv("INTERNAL_AUTH_SECRET", TEST_SECRET)
	monkeypatch.setenv("INTERNAL_AUTH_REPLAY_BACKEND", "memory")
	get_settings.cache_clear()
	client = TestClient(app)
	headers = _signed_headers(method="GET", target="/v1/libraries")

	first = client.get("/v1/libraries", headers=headers)
	replay = client.get("/v1/libraries", headers=headers)
	wrong_target = client.get(
		"/v1/libraries",
		headers=_signed_headers(method="GET", target="/v1/archive"),
	)

	assert first.status_code == 200
	assert replay.status_code == 401
	assert replay.json()["detail"] == "replayed internal request context"
	assert wrong_target.status_code == 401
	assert wrong_target.json()["detail"] == "internal request binding mismatch"


def test_internal_context_body_digest_is_enforced(monkeypatch) -> None:
	monkeypatch.setenv("INTERNAL_AUTH_ENABLED", "true")
	monkeypatch.setenv("INTERNAL_AUTH_SECRET", TEST_SECRET)
	monkeypatch.setenv("INTERNAL_AUTH_REPLAY_BACKEND", "memory")
	get_settings.cache_clear()
	client = TestClient(app)
	signed_body = b'{"name":"signed"}'

	response = client.post(
		"/v1/libraries",
		content=b'{"name":"tampered"}',
		headers={
			**_signed_headers(
				method="POST",
				target="/v1/libraries",
				body=signed_body,
			),
			"content-type": "application/json",
		},
	)

	assert response.status_code == 401
	assert response.json()["detail"] == "internal request body mismatch"


def test_metadata_routes_do_not_leak_across_workspaces(monkeypatch) -> None:
	monkeypatch.setenv("INTERNAL_AUTH_ENABLED", "true")
	monkeypatch.setenv("INTERNAL_AUTH_SECRET", TEST_SECRET)
	monkeypatch.setenv("INTERNAL_AUTH_REPLAY_BACKEND", "memory")
	get_settings.cache_clear()
	client = TestClient(app)
	body = b'{"name":"Workspace A","library_id":"scoped-library"}'

	created = client.post(
		"/v1/libraries",
		content=body,
		headers={
			**_signed_headers(
				method="POST",
				target="/v1/libraries",
				body=body,
				workspace_id="workspace-a",
			),
			"content-type": "application/json",
		},
	)
	visible = client.get(
		"/v1/libraries/scoped-library",
		headers=_signed_headers(
			method="GET",
			target="/v1/libraries/scoped-library",
			workspace_id="workspace-a",
		),
	)
	foreign_list = client.get(
		"/v1/libraries",
		headers=_signed_headers(
			method="GET",
			target="/v1/libraries",
			workspace_id="workspace-b",
		),
	)
	foreign_detail = client.get(
		"/v1/libraries/scoped-library",
		headers=_signed_headers(
			method="GET",
			target="/v1/libraries/scoped-library",
			workspace_id="workspace-b",
		),
	)

	assert created.status_code == 200
	assert visible.status_code == 200
	assert foreign_list.status_code == 200
	assert foreign_list.json() == []
	assert foreign_detail.status_code == 404


def test_production_settings_fail_closed() -> None:
	with pytest.raises(ValidationError, match="INTERNAL_AUTH_ENABLED"):
		Settings(app_env="production", internal_auth_enabled=False)

	with pytest.raises(ValidationError, match="32"):
		Settings(
			app_env="production",
			internal_auth_enabled=True,
			internal_auth_secret="short",
		)

	with pytest.raises(ValidationError, match="REPLAY_BACKEND"):
		Settings(
			app_env="production",
			internal_auth_enabled=True,
			internal_auth_secret=TEST_SECRET,
			internal_auth_replay_backend="memory",
		)

	with pytest.raises(ValidationError, match="ACTIVE_GENERATION_GATE_ENABLED"):
		Settings(
			app_env="production",
			internal_auth_enabled=True,
			internal_auth_secret=TEST_SECRET,
			internal_auth_replay_backend="redis",
			active_generation_gate_enabled=False,
		)

	with pytest.raises(ValidationError, match="ACTIVE_GENERATION_CACHE_TTL_SECONDS"):
		Settings(
			app_env="production",
			internal_auth_enabled=True,
			internal_auth_secret=TEST_SECRET,
			internal_auth_replay_backend="redis",
			active_generation_gate_enabled=True,
			active_generation_cache_ttl_seconds=1,
		)

	with pytest.raises(ValidationError, match="MINERU_URL"):
		Settings(
			app_env="production",
			internal_auth_enabled=True,
			internal_auth_secret=TEST_SECRET,
			internal_auth_replay_backend="redis",
			active_generation_gate_enabled=True,
			mineru_enabled=True,
			mineru_url="",
		)


def test_production_accepts_signed_service_context(monkeypatch) -> None:
	monkeypatch.setenv("APP_ENV", "production")
	monkeypatch.setenv("INTERNAL_AUTH_ENABLED", "true")
	monkeypatch.setenv("INTERNAL_AUTH_SECRET", TEST_SECRET)
	monkeypatch.setenv("INTERNAL_AUTH_REPLAY_BACKEND", "redis")
	monkeypatch.setenv("ACTIVE_GENERATION_GATE_ENABLED", "true")
	get_settings.cache_clear()
	settings = Settings()

	async def reserve_jti(*args, **kwargs) -> bool:
		return True

	monkeypatch.setattr(
		"app.security.internal_context._reserve_jti",
		reserve_jti,
	)
	app.dependency_overrides[get_settings] = lambda: settings
	try:
		client = TestClient(app)
		response = client.get(
			"/v1/libraries",
			headers=_signed_headers(
				method="GET",
				target="/v1/libraries",
				auth_source="service",
			),
		)
	finally:
		app.dependency_overrides.pop(get_settings, None)
		get_settings.cache_clear()

	assert response.status_code == 200
