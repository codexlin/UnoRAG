from __future__ import annotations

from qdrant_client import QdrantClient

from app.security.access_scope import AccessScope
from app.services.active_generations import ActiveGenerationSnapshot
from app.services.ingest.ir import Chunk
from app.services.qdrant_store import QdrantStore
from app.services.retrieval import IngestService, RetrievalService
from app.settings import Settings


class FakeEmbeddings:
	def embed_texts(self, texts: list[str]) -> list[list[float]]:
		return [[1.0, 0.0, 0.0] for _ in texts]

	def embed_query(self, _text: str) -> list[float]:
		return [1.0, 0.0, 0.0]


class FakeActiveResolver:
	def __init__(self, *generation_ids: str) -> None:
		self.generation_ids = generation_ids

	def resolve(
		self,
		*,
		scope: AccessScope,
		library_id: str,
	) -> ActiveGenerationSnapshot:
		assert scope.tenant_id == "tenant-a"
		assert library_id == "library-a"
		return ActiveGenerationSnapshot(
			generation_ids=tuple(self.generation_ids),
			resolved_at=1.0,
		)


def test_staging_generation_is_hidden_and_replay_is_idempotent() -> None:
	settings = Settings(
		embedding_dim=3,
		qdrant_collection="generation-staging-test",
		internal_auth_enabled=True,
		internal_auth_secret="test-secret-32-characters-minimum!",
	)
	client = QdrantClient(location=":memory:")
	store = QdrantStore(settings, client=client)
	scope = AccessScope(
		tenant_id="tenant-a",
		workspace_id="workspace-a",
		principal_id="alice",
	)
	service = IngestService(
		settings,
		embeddings=FakeEmbeddings(),  # type: ignore[arg-type]
		store=store,
		access_scope=scope,
	)
	chunks = [Chunk(chunk_index=0, text="policy body", body="policy body")]

	first = service.ingest_ir_chunks(
		library_id="library-a",
		title="Policy",
		chunks=chunks,
		doc_id="document-a",
		document_version_id="version-a",
		generation_id="generation-a",
		lifecycle_visibility="staging",
	)
	points, _ = client.scroll(
		collection_name=store.collection,
		limit=100,
		with_payload=True,
		with_vectors=False,
	)
	first_ids = {str(point.id) for point in points}

	assert first["point_count"] == len(first_ids)
	assert all((point.payload or {})["generation_id"] == "generation-a" for point in points)
	assert all(
		(point.payload or {})["document_version_id"] == "version-a"
		for point in points
	)
	assert all(
		(point.payload or {})["lifecycle_visibility"] == "staging"
		for point in points
	)
	assert store.count_generation(
		generation_id="generation-a",
		access_scope=scope,
	) == first["point_count"]
	assert (
		store.search(
			vector=[1.0, 0.0, 0.0],
			library_id="library-a",
			top_k=10,
			access_scope=scope,
		)
		== []
	)
	assert store.list_chunks(library_id="library-a", access_scope=scope) == []

	second = service.ingest_ir_chunks(
		library_id="library-a",
		title="Policy",
		chunks=chunks,
		doc_id="document-a",
		document_version_id="version-a",
		generation_id="generation-a",
		lifecycle_visibility="staging",
	)
	replayed, _ = client.scroll(
		collection_name=store.collection,
		limit=100,
		with_payload=True,
		with_vectors=False,
	)
	assert second["point_count"] == first["point_count"]
	assert {str(point.id) for point in replayed} == first_ids

	client.set_payload(
		collection_name=store.collection,
		payload={"lifecycle_visibility": "active"},
		points=list(first_ids),
	)
	active_hits = store.search(
		vector=[1.0, 0.0, 0.0],
		library_id="library-a",
		top_k=10,
		record_type="chunk",
		access_scope=scope,
	)
	assert len(active_hits) == 1
	assert active_hits[0]["generation_id"] == "generation-a"


