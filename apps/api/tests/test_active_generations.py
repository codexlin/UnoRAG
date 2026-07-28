from __future__ import annotations

from app.security.access_scope import AccessScope
from app.services.active_generations import ActiveGenerationResolver
from app.settings import Settings


class FakeResult:
	def fetchall(self) -> list[tuple[str]]:
		return [("generation-b",), ("generation-a",)]


class FakeConnection:
	def __init__(self) -> None:
		self.calls: list[tuple[str, tuple[str, str, str]]] = []

	def __enter__(self) -> "FakeConnection":
		return self

	def __exit__(self, *_args: object) -> None:
		pass

	def execute(
		self,
		query: str,
		params: tuple[str, str, str],
	) -> FakeResult:
		self.calls.append((query, params))
		return FakeResult()


def test_active_generation_resolver_scopes_and_caches_snapshot(monkeypatch) -> None:
	connection = FakeConnection()
	connect_calls: list[str] = []

	def connect(dsn: str, *, autocommit: bool) -> FakeConnection:
		assert autocommit is True
		connect_calls.append(dsn)
		return connection

	monkeypatch.setattr(
		"app.services.active_generations.psycopg.connect",
		connect,
	)
	resolver = ActiveGenerationResolver(
		Settings(
			database_url="postgresql+psycopg://db/unorag",
			active_generation_cache_ttl_seconds=60,
		)
	)
	scope = AccessScope("tenant-a", "workspace-a", "alice")

	first = resolver.resolve(scope=scope, library_id="library-a")
	second = resolver.resolve(scope=scope, library_id="library-a")

	assert first is second
	assert first.generation_ids == ("generation-b", "generation-a")
	assert first.cache_key == "generation-b,generation-a"
	assert connect_calls == ["postgresql://db/unorag"]
	assert connection.calls[0][1] == ("tenant-a", "workspace-a", "library-a")

	resolver.invalidate(
		organization_id="tenant-a",
		workspace_id="workspace-a",
		library_id="library-a",
	)
	resolver.resolve(scope=scope, library_id="library-a")
	assert len(connect_calls) == 2
