"""文档版本 stub — 无完整 version 表时派生 document_version_id。"""

from __future__ import annotations


def derive_document_version_id(
	doc_id: str,
	*,
	content_hash: str | None = None,
	version: int = 1,
) -> str:
	"""派生版本 id：优先 content_hash 前缀，否则 `{doc_id}:v{n}`。"""
	resolved = (doc_id or "").strip() or "unknown"
	if content_hash and str(content_hash).strip():
		return f"{resolved}:{str(content_hash).strip()[:12]}"
	return f"{resolved}:v{max(1, int(version))}"
