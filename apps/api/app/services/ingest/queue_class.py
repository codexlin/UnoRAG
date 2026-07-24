"""Ingest queue class (local vs mineru) — claim-time slotting helpers.

Jobs carry ``payload.queue_class``:

- ``local``: docx/md/txt and PDFs that do not need MinerU
- ``auto``: PDF at enqueue time (probe deferred until worker download)
- ``mineru``: confirmed MinerU requirement after probe

Worker settings:

- ``LIFECYCLE_LOCAL_CAPACITY`` (default 2): concurrent local/auto slots
- ``LIFECYCLE_MINERU_CAPACITY`` (default 1): concurrent mineru slots

When a MinerU job is running, claim prefers ``local`` so docx is not blocked.
"""

from __future__ import annotations

from typing import Literal

QueueClass = Literal["local", "auto", "mineru"]


def infer_queue_class(filename: str, content_type: str = "") -> QueueClass:
	"""Enqueue-time class from filename / content-type (no file probe)."""
	name = (filename or "").strip().lower()
	ctype = (content_type or "").strip().lower()
	if name.endswith(".pdf") or "pdf" in ctype:
		return "auto"
	return "local"


def resolve_queue_class_after_probe(
	*,
	filename: str,
	content_type: str,
	content: bytes,
	mineru_enabled: bool,
) -> QueueClass:
	"""After download: promote auto→mineru when probe says so, else local."""
	base = infer_queue_class(filename, content_type)
	if base != "auto":
		return "local"
	if not mineru_enabled:
		return "local"
	from app.services.ingest.parsers.pdf_route import probe_needs_mineru

	return "mineru" if probe_needs_mineru(content) else "local"
