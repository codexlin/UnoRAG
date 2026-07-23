from __future__ import annotations

import base64
import asyncio
import hashlib
import hmac
import json
import threading
import time
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, HTTPException, Request, status
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.settings import Settings, get_settings

CONTEXT_HEADER = "x-meriknow-context"
SIGNATURE_HEADER = "x-meriknow-signature"


class InternalBodyDigestMiddleware:
	def __init__(self, app: ASGIApp) -> None:
		self.app = app

	async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
		if (
			scope["type"] != "http"
			or not str(scope.get("path") or "").startswith("/v1/")
			or str(scope.get("method") or "").upper() in {"GET", "HEAD"}
		):
			await self.app(scope, receive, send)
			return

		messages: list[Message] = []
		digest = hashlib.sha256()
		while True:
			message = await receive()
			messages.append(message)
			if message["type"] == "http.request":
				digest.update(message.get("body", b""))
				if not message.get("more_body", False):
					break
			elif message["type"] == "http.disconnect":
				break
		scope.setdefault("state", {})["internal_body_sha256"] = digest.hexdigest()
		position = 0

		async def replay() -> Message:
			nonlocal position
			if position < len(messages):
				message = messages[position]
				position += 1
				return message
			if messages and messages[-1]["type"] == "http.disconnect":
				return messages[-1]
			return await receive()

		await self.app(scope, replay, send)


@dataclass(frozen=True)
class RequestContext:
	tenant_id: str
	workspace_id: str
	principal_id: str
	group_ids: tuple[str, ...]
	request_id: str
	jti: str
	auth_source: str
	method: str
	target: str
	body_sha256: str | None
	issued_at: int
	expires_at: int


def _decode_payload(token: str) -> dict[str, Any]:
	try:
		padding = "=" * (-len(token) % 4)
		raw = base64.urlsafe_b64decode(f"{token}{padding}")
		value = json.loads(raw)
	except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
		raise HTTPException(
			status_code=status.HTTP_401_UNAUTHORIZED,
			detail="invalid internal request context",
		) from exc
	if not isinstance(value, dict):
		raise HTTPException(
			status_code=status.HTTP_401_UNAUTHORIZED,
			detail="invalid internal request context",
		)
	return value


def _required_text(payload: dict[str, Any], key: str) -> str:
	value = str(payload.get(key) or "").strip()
	if not value:
		raise HTTPException(
			status_code=status.HTTP_401_UNAUTHORIZED,
			detail=f"internal context missing {key}",
		)
	return value


def verify_internal_context(
	*,
	token: str,
	signature: str,
	secret: str,
	now: int | None = None,
) -> RequestContext:
	expected = hmac.new(secret.encode(), token.encode(), hashlib.sha256).digest()
	try:
		padding = "=" * (-len(signature) % 4)
		provided = base64.urlsafe_b64decode(f"{signature}{padding}")
	except ValueError as exc:
		raise HTTPException(
			status_code=status.HTTP_401_UNAUTHORIZED,
			detail="invalid internal request signature",
		) from exc
	if not hmac.compare_digest(expected, provided):
		raise HTTPException(
			status_code=status.HTTP_401_UNAUTHORIZED,
			detail="invalid internal request signature",
		)

	payload = _decode_payload(token)
	if payload.get("v") != 1 or payload.get("iss") != "meriknow-control-plane":
		raise HTTPException(
			status_code=status.HTTP_401_UNAUTHORIZED,
			detail="unsupported internal request context",
		)
	try:
		issued_at = int(payload.get("iat") or 0)
		expires_at = int(payload.get("exp") or 0)
	except (TypeError, ValueError) as exc:
		raise HTTPException(
			status_code=status.HTTP_401_UNAUTHORIZED,
			detail="invalid internal request context timestamps",
		) from exc
	current = int(time.time()) if now is None else now
	if issued_at > current + 30 or expires_at < current or expires_at - issued_at > 120:
		raise HTTPException(
			status_code=status.HTTP_401_UNAUTHORIZED,
			detail="expired internal request context",
		)
	raw_groups = payload.get("group_ids") or []
	if not isinstance(raw_groups, list):
		raise HTTPException(
			status_code=status.HTTP_401_UNAUTHORIZED,
			detail="invalid internal context group_ids",
		)

	return RequestContext(
		tenant_id=_required_text(payload, "tenant_id"),
		workspace_id=_required_text(payload, "workspace_id"),
		principal_id=_required_text(payload, "principal_id"),
		group_ids=tuple(str(value) for value in raw_groups if str(value).strip()),
		request_id=_required_text(payload, "request_id"),
		jti=_required_text(payload, "jti"),
		auth_source=_required_text(payload, "auth_source"),
		method=_required_text(payload, "method").upper(),
		target=_required_text(payload, "target"),
		body_sha256=(
			str(payload["body_sha256"])
			if payload.get("body_sha256") is not None
			else None
		),
		issued_at=issued_at,
		expires_at=expires_at,
	)


