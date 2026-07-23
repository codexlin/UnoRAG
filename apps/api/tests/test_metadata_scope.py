from __future__ import annotations

from pathlib import Path

import pytest

from app.security.access_scope import AccessScope
from app.services.ingest import jobs
from app.services.metadata import (
	JsonMetadataStore,
	_sqlalchemy_database_url,
	get_metadata_store,
)
from app.settings import Settings


def scope(workspace_id: str, *, tenant_id: str = "tenant-a") -> AccessScope:
	return AccessScope(
		tenant_id=tenant_id,
		workspace_id=workspace_id,
		principal_id=f"user-{workspace_id}",
	)


@pytest.mark.parametrize(
	("configured", "resolved"),
	[
		(
			"postgresql://user:pass@db/meriknow",
			"postgresql+psycopg://user:pass@db/meriknow",
		),
		(
			"postgres://user:pass@db/meriknow",
			"postgresql+psycopg://user:pass@db/meriknow",
		),
		(
			"postgresql+psycopg://user:pass@db/meriknow",
			"postgresql+psycopg://user:pass@db/meriknow",
		),
	],
)
def test_postgres_urls_use_the_declared_psycopg3_driver(
	configured: str,
	resolved: str,
) -> None:
	assert _sqlalchemy_database_url(configured) == resolved


def test_library_and_document_metadata_are_workspace_scoped(tmp_path: Path) -> None:
	store = JsonMetadataStore(tmp_path / "metadata.json")
	workspace_a = scope("workspace-a")
	workspace_b = scope("workspace-b")

	library_a = store.create_library(
		name="Shared name",
		library_id="library-a",
		scope=workspace_a,
	)
	library_b = store.create_library(
		name="Shared name",
		library_id="library-b",
		scope=workspace_b,
	)
	document_b = store.create_document(
		library_id=library_b["id"],
		name="Workspace B",
		filename="shared.md",
		content_type="text/markdown",
		doc_id="document-b",
		scope=workspace_b,
	)

	assert [item["id"] for item in store.list_libraries(scope=workspace_a)] == [
		library_a["id"]
	]
	assert store.get_library(library_b["id"], scope=workspace_a) is None
	assert (
		store.update_library(
			library_b["id"],
			name="tampered",
			scope=workspace_a,
		)
		is None
	)
	assert store.delete_library(library_b["id"], scope=workspace_a) is False
	assert store.list_documents(library_b["id"], scope=workspace_a) == []
	assert store.get_document(document_b["id"], scope=workspace_a) is None
	assert (
		store.update_document(
			document_b["id"],
			status="failed",
			scope=workspace_a,
		)
		is None
	)
	assert store.delete_document(document_b["id"], scope=workspace_a) is False
	with pytest.raises(ValueError, match="library not found"):
		store.create_document(
			library_id=library_b["id"],
			name="Injected",
			filename="injected.md",
			content_type="text/markdown",
			scope=workspace_a,
		)

	untouched = store.get_document(document_b["id"], scope=workspace_b)
	assert untouched is not None
	assert untouched["status"] == "processing"
	assert store.get_library(library_b["id"], scope=workspace_b)["doc_count"] == 1


def test_legacy_unscoped_metadata_is_not_visible(tmp_path: Path) -> None:
	path = tmp_path / "metadata.json"
	path.write_text(
		"""
{
  "libraries": {
    "legacy": {
      "id": "legacy",
      "name": "Legacy",
      "status": "empty",
      "doc_count": 0,
      "ready_count": 0
    }
  },
  "documents": {},
  "turns": {}
}
""".strip(),
		encoding="utf-8",
	)
	store = JsonMetadataStore(path)

	assert store.list_libraries(scope=scope("workspace-a")) == []
	assert store.get_library("legacy", scope=scope("workspace-a")) is None


def test_worker_rejects_foreign_document_id(
	tmp_path: Path,
	monkeypatch: pytest.MonkeyPatch,
) -> None:
	settings = Settings(
		metadata_backend="json",
		metadata_path=str(tmp_path / "metadata.json"),
		document_storage_dir=str(tmp_path / "documents"),
		ask_mode="stub",
		stub_ingest_simulate=True,
		internal_auth_enabled=True,
		internal_auth_secret="test-secret-32-characters-minimum!",
	)
	workspace_a = scope("workspace-a")
	workspace_b = scope("workspace-b")
	store = get_metadata_store(settings)
	store.create_library(
		name="Workspace B",
		library_id="library-b",
		scope=workspace_b,
	)
	store.create_document(
		library_id="library-b",
		name="Secret",
		filename="secret.md",
		content_type="text/markdown",
		doc_id="foreign-document",
		scope=workspace_b,
	)

	def fail_if_parsed(**_kwargs):
		raise AssertionError("foreign document reached the parser")

	monkeypatch.setattr(jobs, "prepare_ingest", fail_if_parsed)

	result = jobs.process_document_ingest(
		"foreign-document",
		settings=settings,
		access_scope=workspace_a,
	)

	assert result == {
		"ok": False,
		"doc_id": "foreign-document",
		"error": "document not found",
	}
	foreign = store.get_document("foreign-document", scope=workspace_b)
	assert foreign is not None
	assert foreign["status"] == "processing"