def test_different_generations_use_disjoint_point_ids() -> None:
	settings = Settings(
		embedding_dim=3,
		qdrant_collection="generation-id-test",
		internal_auth_enabled=True,
		internal_auth_secret="test-secret-32-characters-minimum!",
	)
	client = QdrantClient(location=":memory:")
	store = QdrantStore(settings, client=client)
	scope = AccessScope("tenant-a", "workspace-a", "alice")
	service = IngestService(
		settings,
		embeddings=FakeEmbeddings(),  # type: ignore[arg-type]
		store=store,
		access_scope=scope,
	)
	chunks = [Chunk(chunk_index=0, text="body", body="body")]

	for generation_id in ("generation-a", "generation-b"):
		service.ingest_ir_chunks(
			library_id="library-a",
			title="Policy",
			chunks=chunks,
			doc_id="document-a",
			document_version_id=f"version-{generation_id[-1]}",
			generation_id=generation_id,
			lifecycle_visibility="staging",
		)

	points, _ = client.scroll(
		collection_name=store.collection,
		limit=100,
		with_payload=True,
		with_vectors=False,
	)
	by_generation: dict[str, set[str]] = {}
	for point in points:
		generation = str((point.payload or {})["generation_id"])
		by_generation.setdefault(generation, set()).add(str(point.id))

	assert by_generation["generation-a"]
	assert by_generation["generation-b"]
	assert by_generation["generation-a"].isdisjoint(by_generation["generation-b"])


def test_authoritative_generation_snapshot_prevents_mixed_version_citations() -> None:
	settings = Settings(
		embedding_dim=3,
		qdrant_collection="generation-gate-test",
		internal_auth_enabled=True,
		internal_auth_secret="test-secret-32-characters-minimum!",
	)
	client = QdrantClient(location=":memory:")
	store = QdrantStore(settings, client=client)
	scope = AccessScope("tenant-a", "workspace-a", "alice")
	ingest = IngestService(
		settings,
		embeddings=FakeEmbeddings(),  # type: ignore[arg-type]
		store=store,
		access_scope=scope,
	)
	for generation_id, version_id, body in (
		("generation-a", "version-a", "old policy"),
		("generation-b", "version-b", "new policy"),
	):
		ingest.ingest_ir_chunks(
			library_id="library-a",
			title="Policy",
			chunks=[Chunk(chunk_index=0, text=body, body=body)],
			doc_id="document-a",
			document_version_id=version_id,
			generation_id=generation_id,
			lifecycle_visibility="staging",
		)
		store.set_generation_visibility(
			generation_id=generation_id,
			visibility="active",
			access_scope=scope,
		)

	raw_hits = store.search(
		vector=[1.0, 0.0, 0.0],
		library_id="library-a",
		top_k=10,
		record_type="chunk",
		access_scope=scope,
		active_generation_ids=("generation-b",),
	)
	assert len(raw_hits) == 1
	assert raw_hits[0]["document_version_id"] == "version-b"

	retrieval = RetrievalService(
		settings,
		embeddings=FakeEmbeddings(),  # type: ignore[arg-type]
		store=store,
		access_scope=scope,
		active_generation_resolver=FakeActiveResolver("generation-b"),
	)
	citations = retrieval.search(query="policy", library_id="library-a", top_k=5)

	assert len(citations) == 1
	assert citations[0]["document_version_id"] == "version-b"
	assert citations[0]["generation_id"] == "generation-b"
	assert citations[0]["body"] == "new policy"
	assert retrieval.last_debug["active_generation_gate"] is True
	assert retrieval.last_debug["active_generation_count"] == 1


def test_empty_active_snapshot_rejects_legacy_points() -> None:
	settings = Settings(
		embedding_dim=3,
		qdrant_collection="generation-empty-gate-test",
		internal_auth_enabled=True,
		internal_auth_secret="test-secret-32-characters-minimum!",
	)
	store = QdrantStore(settings, client=QdrantClient(location=":memory:"))
	scope = AccessScope("tenant-a", "workspace-a", "alice")
	store.upsert_chunks(
		library_id="library-a",
		doc_id="legacy-document",
		title="Legacy",
		chunks=[
			{
				"_point_id": "00000000-0000-4000-8000-000000000099",
				"chunk_index": 0,
				"text": "legacy body",
				# Required on payload; still "legacy" for gate (no generation_id).
				"document_version_id": "legacy-version",
			}
		],
		vectors=[[1.0, 0.0, 0.0]],
		access_scope=scope,
	)

	hits = store.search(
		vector=[1.0, 0.0, 0.0],
		library_id="library-a",
		top_k=10,
		record_type="chunk",
		access_scope=scope,
		active_generation_ids=(),
	)
	assert hits == []

	ungated_hits = store.search(
		vector=[1.0, 0.0, 0.0],
		library_id="library-a",
		top_k=10,
		record_type="chunk",
		access_scope=scope,
	)
	assert [item["doc_id"] for item in ungated_hits] == ["legacy-document"]
