"""Ask generation 输出契约（Pydantic Phase 2）：answer + citations 对账。

策略（fail-safe，与现网 ask 一致：不因坏引用整答 500）：
- 结构化 JSON → ``GenerationOutput.model_validate``
- 自由文本 → 保留答案文本，citations 用后处理/检索集
- 每个 citation 的 ``id`` / ``record_id`` 必须落在本轮检索命中集；否则剔除并记日志
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from app.schemas import Citation

logger = logging.getLogger(__name__)


class GenerationOutput(BaseModel):
	"""Ask 生成出口契约：最终对用户可见的 answer + citations。"""

	answer: str = ""
	citations: list[Citation] = Field(default_factory=list)


class CitationRef(BaseModel):
	"""LLM 结构化草稿中的轻量引用（解析后需 resolve 到命中集）。"""

	id: str | None = None
	record_id: str | None = None
	index: int | None = None


class StructuredGenerationDraft(BaseModel):
	"""LLM JSON 草稿边界：citations 可为完整对象或 CitationRef。"""

	answer: str = ""
	citations: list[dict[str, Any]] = Field(default_factory=list)


@dataclass(slots=True)
class GenerationReconcileResult:
	output: GenerationOutput
	dropped_ids: list[str] = field(default_factory=list)
	from_structured: bool = False

	@property
	def answer(self) -> str:
		return self.output.answer

	@property
	def citations(self) -> list[Citation]:
		return self.output.citations

	def debug_fields(self) -> dict[str, Any]:
		return {
			"dropped_count": len(self.dropped_ids),
			"dropped_ids": list(self.dropped_ids),
			"kept_count": len(self.output.citations),
			"from_structured": self.from_structured,
		}


def hit_identity_keys(hit: dict[str, Any] | Citation) -> set[str]:
	"""与 Phase 1 payload / 检索 hit 对齐的对账键：point ``id`` + ``record_id``。"""
	data = hit.model_dump() if isinstance(hit, Citation) else hit
	keys: set[str] = set()
	for key in ("id", "record_id"):
		raw = data.get(key)
		if raw is None:
			continue
		value = str(raw).strip()
		if value:
			keys.add(value)
	return keys


def build_hit_allowlist(hits: list[dict[str, Any] | Citation]) -> set[str]:
	allowed: set[str] = set()
	for hit in hits:
		allowed |= hit_identity_keys(hit)
	return allowed


def index_hits_by_identity(hits: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
	by_key: dict[str, dict[str, Any]] = {}
	for hit in hits:
		for key in hit_identity_keys(hit):
			by_key.setdefault(key, hit)
	return by_key


def _opt_float(item: dict[str, Any], key: str) -> float | None:
	raw = item.get(key)
	if raw is None:
		return None
	try:
		return float(raw)
	except (TypeError, ValueError):
		return None


def citation_from_hit(item: dict[str, Any], *, index: int | None = None) -> Citation:
	"""把检索 hit / 原始 citation dict 收成 Citation（与 ask_graph 字段对齐）。"""
	full_text = str(item.get("body") or item.get("text") or item.get("snippet") or "")
	snippet = str(item.get("snippet") or full_text[:280])
	resolved_index = int(index if index is not None else item.get("index") or 1)
	score_raw = item.get("score")
	try:
		score = max(0.0, min(1.0, float(score_raw if score_raw is not None else 0.0)))
	except (TypeError, ValueError):
		score = 0.0
	cid = str(item.get("id") or item.get("record_id") or f"cite-{resolved_index}")
	return Citation.model_validate(
		{
			"id": cid,
			"index": resolved_index,
			"title": str(item.get("title") or "资料"),
			"page": item.get("page"),
			"page_start": item.get("page_start"),
			"page_end": item.get("page_end"),
			"section_path": item.get("section_path"),
			"preamble": item.get("preamble"),
			"table_id": item.get("table_id"),
			"row_start": item.get("row_start"),
			"row_end": item.get("row_end"),
			"headers": item.get("headers") or [],
			"rows": item.get("rows") or [],
			"snippet": snippet,
			"text": full_text,
			"body": full_text,
			"score": score,
			"dense_score": _opt_float(item, "dense_score"),
			"bm25_score": _opt_float(item, "bm25_score"),
			"rrf_score": _opt_float(item, "rrf_score"),
			"used_rerank": bool(item.get("used_rerank")),
			"used_hybrid": bool(item.get("used_hybrid")),
			"doc_id": item.get("doc_id"),
			"chunk_index": item.get("chunk_index"),
			"filename": item.get("filename"),
			"document_version_id": item.get("document_version_id"),
			"generation_id": item.get("generation_id"),
			"tenant_id": item.get("tenant_id"),
			"record_type": item.get("record_type"),
			"record_id": item.get("record_id"),
			"source_chunk_ids": item.get("source_chunk_ids") or [],
			"source_node_ids": item.get("source_node_ids") or [],
		}
	)


def try_parse_structured_generation(raw: str | dict[str, Any]) -> StructuredGenerationDraft | None:
	"""若 LLM 已返回 JSON/结构化，在边界解析；否则返回 None（走自由文本路径）。"""
	if isinstance(raw, dict):
		data = raw
	else:
		text = (raw or "").strip()
		if not text.startswith("{") or "answer" not in text:
			return None
		try:
			parsed = json.loads(text)
		except (json.JSONDecodeError, TypeError):
			return None
		if not isinstance(parsed, dict):
			return None
		data = parsed
	if "answer" not in data:
		return None
	try:
		return StructuredGenerationDraft.model_validate(data)
	except ValidationError:
		return None


def _is_citation_ref(data: dict[str, Any]) -> bool:
	"""无正文/标题等展示字段时视为轻量 ref，需从命中集 resolve。"""
	return not (
		data.get("title")
		or data.get("snippet")
		or data.get("body")
		or data.get("text")
		or data.get("score") is not None
	)


def _resolve_from_hits(
	data: dict[str, Any],
	*,
	hits: list[dict[str, Any]],
	hits_by_key: dict[str, dict[str, Any]],
) -> Citation | None:
	for key in ("id", "record_id"):
		value = data.get(key)
		if value is None:
			continue
		hit = hits_by_key.get(str(value).strip())
		if hit is not None:
			return citation_from_hit(hit, index=data.get("index"))
	index = data.get("index")
	if index is not None:
		try:
			wanted = int(index)
		except (TypeError, ValueError):
			return None
		for hit in hits:
			try:
				if int(hit.get("index") or -1) == wanted:
					return citation_from_hit(hit, index=wanted)
			except (TypeError, ValueError):
				continue
	return None


def _resolve_proposed_citation(
	raw: dict[str, Any] | Citation,
	*,
	hits: list[dict[str, Any]],
	hits_by_key: dict[str, dict[str, Any]],
	allowed: set[str],
) -> tuple[Citation | None, str | None]:
	"""返回 (citation, drop_id)。合法则第二项为 None。"""
	if isinstance(raw, Citation):
		data = raw.model_dump()
	else:
		data = dict(raw)

	drop_label = str(
		data.get("id") or data.get("record_id") or data.get("index") or "<unknown>"
	)

	if _is_citation_ref(data):
		resolved = _resolve_from_hits(
			data, hits=hits, hits_by_key=hits_by_key
		)
		if resolved is None:
			return None, drop_label
		return resolved, None

	try:
		citation = citation_from_hit(data)
	except ValidationError:
		return None, drop_label

	cite_keys = hit_identity_keys(citation)
	if not allowed or not cite_keys or cite_keys.isdisjoint(allowed):
		return None, citation.id or citation.record_id or drop_label
	return citation, None


def reconcile_generation_output(
	*,
	answer: str | dict[str, Any],
	citations: list[dict[str, Any] | Citation] | None = None,
	allowed_hits: list[dict[str, Any]] | None = None,
) -> GenerationReconcileResult:
	"""校验并对账 generation 出口；非法引用剔除并记录，答案保留。"""
	hits = list(allowed_hits or [])
	allowed = build_hit_allowlist(hits)
	hits_by_key = index_hits_by_identity(hits)

	from_structured = False
	proposed: list[dict[str, Any] | Citation]
	resolved_answer: str

	draft = try_parse_structured_generation(answer)
	if draft is not None:
		from_structured = True
		resolved_answer = draft.answer
		proposed = list(draft.citations)
	elif isinstance(answer, dict):
		# dict 但不构成草稿：尽量取 answer 字段，避免 500
		resolved_answer = str(answer.get("answer") or "")
		proposed = list(citations or answer.get("citations") or [])
	else:
		resolved_answer = str(answer or "")
		proposed = list(citations or [])

	kept: list[Citation] = []
	dropped: list[str] = []
	seen: set[str] = set()

	for raw in proposed:
		citation, drop_id = _resolve_proposed_citation(
			raw,
			hits=hits,
			hits_by_key=hits_by_key,
			allowed=allowed,
		)
		if citation is None:
			if drop_id is not None:
				dropped.append(str(drop_id))
			continue
		dedupe_key = citation.record_id or citation.id
		if dedupe_key in seen:
			continue
		seen.add(dedupe_key)
		kept.append(citation)

	for index, item in enumerate(kept, start=1):
		item.index = index

	if dropped:
		logger.warning(
			"generation.citation_reconcile dropped=%s kept=%s from_structured=%s",
			dropped,
			[c.record_id or c.id for c in kept],
			from_structured,
		)

	output = GenerationOutput(answer=resolved_answer, citations=kept)
	# 最终边界再走一次 model_validate，保证契约闭合
	output = GenerationOutput.model_validate(output.model_dump())
	return GenerationReconcileResult(
		output=output,
		dropped_ids=dropped,
		from_structured=from_structured,
	)
