from __future__ import annotations

import pytest

from app.security.access_scope import AccessScope
from app.security.internal_context import require_internal_context
from app.settings import Settings


BOOTSTRAP_TENANT = "00000000-0000-4000-8000-000000000001"
BOOTSTRAP_WORKSPACE = "00000000-0000-4000-8000-000000000002"


def test_default_tenant_workspace_match_control_plane_bootstrap() -> None:
	settings = Settings(
		# Avoid picking up a local apps/api/.env that may still say "default".
		_env_file=None,
	)
	assert settings.default_tenant_id == BOOTSTRAP_TENANT
	assert settings.default_workspace_id == BOOTSTRAP_WORKSPACE
	assert settings.default_tenant_id != "default"
	assert settings.default_workspace_id != "default"


def test_development_access_scope_uses_bootstrap_defaults() -> None:
	settings = Settings(_env_file=None)
	scope = AccessScope.development(settings)
	assert scope.tenant_id == BOOTSTRAP_TENANT
	assert scope.workspace_id == BOOTSTRAP_WORKSPACE
	assert scope.principal_id == "development"


@pytest.mark.asyncio
async def test_disabled_internal_auth_falls_back_to_bootstrap_defaults() -> None:
	settings = Settings(_env_file=None, internal_auth_enabled=False)

	class _Request:
		method = "POST"
		headers = {"x-request-id": "req-test"}
		url = type("URL", (), {"path": "/v1/ask"})()
		scope = {"raw_path": b"/v1/ask", "query_string": b""}
		state = type("State", (), {})()

	context = await require_internal_context(_Request(), settings=settings)
	assert context.tenant_id == BOOTSTRAP_TENANT
	assert context.workspace_id == BOOTSTRAP_WORKSPACE
	assert context.auth_source == "development"