_replay_lock = threading.Lock()
_replay_memory: dict[str, int] = {}
_redis_clients: dict[str, Any] = {}
_redis_clients_lock = asyncio.Lock()


def _reserve_memory_jti(jti: str, expires_at: int, now: int) -> bool:
	with _replay_lock:
		for key, expiry in list(_replay_memory.items()):
			if expiry < now:
				_replay_memory.pop(key, None)
		if jti in _replay_memory:
			return False
		_replay_memory[jti] = expires_at
		return True


async def _redis_client(url: str):
	async with _redis_clients_lock:
		client = _redis_clients.get(url)
		if client is None:
			from redis.asyncio import Redis

			client = Redis.from_url(url, decode_responses=True)
			_redis_clients[url] = client
		return client


async def _reserve_jti(
	context: RequestContext,
	*,
	settings: Settings,
	now: int,
) -> bool:
	backend = settings.internal_auth_replay_backend.strip().lower()
	if backend == "memory":
		return _reserve_memory_jti(context.jti, context.expires_at, now)
	if backend != "redis":
		raise HTTPException(
			status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
			detail="unsupported internal replay backend",
		)
	try:
		client = await _redis_client(settings.redis_url)
		ttl = max(1, context.expires_at - now + 5)
		result = await client.set(
			f"meriknow:internal-jti:{context.jti}",
			"1",
			ex=ttl,
			nx=True,
		)
		return bool(result)
	except Exception as exc:
		raise HTTPException(
			status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
			detail="internal replay protection unavailable",
		) from exc


def _canonical_target(request: Request) -> str:
	raw_path = request.scope.get("raw_path")
	if isinstance(raw_path, bytes):
		path = raw_path.decode("ascii")
	else:
		path = request.url.path
	raw_query = request.scope.get("query_string", b"")
	query = raw_query.decode("ascii") if isinstance(raw_query, bytes) else str(raw_query)
	return f"{path}?{query}" if query else path


async def require_internal_context(
	request: Request,
	settings: Settings = Depends(get_settings),
) -> RequestContext:
	if not settings.internal_auth_enabled:
		context = RequestContext(
			tenant_id=settings.default_tenant_id,
			workspace_id=settings.default_workspace_id,
			principal_id="development",
			group_ids=(),
			request_id=request.headers.get("x-request-id", "development"),
			jti="development",
			auth_source="development",
			method=request.method.upper(),
			target=_canonical_target(request),
			body_sha256=None,
			issued_at=0,
			expires_at=0,
		)
		request.state.request_context = context
		return context

	secret = settings.internal_auth_secret.strip()
	if not secret:
		raise HTTPException(
			status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
			detail="internal authentication is enabled but not configured",
		)
	token = request.headers.get(CONTEXT_HEADER, "")
	signature = request.headers.get(SIGNATURE_HEADER, "")
	if not token or not signature:
		raise HTTPException(
			status_code=status.HTTP_401_UNAUTHORIZED,
			detail="internal request context required",
		)
	context = verify_internal_context(
		token=token,
		signature=signature,
		secret=secret,
	)
	if context.method != request.method.upper() or context.target != _canonical_target(request):
		raise HTTPException(
			status_code=status.HTTP_401_UNAUTHORIZED,
			detail="internal request binding mismatch",
		)
	if context.body_sha256 is not None:
		actual_body_hash = getattr(request.state, "internal_body_sha256", None)
		if actual_body_hash is None:
			try:
				actual_body_hash = hashlib.sha256(await request.body()).hexdigest()
			except RuntimeError as exc:
				raise HTTPException(
					status_code=status.HTTP_401_UNAUTHORIZED,
					detail="internal request body unavailable",
				) from exc
		if not hmac.compare_digest(context.body_sha256, actual_body_hash):
			raise HTTPException(
				status_code=status.HTTP_401_UNAUTHORIZED,
				detail="internal request body mismatch",
			)
	if settings.app_env.strip().lower() in {"prod", "production"}:
		if context.auth_source != "session":
			raise HTTPException(
				status_code=status.HTTP_403_FORBIDDEN,
				detail="production requires authenticated session context",
			)
	now = int(time.time())
	if not await _reserve_jti(context, settings=settings, now=now):
		raise HTTPException(
			status_code=status.HTTP_401_UNAUTHORIZED,
			detail="replayed internal request context",
		)
	request.state.request_context = context
	return context
