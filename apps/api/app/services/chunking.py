"""Legacy char-window chunker.

保留给 INGEST_PIPELINE=legacy 与结构切片内部 fallback（split_strategy=char_window）。
新路径请用 app.services.ingest.chunker（结构优先）。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TextChunk:
	index: int
	text: str


def chunk_text(
	text: str,
	*,
	chunk_size: int = 500,
	chunk_overlap: int = 80,
) -> list[TextChunk]:
	cleaned = text.strip()
	if not cleaned:
		return []

	if len(cleaned) <= chunk_size:
		return [TextChunk(index=0, text=cleaned)]

	if chunk_overlap >= chunk_size:
		raise ValueError("chunk_overlap must be smaller than chunk_size")

	chunks: list[TextChunk] = []
	start = 0
	index = 0

	while start < len(cleaned):
		end = min(start + chunk_size, len(cleaned))
		piece = cleaned[start:end].strip()
		if piece:
			chunks.append(TextChunk(index=index, text=piece))
			index += 1

		if end >= len(cleaned):
			break

		start = end - chunk_overlap

	return chunks
