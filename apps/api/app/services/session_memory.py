from __future__ import annotations

import threading
from collections import defaultdict, deque


class SessionMemory:
	"""In-process short chat memory keyed by session_id (no Redis yet)."""

	def __init__(self, *, max_turns: int = 6) -> None:
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
