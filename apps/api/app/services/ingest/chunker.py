"""L3 policy-driven, structure-aware chunker."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from app.services.chunking import chunk_text
from app.services.ingest.chunk_policy import (
	POLICY_VERSION,
	ChunkDecision,
	ChunkingProfile,
	SemanticEmbedder,
	build_chunking_profile,
	decide_special_node,
	decide_text_strategy,
	decision_metadata,
)
from app.services.ingest.ir import (
	Chunk,
	DocumentIR,
	Node,
	NodeType,
	SplitStrategy,
	build_preamble,
	format_page_label,
)
from app.services.ingest.semantic_chunker import SemanticChunkError, semantic_split

# 句级/段级分隔：中文制度文档常见边界
_RECURSIVE_SEPARATORS = ("\n\n", "\n", "。", "；", "！", "？", ". ", "; ", " ")


@dataclass
class ChunkerConfig:
	chunk_size: int = 500
	chunk_overlap: int = 80
	# heading 切片：以不超过该 level 的 heading 作为块边界（默认 H2）
	heading_boundary_level: int = 2
	profile_name: str = "balanced"
	policy_version: str = POLICY_VERSION
	semantic_enabled: bool = False
	semantic_min_chars: int = 1200
	semantic_break_percentile: int = 85

	def resolved_profile(self) -> ChunkingProfile:
		return build_chunking_profile(
			name=self.profile_name,
			chunk_size=self.chunk_size,
			chunk_overlap=self.chunk_overlap,
			heading_boundary_level=self.heading_boundary_level,
			semantic_enabled=self.semantic_enabled,
			semantic_min_chars=self.semantic_min_chars,
			semantic_break_percentile=self.semantic_break_percentile,
			policy_version=self.policy_version,
		)


def chunk_document(
	doc: DocumentIR,
	*,
	config: ChunkerConfig | None = None,
	semantic_embedder: SemanticEmbedder | None = None,
) -> list[Chunk]:
	profile = (config or ChunkerConfig()).resolved_profile()
	if not doc.nodes:
		return []

	sections = _split_into_sections(doc.nodes, boundary_level=profile.heading_boundary_level)
	chunks: list[Chunk] = []

	for section in sections:
		for node in section.special_nodes:
			body = (node.text or "").strip()
			if not body and node.table_json:
				body = _table_json_to_text(node.table_json)
			if not body:
				continue
			decision = decide_special_node(node.type)
			ps = node.page_start if node.page_start is not None else section.page_start
			pe = node.page_end if node.page_end is not None else section.page_end
			meta = decision_metadata(decision, profile)
			if node.type == NodeType.TABLE and (
				node.table_ir is not None or isinstance(node.table_json, dict)
			):
				table_json = node.table_json if isinstance(node.table_json, dict) else {}
				meta["headers"] = (
					node.table_ir.headers()
					if node.table_ir is not None
					else [str(h) for h in (table_json.get("headers") or [])]
				)
				meta["rows"] = (
					node.table_ir.legacy_rows()
					if node.table_ir is not None
					else [
						[str(c) for c in row]
						for row in (table_json.get("rows") or [])
					]
				)
				if node.table_ir is not None:
					meta["table_ir"] = node.table_ir.model_dump()
					meta["table_quality"] = node.table_ir.quality_report.model_dump()
					meta["table_caption"] = node.table_ir.caption
					meta["summary_rows"] = [
						row.model_dump() for row in node.table_ir.summary_rows
					]
					meta["footnotes"] = list(node.table_ir.footnotes)
				meta["table_rows_per_record"] = profile.table_rows_per_record
				meta["table_tokens_per_record"] = profile.table_tokens_per_record
			chunk = Chunk(
				chunk_index=len(chunks),
				text="",
				body=body,
				preamble=build_preamble(
					title=doc.title,
					section_path=section.section_path,
					heading_text=section.heading_text,
					page_start=ps,
					page_end=pe,
				),
				section_path=section.section_path,
				heading_text=section.heading_text,
				page_start=ps,
				page_end=pe,
				page_label=format_page_label(ps, pe),
				node_ids=[node.id],
				table_id=node.table_id,
				figure_id=node.figure_id,
				split_strategy=decision.strategy,
				source_format=doc.source_format,
				content_hash=doc.content_hash or doc.content_fingerprint(),
				meta=meta,
			)
			chunk.text = chunk.embed_text()
			chunks.append(chunk)

		body = section.body_text.strip()
		if not body:
			continue
		decision = decide_text_strategy(
			text=body,
			source_format=doc.source_format,
			section_path=section.section_path,
			force_page_strategy=section.force_page_strategy,
			profile=profile,
			semantic_available=semantic_embedder is not None,
		)
		extra_meta: dict = {}
		if decision.strategy == SplitStrategy.SEMANTIC:
			try:
				result = semantic_split(body, embedder=semantic_embedder, profile=profile)
				pieces = result.pieces
				extra_meta.update(
					{
						"semantic_distance_threshold": result.distance_threshold,
						"semantic_unit_count": result.unit_count,
					}
				)
			except SemanticChunkError as exc:
				decision = ChunkDecision(SplitStrategy.RECURSIVE, "semantic_error_fallback")
				extra_meta["semantic_fallback"] = type(exc.__cause__ or exc).__name__
				pieces = _recursive_split(
					body,
					chunk_size=profile.target_chars,
					overlap=profile.overlap_chars,
				)
		elif decision.strategy == SplitStrategy.PAGE:
			# force_page + len<=max_chars → keep whole page (even if over target).
			# Policy labels PAGE for page-boundary semantics; do not recursive-split
			# while still tagging as PAGE (precise target < max made that mismatch).
			pieces = [body]
		elif len(body) <= profile.target_chars:
			pieces = [body]
		else:
			pieces = _recursive_split(
				body,
				chunk_size=profile.target_chars,
				overlap=profile.overlap_chars,
			)

		if not pieces:
			pieces = [
				part.text
				for part in chunk_text(
					body,
					chunk_size=profile.target_chars,
					chunk_overlap=profile.overlap_chars,
				)
			]
			decision = ChunkDecision(SplitStrategy.CHAR_WINDOW, "recursive_empty_fallback")

		preamble = build_preamble(
			title=doc.title,
			section_path=section.section_path,
			heading_text=section.heading_text,
			page_start=section.page_start,
			page_end=section.page_end,
		)
		for piece in pieces:
			chunks.append(
				_make_chunk(
					index=len(chunks),
					body=piece,
					preamble=preamble,
					doc=doc,
					section_path=section.section_path,
					heading_text=section.heading_text,
					page_start=section.page_start,
					page_end=section.page_end,
					node_ids=section.node_ids,
					decision=decision,
					profile=profile,
					meta=extra_meta,
				)
			)

	for index, chunk in enumerate(chunks):
		chunk.chunk_index = index
	strategy_counts = Counter(str(chunk.split_strategy) for chunk in chunks)
	doc.parser_report.metrics["chunking"] = {
		"policy_version": profile.policy_version,
		"profile": profile.name,
		"chunk_count": len(chunks),
		"strategies": dict(strategy_counts),
		"fallback_count": sum(
			1 for chunk in chunks if "fallback" in str(chunk.meta.get("split_reason") or "")
		),
	}
	return chunks


@dataclass
class _Section:
	section_path: str | None
	heading_text: str | None
	body_text: str
	node_ids: list[str]
	special_nodes: list[Node]
	page_start: int | None = None
	page_end: int | None = None
	force_page_strategy: bool = False


def _split_into_sections(nodes: list[Node], *, boundary_level: int) -> list[_Section]:
	sections: list[_Section] = []
	current_path: str | None = None
	current_heading: str | None = None
	body_parts: list[str] = []
	node_ids: list[str] = []
	special: list[Node] = []
	page_start: int | None = None
	page_end: int | None = None
	force_page = False

	def flush() -> None:
		nonlocal body_parts, node_ids, special, page_start, page_end, force_page
		if not body_parts and not special:
			return
		sections.append(
			_Section(
				section_path=current_path,
				heading_text=current_heading,
				body_text="\n\n".join(body_parts),
				node_ids=list(node_ids),
				special_nodes=list(special),
				page_start=page_start,
				page_end=page_end,
				force_page_strategy=force_page,
			)
		)
		body_parts = []
		node_ids = []
		special = []
		page_start = None
		page_end = None
		force_page = False

	for node in nodes:
		# 任意级别标题都先 flush：同级 ### 若只改 path 不切段，会把上一节正文挂到下一节路径上
		# （例：CMSTOP 正文被标成「…/璞华」）。boundary_level 仅影响「是否把标题行写入 body」。
		if node.type == NodeType.HEADING and node.level is not None:
			flush()
			current_path = node.path
			current_heading = node.text
			node_ids.append(node.id)
			page_start = node.page_start
			page_end = node.page_end if node.page_end is not None else node.page_start
			# 深于 boundary 的标题保留在正文里，便于检索看到小节名
			if node.level > boundary_level and node.text:
				body_parts.append(node.text)
			continue

		if node.type in {NodeType.TABLE, NodeType.CODE}:
			special.append(node)
			node_ids.append(node.id)
			page_start, page_end = _extend_pages(page_start, page_end, node)
			continue

		if node.type == NodeType.PAGE:
			# 每页独立 section，避免跨页硬切与错误 page_label
			flush()
			current_path = node.path
			current_heading = node.path
			force_page = True
			page_start = node.page_start
			page_end = node.page_end or node.page_start
			if node.text.strip():
				body_parts.append(node.text.strip())
			node_ids.append(node.id)
			# 页内嵌套的 meta 子内容已扁平化进 text
			continue

		if node.text.strip():
			body_parts.append(node.text.strip())
		node_ids.append(node.id)
		page_start, page_end = _extend_pages(page_start, page_end, node)

	flush()
	return sections


def _extend_pages(
	page_start: int | None,
	page_end: int | None,
	node: Node,
) -> tuple[int | None, int | None]:
	ps = node.page_start
	pe = node.page_end if node.page_end is not None else node.page_start
	if ps is None:
		return page_start, page_end
	new_start = ps if page_start is None else min(page_start, ps)
	new_end = pe if page_end is None else max(page_end, pe or ps)
	return new_start, new_end


def _make_chunk(
	*,
	index: int,
	body: str,
	preamble: str,
	doc: DocumentIR,
	section_path: str | None,
	heading_text: str | None,
	page_start: int | None,
	page_end: int | None,
	node_ids: list[str],
	decision: ChunkDecision,
	profile: ChunkingProfile,
	meta: dict | None = None,
) -> Chunk:
	chunk_meta = decision_metadata(decision, profile)
	chunk_meta.update(meta or {})
	chunk = Chunk(
		chunk_index=index,
		text="",
		body=body,
		preamble=preamble,
		section_path=section_path,
		heading_text=heading_text,
		page_start=page_start,
		page_end=page_end,
		page_label=format_page_label(page_start, page_end),
		node_ids=list(node_ids),
		split_strategy=decision.strategy,
		source_format=doc.source_format,
		content_hash=doc.content_hash or doc.content_fingerprint(),
		meta=chunk_meta,
	)
	chunk.text = chunk.embed_text()
	return chunk


def _recursive_split(text: str, *, chunk_size: int, overlap: int) -> list[str]:
	cleaned = text.strip()
	if not cleaned:
		return []
	if len(cleaned) <= chunk_size:
		return [cleaned]

	parts = _split_by_separators(cleaned, list(_RECURSIVE_SEPARATORS), chunk_size)
	if not parts:
		return []

	# 合并过小片段，再按 overlap 滑窗
	merged: list[str] = []
	buf = ""
	for part in parts:
		candidate = f"{buf}{part}" if not buf else f"{buf}{part}"
		if len(candidate) <= chunk_size:
			buf = candidate
			continue
		if buf.strip():
			merged.append(buf.strip())
		if len(part) <= chunk_size:
			buf = part
		else:
			# 单段仍超长 → char window
			for piece in chunk_text(part, chunk_size=chunk_size, chunk_overlap=overlap):
				merged.append(piece.text)
			buf = ""
	if buf.strip():
		merged.append(buf.strip())

	if len(merged) <= 1:
		return merged

	# 简单 overlap：从前一块尾部借字
	if overlap <= 0:
		return merged
	out: list[str] = []
	for i, piece in enumerate(merged):
		if i == 0:
			out.append(piece)
			continue
		prev = merged[i - 1]
		prefix = prev[-overlap:] if len(prev) > overlap else prev
		combined = f"{prefix}{piece}" if not piece.startswith(prefix) else piece
		out.append(combined[: chunk_size + overlap].strip() or piece)
	return out


def _split_by_separators(text: str, separators: list[str], chunk_size: int) -> list[str]:
	if not separators:
		return [text]
	sep = separators[0]
	rest = separators[1:]
	if sep not in text:
		return _split_by_separators(text, rest, chunk_size) if rest else [text]

	raw_parts = text.split(sep)
	# 保留分隔符语义：句号等贴回前段
	pieces: list[str] = []
	for i, part in enumerate(raw_parts):
		if not part and i < len(raw_parts) - 1:
			continue
		suffix = sep if i < len(raw_parts) - 1 and sep.strip() else (sep if i < len(raw_parts) - 1 else "")
		pieces.append(f"{part}{suffix}")

	result: list[str] = []
	for piece in pieces:
		if len(piece) <= chunk_size:
			result.append(piece)
		elif rest:
			result.extend(_split_by_separators(piece, rest, chunk_size))
		else:
			result.append(piece)
	return [p for p in result if p.strip()]


def _table_json_to_text(table_json: dict | list) -> str:
	if isinstance(table_json, list):
		return "\n".join(" | ".join(str(c) for c in row) for row in table_json)
	headers = table_json.get("headers") or []
	rows = table_json.get("rows") or []
	lines = [" | ".join(str(h) for h in headers)] if headers else []
	for row in rows:
		lines.append(" | ".join(str(c) for c in row))
	return "\n".join(lines)
