from __future__ import annotations

from qdrant_client import QdrantClient

from app.security.access_scope import AclScope, AccessScope
from app.services.ingest.ir import Chunk
from app.services.qdrant_store import QdrantStore
from app.services.retrieval import IngestService
from app.settings import Settings


def _scope(
	tenant: str,
	workspace: str,
	principal: str,
	*groups: str,
) -> AccessScope:
	return AccessScope(
		tenant_id=tenant,
		workspace_id=workspace,
		principal_id=principal,
		group_ids=groups,
	)


def _upsert(
	store: QdrantStore,
	*,
	point_id: str,
	title: str,
	scope: AccessScope,
	acl_scope: AclScope = "workspace",
	allowed_group_ids: tuple[str, ...] = (),
) -> None:
	store.upsert_chunks(
		library_id="shared-library-id",
		doc_id=f"doc-{point_id}",
		title=title,
		chunks=[{"_point_id": point_id, "chunk_index": 0, "text": title}],
		vectors=[[1.0, 0.0, 0.0]],
		access_scope=scope,
		acl_scope=acl_scope,
		allowed_group_ids=allowed_group_ids,
	)


def test_qdrant_access_scope_prevents_cross_tenant_workspace_and_group_leaks() -> None:
	settings = Settings(
		embedding_dim=3,
		qdrant_collection="access-scope-test",
		internal_auth_enabled=True,
		internal_auth_secret="test-secret-32-characters-minimum!",
	)
	store = QdrantStore(settings, client=QdrantClient(location=":memory:"))
	alice = _scope("tenant-a", "workspace-a", "alice", "finance")
	bob = _scope("tenant-a", "workspace-a", "bob", "engineering")
	other_workspace = _scope("tenant-a", "workspace-b", "carol", "finance")
	other_tenant = _scope("tenant-b", "workspace-a", "dave", "finance")

	_upsert(store, point_id="00000000-0000-4000-8000-000000000001", title="workspace", scope=alice)
	_upsert(
		store,
		point_id="00000000-0000-4000-8000-000000000002",
		title="finance-only",
		scope=alice,
		acl_scope="restricted",
		allowed_group_ids=("finance",),
	)
	_upsert(
		store,
		point_id="00000000-0000-4000-8000-000000000003",
		title="other-workspace",
		scope=other_workspace,
	)
	_upsert(
		store,
		point_id="00000000-0000-4000-8000-000000000004",
		title="other-tenant",
		scope=other_tenant,
	)

	alice_hits = store.search(
		vector=[1.0, 0.0, 0.0],
		library_id="shared-library-id",
		top_k=10,
		access_scope=alice,
	)
	bob_hits = store.search(
		vector=[1.0, 0.0, 0.0],
		library_id="shared-library-id",
		top_k=10,
		access_scope=bob,
	)

	assert {item["title"] for item in alice_hits} == {"workspace", "finance-only"}
	assert {item["title"] for item in bob_hits} == {"workspace"}


def test_ir_ingest_writes_the_authenticated_access_scope() -> None:
	class Embeddings:
		def embed_texts(self, texts: list[str]) -> list[list[float]]:
			return [[1.0, 0.0, 0.0] for _ in texts]

	settings = Settings(
		embedding_dim=3,
		qdrant_collection="access-scope-ir-ingest",
		internal_auth_enabled=True,
		internal_auth_secret="test-secret-32-characters-minimum!",
	)
	store = QdrantStore(settings, client=QdrantClient(location=":memory:"))
	scope = _scope("tenant-a", "workspace-a", "alice")
	service = IngestService(
		settings,
		embeddings=Embeddings(),  # type: ignore[arg-type]
		store=store,
		access_scope=scope,
	)

	result = service.ingest_ir_chunks(
		library_id="library-a",
		title="Scoped document",
		doc_id="doc-a",
		chunks=[Chunk(chunk_index=0, text="scoped body", body="scoped body")],
	)
	hits = store.search(
		vector=[1.0, 0.0, 0.0],
		library_id="library-a",
		top_k=5,
		record_type="chunk",
		access_scope=scope,
	)

	assert result["chunk_count"] == 1
	assert len(hits) == 1
	assert hits[0]["tenant_id"] == "tenant-a"
	assert hits[0]["workspace_id"] == "workspace-a"
