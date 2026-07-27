"""AskGraph request lifecycle: id resolve, history load, temp session memory.

Metadata/session I/O for prepare + finalize lives here so graph nodes stay free
of store singletons. Full prepare→execute→finalize service lands in a later commit.
"""

from __future__ import annotations

import uuid

from app.services.session_memory import (
	WORKING_MEMORY_MAX_TURNS,
	SessionMemory,
)


def resolve_request_ids(
	session_id: str | None,
	thread_id: str | None,
) -> tuple[str, str | None]:
	"""Return (resolved_session_id, resolved_thread_id)."""
	resolved_session = session_id or str(uuid.uuid4())
	resolved_thread = (thread_id or "").strip() or None
	return resolved_session, resolved_thread


def memory_session_id(scope_cache_key: str, session_id: str) -> str:
	return f"{scope_cache_key}:{session_id}"


def history_from_thread(
	thread_id: str,
	*,
	tenant_id: str,
	workspace_id: str,
	principal_id: str,
	max_turns: int = WORKING_MEMORY_MAX_TURNS,
) -> list[dict[str, str]]:
	"""Load last N Q/A turns from an archived thread (chronological for rewrite)."""
	from app.services.metadata import get_metadata_store

	cap = max(1, int(max_turns))
	rows = get_metadata_store().list_turns(
		thread_id=thread_id,
		tenant_id=tenant_id,
		workspace_id=workspace_id,
		principal_id=principal_id,
		limit=cap,
	)
	# list_turns is newest-first; reverse for chat history order.
	history: list[dict[str, str]] = []
	for row in reversed(rows):
		question = (row.get("question") or "").strip()
		answer = (row.get("answer") or "").strip()
		if question:
			history.append({"role": "user", "content": question})
		if answer:
			history.append({"role": "assistant", "content": answer})
	return history


def load_request_history(
	*,
	thread_id: str | None,
	tenant_id: str,
	workspace_id: str,
	principal_id: str,
	session_memory: SessionMemory,
	memory_session: str,
	session_memory_enabled: bool,
	max_turns: int = WORKING_MEMORY_MAX_TURNS,
) -> list[dict[str, str]]:
	"""Prepare chat history: archived thread DB rows, else in-process session memory."""
	if thread_id:
		return history_from_thread(
			thread_id,
			tenant_id=tenant_id,
			workspace_id=workspace_id,
			principal_id=principal_id,
			max_turns=max_turns,
		)
	if session_memory_enabled:
		# Same shape/window as archived threads (code constant, not UI knob).
		return session_memory.load(
			memory_session,
			limit=max_turns * 2,
		)
	return []


def append_temp_session_memory(
	*,
	thread_id: str | None,
	session_memory_enabled: bool,
	session_memory: SessionMemory,
	memory_session: str,
	question: str,
	answer: str,
) -> None:
	"""Temp sessions keep short in-process memory; archived threads rely on DB."""
	if not thread_id and session_memory_enabled:
		session_memory.append(memory_session, "user", question)
		session_memory.append(memory_session, "assistant", answer)
