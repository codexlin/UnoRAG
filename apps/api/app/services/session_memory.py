from __future__ import annotations

import threading
from collections import defaultdict, deque

# Working-memory window (complete Q/A turns). Code constant — not a workspace UI knob.
WORKING_MEMORY_MAX_TURNS = 10
# Soft char budget for generate history; drop oldest turns if exceeded (effect > token thrift).
GENERATE_HISTORY_MAX_CHARS = 24_000


class SessionMemory:
	"""In-process short chat memory for temporary (non-archived) sessions.

	Keyed by caller-provided session key (typically principal+workspace+session_id).
	No Redis; process-local / lost on restart — intentional for default-temp chats.
	"""

	def __init__(self, *, max_turns: int = WORKING_MEMORY_MAX_TURNS) -> None:
		self.max_turns = max(1, max_turns)
		self._lock = threading.Lock()
		self._messages: dict[str, deque[dict[str, str]]] = defaultdict(
			lambda: deque(maxlen=self.max_turns * 2)
		)

	def load(self, session_id: str, limit: int | None = None) -> list[dict[str, str]]:
		cap = limit if limit is not None else self.max_turns * 2
		with self._lock:
			items = list(self._messages.get(session_id, ()))
		return items[-cap:] if cap > 0 else items

	def append(self, session_id: str, role: str, content: str) -> None:
		text = (content or "").strip()
		if not session_id or not text:
			return
		with self._lock:
			self._messages[session_id].append({"role": role, "content": text})

	def clear(self, session_id: str | None = None) -> None:
		with self._lock:
			if session_id is None:
				self._messages.clear()
			else:
				self._messages.pop(session_id, None)


# Process-wide default store (tests can inject their own instance).
default_session_memory = SessionMemory()
