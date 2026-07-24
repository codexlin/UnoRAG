from __future__ import annotations

import hashlib
from pathlib import Path


class SourceObjectError(RuntimeError):
	pass


class SourceObjectNotFoundError(SourceObjectError):
	pass


class SourceObjectIntegrityError(SourceObjectError):
	pass


class LocalSourceObjectStorage:
	def __init__(self, root: str | Path, *, max_bytes: int) -> None:
		if not str(root).strip():
			raise ValueError("DOCUMENT_STORAGE_ROOT is required by lifecycle worker")
		self.root = Path(root).expanduser().resolve()
		self.max_bytes = max(1, int(max_bytes))

	def resolve(self, key: str) -> Path:
		normalized = str(key or "").replace("\\", "/").lstrip("/")
		if not normalized or any(part in {"", ".", ".."} for part in normalized.split("/")):
			raise SourceObjectError("invalid source object key")
		candidate = (self.root / normalized).resolve()
		if candidate == self.root or self.root not in candidate.parents:
			raise SourceObjectError("source object path escapes storage root")
		return candidate

	def read_bytes(self, key: str, *, expected_hash: str | None = None) -> bytes:
		path = self.resolve(key)
		try:
			size = path.stat().st_size
		except FileNotFoundError as exc:
			raise SourceObjectNotFoundError(f"source object not found: {key}") from exc
		if size <= 0:
			raise SourceObjectIntegrityError("source object is empty")
		if size > self.max_bytes:
			raise SourceObjectIntegrityError(
				f"source object exceeds {self.max_bytes} byte worker limit"
			)
		digest = hashlib.sha256()
		parts: list[bytes] = []
		total = 0
		try:
			with path.open("rb") as source:
				while block := source.read(1024 * 1024):
					total += len(block)
					if total > self.max_bytes:
						raise SourceObjectIntegrityError(
							f"source object exceeds {self.max_bytes} byte worker limit"
						)
					digest.update(block)
					parts.append(block)
		except FileNotFoundError as exc:
			raise SourceObjectNotFoundError(f"source object not found: {key}") from exc
		actual_hash = f"sha256:{digest.hexdigest()}"
		if expected_hash and actual_hash != expected_hash:
			raise SourceObjectIntegrityError(
				f"source object hash mismatch: expected {expected_hash}, got {actual_hash}"
			)
		return b"".join(parts)

	def delete(self, key: str) -> None:
		path = self.resolve(key)
		try:
			path.unlink()
		except FileNotFoundError:
			return
