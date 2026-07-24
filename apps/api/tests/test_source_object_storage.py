from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from app.services.source_object_storage import (
	LocalSourceObjectStorage,
	SourceObjectError,
	SourceObjectIntegrityError,
	SourceObjectNotFoundError,
)


def test_source_object_storage_reads_and_verifies_hash(tmp_path: Path) -> None:
	content = b"# Policy\n\nThree working days.\n"
	path = tmp_path / "tenant" / "workspace" / "policy.md"
	path.parent.mkdir(parents=True)
	path.write_bytes(content)
	storage = LocalSourceObjectStorage(tmp_path, max_bytes=1024)
	expected = f"sha256:{hashlib.sha256(content).hexdigest()}"

	assert storage.read_bytes("tenant/workspace/policy.md", expected_hash=expected) == content


def test_source_object_storage_rejects_escape_missing_oversize_and_hash_mismatch(
	tmp_path: Path,
) -> None:
	storage = LocalSourceObjectStorage(tmp_path, max_bytes=4)
	(tmp_path / "large.md").write_bytes(b"12345")
	(tmp_path / "small.md").write_bytes(b"ok")

	with pytest.raises(SourceObjectError):
		storage.read_bytes("../outside.md")
	with pytest.raises(SourceObjectNotFoundError):
		storage.read_bytes("missing.md")
	with pytest.raises(SourceObjectIntegrityError, match="exceeds"):
		storage.read_bytes("large.md")
	with pytest.raises(SourceObjectIntegrityError, match="hash mismatch"):
		storage.read_bytes("small.md", expected_hash="sha256:not-the-hash")
