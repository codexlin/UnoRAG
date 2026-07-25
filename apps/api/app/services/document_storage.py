from __future__ import annotations

from pathlib import Path

from app.settings import Settings


class DocumentStorage:
	def __init__(self, settings: Settings) -> None:
		# Prefer DOCUMENT_STORAGE_ROOT; legacy DOCUMENT_STORAGE_DIR as fallback.
		self.root = Path(settings.resolved_document_storage)
		self.root.mkdir(parents=True, exist_ok=True)

	@staticmethod
	def _safe_filename(filename: str) -> str:
		return Path(filename).name or "untitled"

	def _full_path(self, storage_key: str) -> Path:
		return self.root / storage_key

	def save(self, library_id: str, doc_id: str, filename: str, content: bytes) -> str:
		safe = self._safe_filename(filename)
		storage_key = f"{library_id}/{doc_id}/{safe}"
		path = self._full_path(storage_key)
		path.parent.mkdir(parents=True, exist_ok=True)
		path.write_bytes(content)
		return storage_key

	def read(self, storage_key: str) -> bytes:
		path = self._full_path(storage_key)
		if not path.is_file():
			raise FileNotFoundError(storage_key)
		return path.read_bytes()

	def path_for(self, storage_key: str) -> Path:
		return self._full_path(storage_key)

	def delete(self, storage_key: str) -> None:
		path = self._full_path(storage_key)
		if path.is_file():
			path.unlink()
