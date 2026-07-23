"""L3 structure-aware chunker.

策略优先级（非 SemanticChunker）：
1. heading 子树切（不跨同级/更高级标题）
2. table / code 独立块
3. 节点内 recursive / 字窗 fallback（记 split_strategy）
"""

from __future__ import annotations

from dataclasses import dataclass

from app.services.chunking import chunk_text
from app.services.ingest.ir import (
	Chunk,
	DocumentIR,
	Node,
	NodeType,
	SplitStrategy,
	build_preamble,
	format_page_label,
)

# 句级/段级分隔：中文制度文档常见边界
_RECURSIVE_SEPARATORS = ("\n\n", "\n", "。", "；", "！", "？", ". ", "; ", " ")


@dataclass
class ChunkerConfig:
	chunk_size: int = 500
	chunk_overlap: int = 80
	# heading 切片：以不超过该 level 的 heading 作为块边界（默认 H2）
	heading_boundary_level: int = 2


def chunk_document(doc: DocumentIR, *, config: ChunkerConfig | None = None) -> list[Chunk]:
	cfg = config or ChunkerConfig()
	if not doc.nodes:
		return []

	# 按 heading 边界分组：同组共享 section_path
	sections = _split_into_sections(doc.nodes, boundary_level=cfg.heading_boundary_level)
	chunks: list[Chunk] = []
	index = 0

	for section in sections:
		section_path = section.section_path
		heading_text = section.heading_text
		page_start = section.page_start
		page_end = section.page_end

		# 表 / 代码：专用策略，独立 chunk，不做 embedding 语义切
		for node in section.special_nodes:
			body = (node.text or "").strip()
			if not body and not node.table_json:
				continue
			if node.type == NodeType.TABLE and node.table_json and not body:
				body = _table_json_to_text(node.table_json)
			preamble = build_preamble(
				title=doc.title,
				section_path=section_path,
				heading_text=heading_text,
				page_start=node.page_start or page_start,
				page_end=node.page_end or page_end,
			)
			strategy = SplitStrategy.TABLE if node.type == NodeType.TABLE else SplitStrategy.CODE
			ps = node.page_start if node.page_start is not None else page_start
			pe = node.page_end if node.page_end is not None else page_end
			meta: dict = {}
			if node.type == NodeType.TABLE and isinstance(node.table_json, dict):
				meta["headers"] = [str(h) for h in (node.table_json.get("headers") or [])]
				meta["rows"] = [
					[str(c) for c in row] for row in (node.table_json.get("rows") or [])
				]
			chunks.append(
				Chunk(
					chunk_index=index,
					text="",  # filled below
					body=body,
					preamble=preamble,
					section_path=section_path,
					heading_text=heading_text,
					page_start=ps,
					page_end=pe,
					page_label=format_page_label(ps, pe),
					node_ids=[node.id],
					table_id=node.table_id,
					figure_id=node.figure_id,
					split_strategy=strategy,
					source_format=doc.source_format,
					content_hash=doc.content_hash or doc.content_fingerprint(),
					meta=meta,
				)
			)
			chunks[-1].text = chunks[-1].embed_text()
			index += 1

		body = section.body_text.strip()
		if not body:
			continue

		# 页级 PDF：优先保留页边界（page strategy）
		if section.force_page_strategy and len(body) <= cfg.chunk_size:
			preamble = build_preamble(
				title=doc.title,
				section_path=section_path,
				heading_text=heading_text,
				page_start=page_start,
				page_end=page_end,
			)
			chunks.append(
				_make_chunk(
					index=index,
					body=body,
					preamble=preamble,
					doc=doc,
					section_path=section_path,
					heading_text=heading_text,
					page_start=page_start,
					page_end=page_end,
					node_ids=section.node_ids,
					strategy=SplitStrategy.PAGE,
				)
			)
			index += 1
			continue

		if len(body) <= cfg.chunk_size:
			preamble = build_preamble(
				title=doc.title,
				section_path=section_path,
				heading_text=heading_text,
				page_start=page_start,
				page_end=page_end,
			)
			strategy = (
				SplitStrategy.HEADING
				if section_path
				else (SplitStrategy.PAGE if page_start is not None else SplitStrategy.RECURSIVE)
			)
			chunks.append(
				_make_chunk(
					index=index,
					body=body,
					preamble=preamble,
					doc=doc,
					section_path=section_path,
					heading_text=heading_text,
					page_start=page_start,
					page_end=page_end,
					node_ids=section.node_ids,
					strategy=strategy,
				)
			)
			index += 1
			continue

		# 超长：节点内 recursive → char_window fallback
		pieces = _recursive_split(body, chunk_size=cfg.chunk_size, overlap=cfg.chunk_overlap)
		strategy = SplitStrategy.RECURSIVE
		if not pieces:
			legacy = chunk_text(body, chunk_size=cfg.chunk_size, chunk_overlap=cfg.chunk_overlap)
			pieces = [p.text for p in legacy]
			strategy = SplitStrategy.CHAR_WINDOW

		for piece in pieces:
			preamble = build_preamble(
				title=doc.title,
				section_path=section_path,
				heading_text=heading_text,
				page_start=page_start,
				page_end=page_end,
			)
			chunks.append(
				_make_chunk(
					index=index,
					body=piece,
					preamble=preamble,
					doc=doc,
					section_path=section_path,
					heading_text=heading_text,
					page_start=page_start,
					page_end=page_end,
					node_ids=section.node_ids,
					strategy=strategy,
				)
			)
			index += 1

	# 重新编号，保证连续
	for i, chunk in enumerate(chunks):
		chunk.chunk_index = i
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
	strategy: SplitStrategy,
) -> Chunk:
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
		split_strategy=strategy,
		source_format=doc.source_format,
		content_hash=doc.content_hash or doc.content_fingerprint(),
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
