"""Embedding-based boundaries for long unstructured narrative text."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

from app.services.ingest.chunk_policy import ChunkingProfile, SemanticEmbedder

_SENTENCE_RE = re.compile(r".+?(?:[。！？!?；;]+|\.\s+|$)", re.DOTALL)


class SemanticChunkError(RuntimeError):
	"""Semantic splitting failed and the caller should use deterministic fallback."""


@dataclass(frozen=True)
class SemanticSplitResult:
	pieces: list[str]
	distance_threshold: float | None
	unit_count: int


def semantic_split(
	text: str,
	*,
	embedder: SemanticEmbedder,
	profile: ChunkingProfile,
) -> SemanticSplitResult:
	units = _semantic_units(text)
	if len(units) < 2:
		raise SemanticChunkError("not enough semantic units")
	if any(len(unit) > profile.max_chars for unit in units):
		raise SemanticChunkError("semantic unit exceeds max_chars")

	try:
		vectors = embedder(units)
	except Exception as exc:  # noqa: BLE001 - deterministic fallback is the contract
		raise SemanticChunkError(f"embedding failed: {type(exc).__name__}") from exc
	if len(vectors) != len(units):
		raise SemanticChunkError("embedding count mismatch")
	if not vectors or any(not vector for vector in vectors):
		raise SemanticChunkError("embedding vector is empty")

	distances = [
		1.0 - _cosine_similarity(vectors[index], vectors[index + 1])
		for index in range(len(vectors) - 1)
	]
	threshold = _percentile(distances, profile.semantic_break_percentile)
	boundaries = {
		index
		for index, distance in enumerate(distances)
		if distance >= threshold and distance > 0
	}
	pieces = _pack_units(units, boundaries=boundaries, profile=profile)
	if not pieces:
		raise SemanticChunkError("semantic packing produced no chunks")
	return SemanticSplitResult(
		pieces=pieces,
		distance_threshold=round(threshold, 6),
		unit_count=len(units),
	)


def _semantic_units(text: str) -> list[str]:
	units: list[str] = []
	for paragraph in re.split(r"\n\s*\n", (text or "").strip()):
		cleaned = paragraph.strip()
		if not cleaned:
			continue
		sentences = [match.group(0).strip() for match in _SENTENCE_RE.finditer(cleaned)]
		units.extend(sentence for sentence in sentences if sentence)
	return units


def _cosine_similarity(left: list[float], right: list[float]) -> float:
	if len(left) != len(right):
		raise SemanticChunkError("embedding dimension mismatch")
	try:
		left_values = [float(value) for value in left]
		right_values = [float(value) for value in right]
	except (TypeError, ValueError) as exc:
		raise SemanticChunkError("embedding vector contains non-numeric value") from exc
	if not all(math.isfinite(value) for value in [*left_values, *right_values]):
		raise SemanticChunkError("embedding vector contains non-finite value")
	dot = sum(a * b for a, b in zip(left_values, right_values, strict=True))
	left_norm = math.sqrt(sum(value**2 for value in left_values))
	right_norm = math.sqrt(sum(value**2 for value in right_values))
	if left_norm <= 0 or right_norm <= 0:
		raise SemanticChunkError("embedding vector has zero norm")
	return max(-1.0, min(1.0, dot / (left_norm * right_norm)))


def _percentile(values: list[float], percentile: int) -> float:
	if not values:
		raise SemanticChunkError("no semantic distances")
	ordered = sorted(float(value) for value in values)
	rank = max(0, min(len(ordered) - 1, math.ceil(percentile / 100 * len(ordered)) - 1))
	return ordered[rank]


def _pack_units(
	units: list[str],
	*,
	boundaries: set[int],
	profile: ChunkingProfile,
) -> list[str]:
	pieces: list[str] = []
	buffer: list[str] = []

	def flush() -> None:
		if not buffer:
			return
		body = " ".join(buffer).strip()
		if body:
			pieces.append(body)
		buffer.clear()

	for index, unit in enumerate(units):
		candidate = " ".join([*buffer, unit]).strip()
		if buffer and len(candidate) > profile.max_chars:
			flush()
		buffer.append(unit)
		current_length = len(" ".join(buffer))
		if (
			index in boundaries
			and current_length >= profile.semantic_min_chunk_chars
		):
			flush()
	flush()
	return pieces
