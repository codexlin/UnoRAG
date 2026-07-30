from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
import pytest

from app.services.metadata import (
	JsonMetadataStore,
	SqlAlchemyMetadataStore,
	_sqlalchemy_database_url,
)
from app.settings import Settings


def test_conversation_store_schema_defaults_to_public_and_validates() -> None:
	assert Settings(_env_file=None).conversation_store_schema == "public"
	assert Settings(_env_file=None, conversation_store_schema="app").conversation_store_schema == "app"
	with pytest.raises(ValueError, match="CONVERSATION_STORE_SCHEMA"):
		Settings(_env_file=None, conversation_store_schema="both")


def test_json_conversations_do_not_depend_on_postgres_app_attributes(tmp_path: Path) -> None:
	store = JsonMetadataStore(tmp_path / "metadata.json")
	thread = store.create_thread(
		title="JSON remains standalone",
		session_id="json-session",
		library_id="json-library",
		tenant_id="tenant",
		workspace_id="workspace",
		principal_id="principal",
	)
	turn = store.create_turn(
		session_id="json-session",
		thread_id=thread["id"],
		library_id="json-library",
		question="question",
		answer="answer",
		citations=[],
		mode="stub",
		tenant_id="tenant",
		workspace_id="workspace",
		principal_id="principal",
	)

	assert store.list_threads(
		tenant_id="tenant",
		workspace_id="workspace",
		principal_id="principal",
	)[0]["turn_count"] == 1
	assert store.get_thread(
		thread["id"],
		tenant_id="tenant",
		workspace_id="workspace",
		principal_id="principal",
	)["id"] == thread["id"]
	assert store.touch_thread(
		thread["id"],
		tenant_id="tenant",
		workspace_id="workspace",
		principal_id="principal",
		title="Updated",
	)["title"] == "Updated"
	assert store.list_turns(
		thread_id=thread["id"],
		tenant_id="tenant",
		workspace_id="workspace",
		principal_id="principal",
	)[0]["id"] == turn["id"]
	assert store.get_turn(
		turn["id"],
		tenant_id="tenant",
		workspace_id="workspace",
		principal_id="principal",
	)["answer"] == "answer"


DATABASE_URL = (
	os.getenv("CONVERSATION_TEST_DATABASE_URL", "").strip()
	or os.getenv("JOB_TEST_DATABASE_URL", "").strip()
)
postgres_required = pytest.mark.skipif(
	not DATABASE_URL,
	reason="CONVERSATION_TEST_DATABASE_URL is not configured",
)


@pytest.fixture
def app_conversation_scope():
	organization_id = uuid4()
	workspace_id = uuid4()
	principal_id = uuid4()
	other_principal_id = uuid4()
	rag_library_id = f"conversation-{uuid4()}"
	with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
		connection.execute(
			"""
			INSERT INTO app.organizations (id, slug, name)
			VALUES (%s, %s, 'Conversation rollback test')
			""",
			(organization_id, f"conversation-test-{organization_id}"),
		)
		connection.execute(
			"""
			INSERT INTO app.workspaces (id, organization_id, slug, name)
			VALUES (%s, %s, 'default', 'Default')
			""",
			(workspace_id, organization_id),
		)
		for user_id in (principal_id, other_principal_id):
			connection.execute(
				"""
				INSERT INTO app.users (
					id, organization_id, external_subject, display_name
				)
				VALUES (%s, %s, %s, 'Conversation user')
				""",
				(user_id, organization_id, f"test:{user_id}"),
			)
			connection.execute(
				"""
				INSERT INTO app.workspace_members (workspace_id, user_id, role)
				VALUES (%s, %s, 'viewer')
				""",
				(workspace_id, user_id),
			)
		connection.execute(
			"""
			INSERT INTO app.libraries (
				organization_id, workspace_id, rag_library_id, name
			)
			VALUES (%s, %s, %s, 'Conversation library')
			""",
			(organization_id, workspace_id, rag_library_id),
		)
	try:
		yield {
			"organization_id": str(organization_id),
			"workspace_id": str(workspace_id),
			"principal_id": str(principal_id),
			"other_principal_id": str(other_principal_id),
			"rag_library_id": rag_library_id,
		}
	finally:
		with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
			connection.execute(
				"DELETE FROM app.organizations WHERE id = %s",
				(organization_id,),
			)


