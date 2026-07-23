"""Chunk strategy policy: choose by IR structure, then use text fallbacks."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

from app.services.ingest.ir import NodeType, SplitStrategy

SemanticEmbedder = Callable[[list[str]], list[list[float]]]

POLICY_VERSION = "v1"
_PROFILE_TARGET_RATIOS = {
	"precise": 0.65,
	"balanced": 1.0,
	"narrative": 1.0,
	"table_heavy": 1.0,
}


@dataclass(frozen=True)
class ChunkingProfile:
	name: str
	target_chars: int
	max_chars: int
	overlap_chars: int
	heading_boundary_level: int
	semantic_enabled: bool
	semantic_min_chars: int
	semantic_break_percentile: int
	semantic_min_chunk_chars: int
	table_rows_per_record: int
	policy_version: str = POLICY_VERSION


@dataclass(frozen=True)
class ChunkDecision:
	strategy: SplitStrategy
	reason: str


def build_chunking_profile(
	*,
	name: str = "balanced",
	chunk_size: int = 500,
	chunk_overlap: int = 80,
	heading_boundary_level: int = 2,
	semantic_enabled: bool = False,
	semantic_min_chars: int = 1200,
	semantic_break_percentile: int = 85,
	policy_version: str = POLICY_VERSION,
) -> ChunkingProfile:
	resolved_name = (name or "balanced").strip().lower()
	if resolved_name not in _PROFILE_TARGET_RATIOS:
		raise ValueError(
			f"unknown chunking profile: {name}; "
			f"expected one of {sorted(_PROFILE_TARGET_RATIOS)}"
		)
	max_chars = max(100, int(chunk_size))
	target = max(100, min(max_chars, round(max_chars * _PROFILE_TARGET_RATIOS[resolved_name])))
	overlap = max(0, min(int(chunk_overlap), target - 1))
	min_chunk = max(80, min(target // 2, 240))
	return ChunkingProfile(
		name=resolved_name,
		target_chars=target,
		max_chars=max_chars,
		overlap_chars=overlap,
		heading_boundary_level=max(1, int(heading_boundary_level)),
		semantic_enabled=bool(semantic_enabled),
		semantic_min_chars=max(max_chars, int(semantic_min_chars)),
		semantic_break_percentile=max(1, min(99, int(semantic_break_percentile))),
		semantic_min_chunk_chars=min_chunk,
		table_rows_per_record=20 if resolved_name == "table_heavy" else 40,
		policy_version=(policy_version or POLICY_VERSION).strip() or POLICY_VERSION,
	)


def decide_special_node(node_type: NodeType) -> ChunkDecision:
	if node_type == NodeType.TABLE:
		return ChunkDecision(SplitStrategy.TABLE, "structured_table")
	if node_type == NodeType.CODE:
		return ChunkDecision(SplitStrategy.CODE, "structured_code")
	raise ValueError(f"unsupported special node type: {node_type}")


def decide_text_strategy(
	*,
	text: str,
	source_format: str,
	section_path: str | None,
	force_page_strategy: bool,
	profile: ChunkingProfile,
	semantic_available: bool,
) -> ChunkDecision:
	length = len((text or "").strip())
	if force_page_strategy:
		# Prefer page-boundary semantics: keep whole page when within max_chars
		# (even if over target_chars under precise). Chunker must honor PAGE as
		# a single piece — do not recursive-split while labeling PAGE.
		if length <= profile.max_chars:
			return ChunkDecision(SplitStrategy.PAGE, "page_boundary")
		return ChunkDecision(SplitStrategy.RECURSIVE, "page_over_max")

	if section_path:
		if length <= profile.target_chars:
			return ChunkDecision(SplitStrategy.HEADING, "structured_heading")
		return ChunkDecision(SplitStrategy.RECURSIVE, "heading_section_over_target")

	if length <= profile.target_chars:
		return ChunkDecision(SplitStrategy.RECURSIVE, "short_unstructured_text")

	if profile.semantic_enabled and length >= profile.semantic_min_chars:
		if not _looks_like_narrative(text, source_format=source_format):
			return ChunkDecision(SplitStrategy.RECURSIVE, "semantic_ineligible_content")
		if not semantic_available:
			return ChunkDecision(SplitStrategy.RECURSIVE, "semantic_unavailable_fallback")
		return ChunkDecision(SplitStrategy.SEMANTIC, "unstructured_long_narrative")

	return ChunkDecision(SplitStrategy.RECURSIVE, "unstructured_text")


def decision_metadata(
	decision: ChunkDecision,
	profile: ChunkingProfile,
	**extra: object,
) -> dict[str, object]:
	meta: dict[str, object] = {
		"chunk_policy_version": profile.policy_version,
		"chunk_profile": profile.name,
		"split_reason": decision.reason,
		"target_chars": profile.target_chars,
		"max_chars": profile.max_chars,
		"table_rows_per_record": profile.table_rows_per_record,
	}
	for key, value in extra.items():
		if value is not None:
			meta[key] = value
	return meta


def _looks_like_narrative(text: str, *, source_format: str) -> bool:
	if source_format.lower() not in {"txt", "pdf", "docx", "md", "markdown"}:
		return False
	cleaned = (text or "").strip()
	if not cleaned:
		return False
	lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
	if lines:
		table_like = sum(1 for line in lines if "|" in line or "\t" in line)
		if table_like / len(lines) >= 0.4:
			return False
	code_marks = len(re.findall(r"[{};]|(?:def|class|function)\s+\w+", cleaned))
	if code_marks >= max(6, len(cleaned) // 120):
		return False
	paragraphs = len([part for part in re.split(r"\n\s*\n", cleaned) if part.strip()])
	sentences = len(re.findall(r"[。！？!?；;](?:\s|$)|\.\s", cleaned))
	return paragraphs >= 3 or sentences >= 4