@postgres_required
def test_app_conversation_store_round_trip_scope_and_atomic_sequences(
	app_conversation_scope,
) -> None:
	scope = app_conversation_scope
	store = SqlAlchemyMetadataStore(
		_sqlalchemy_database_url(DATABASE_URL),
		conversation_store_schema="app",
		conversation_database_url=_sqlalchemy_database_url(DATABASE_URL),
	)
	thread = store.create_thread(
		title="Rollback thread",
		session_id="rollback-session",
		library_id=scope["rag_library_id"],
		tenant_id=scope["organization_id"],
		workspace_id=scope["workspace_id"],
		principal_id=scope["principal_id"],
	)
	assert UUID(thread["id"])
	assert thread["turn_count"] == 0

	def append(index: int) -> dict:
		return store.create_turn(
			session_id="rollback-session",
			thread_id=thread["id"],
			library_id=scope["rag_library_id"],
			question=f"question-{index}",
			answer=f"answer-{index}",
			citations=[{"doc_id": f"doc-{index}"}],
			mode="live",
			query_type="fact",
			retrieval_debug={"index": index},
			tenant_id=scope["organization_id"],
			workspace_id=scope["workspace_id"],
			principal_id=scope["principal_id"],
		)

	with ThreadPoolExecutor(max_workers=4) as executor:
		created = list(executor.map(append, range(4)))

	assert {row["question"] for row in created} == {
		"question-0",
		"question-1",
		"question-2",
		"question-3",
	}
	assert all(row["query_type"] == "fact" for row in created)
	assert all(row["retrieval_debug"] is not None for row in created)

	turns = store.list_turns(
		thread_id=thread["id"],
		tenant_id=scope["organization_id"],
		workspace_id=scope["workspace_id"],
		principal_id=scope["principal_id"],
	)
	assert len(turns) == 4
	assert store.get_thread(
		thread["id"],
		tenant_id=scope["organization_id"],
		workspace_id=scope["workspace_id"],
		principal_id=scope["principal_id"],
	)["turn_count"] == 4
	assert store.get_turn(
		created[0]["id"],
		tenant_id=scope["organization_id"],
		workspace_id=scope["workspace_id"],
		principal_id=scope["principal_id"],
	)["answer"] == created[0]["answer"]

	with psycopg.connect(DATABASE_URL) as connection:
		sequences = [
			row[0]
			for row in connection.execute(
				"SELECT sequence FROM app.turns WHERE thread_id = %s ORDER BY sequence",
				(thread["id"],),
			)
		]
		legacy_thread_count = connection.execute(
			"SELECT COUNT(*) FROM public.threads WHERE id = %s",
			(thread["id"],),
		).fetchone()[0]
	assert sequences == list(range(1, 9))
	assert legacy_thread_count == 0

	assert (
		store.get_thread(
			thread["id"],
			tenant_id=scope["organization_id"],
			workspace_id=scope["workspace_id"],
			principal_id=scope["other_principal_id"],
		)
		is None
	)
	assert (
		store.get_turn(
			created[0]["id"],
			tenant_id=scope["organization_id"],
			workspace_id=scope["workspace_id"],
			principal_id=scope["other_principal_id"],
		)
		is None
	)
	with pytest.raises(ValueError, match="active thread not found"):
		store.create_turn(
			session_id="rollback-session",
			thread_id=thread["id"],
			library_id=scope["rag_library_id"],
			question="forbidden",
			answer="forbidden",
			citations=[],
			mode="live",
			tenant_id=scope["organization_id"],
			workspace_id=scope["workspace_id"],
			principal_id=scope["other_principal_id"],
		)
	assert (
		store.get_thread(
			"not-a-uuid",
			tenant_id=scope["organization_id"],
			workspace_id=scope["workspace_id"],
			principal_id=scope["principal_id"],
		)
		is None
	)
