"""Citation adjudication（裁决）: wide recall → weigh hits → display/context 同源 top_k.

Decisions align with ask routing language: keep / upgrade / refuse at the Ask
layer; this module filters retrieval hits so generation context and returned
citations are the same set.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from app.settings import Settings

_QUERY_NOISE = (
	"是多少",
	"是什么",
	"怎么算",
	"如何",
	"怎样",
	"请问",
	"一下",
	"多少天",
	"多少",
	"什么",
	"哪些",
	"哪个",
	"吗",
	"呢",
	"？",
	"?",
)

_WORD_RE = re.compile(r"[a-z0-9][a-z0-9_.+-]{1,31}|[\u3400-\u9fff]{2,16}", re.IGNORECASE)


def _normalized(value: str) -> str:
	return "".join(re.findall(r"[a-z0-9\u3400-\u9fff]+", value.lower()))


def query_terms(query: str) -> list[str]:
	"""Deterministic lexical terms (no jieba); mirrors SAG query_terms."""
	cleaned = query.strip().lower()
	for phrase in _QUERY_NOISE:
		cleaned = cleaned.replace(phrase, " ")
	terms: list[str] = []
	for candidate in _WORD_RE.findall(cleaned):
		value = candidate.strip()
		if value and not value.isdigit() and value not in terms:
			terms.append(value)
	return terms[:4]


def wide_recall_limit(top_k: int, settings: Settings | None = None) -> int:
	"""Candidate pool size before citation adjudication.

	Formula: min(50, max(top_k*3, top_k+8)); if rerank is on, also honor rerank_top_k.
	"""
	k = max(1, int(top_k))
	formula = min(50, max(k * 3, k + 8))
	if settings is not None and settings.rerank_enabled:
		formula = max(formula, int(settings.rerank_top_k))
	return max(k, min(50, formula))


def lexical_relevance(query: str, hit: dict[str, Any]) -> float:
	"""Cheap lexical overlap score in [0, 1]."""
	heading = _normalized(
		" ".join(
			str(part)
			for part in (hit.get("title"), hit.get("section_path"), hit.get("preamble"))
			if part
		)
	)
	content = _normalized(str(hit.get("body") or hit.get("text") or hit.get("snippet") or ""))
	text = f"{heading}{content}"
	if not text:
		return 0.0

	terms = [_normalized(term) for term in query_terms(query)]
	terms = [term for term in terms if term]
	cleaned_query = query
	for phrase in _QUERY_NOISE:
		cleaned_query = cleaned_query.replace(phrase, " ")
	phrase = _normalized(cleaned_query)

	score = 0.0
	if phrase and len(phrase) >= 2 and phrase in text:
		score += 0.55
		if phrase in heading:
			score += 0.2
	if terms:
		matched = sum(term in text for term in terms)
		heading_matched = sum(term in heading for term in terms)
		score += 0.35 * matched / len(terms)
		score += 0.15 * heading_matched / len(terms)
	return min(1.0, score)


def _hit_key(hit: dict[str, Any]) -> str:
	return str(
		hit.get("record_id")
		or hit.get("id")
		or (
			hit.get("doc_id"),
			hit.get("table_id"),
			hit.get("record_type"),
			hit.get("chunk_index"),
			hit.get("row_start"),
		)
	)


def _raw_score(hit: dict[str, Any]) -> float:
	try:
		return max(0.0, min(1.0, float(hit.get("score") or 0.0)))
	except (TypeError, ValueError):
		return 0.0


def _bm25_signal(hit: dict[str, Any]) -> float | None:
	raw = hit.get("bm25_score")
	if raw is None:
		return None
	try:
		return float(raw)
	except (TypeError, ValueError):
		return None


@dataclass(frozen=True, slots=True)
class CitationAdjudicateResult:
	citations: list[dict[str, Any]]
	candidates_count: int
	relevant_count: int
	filtered_irrelevant: int
	citation_adjudication: dict[str, Any]


def apply_citation_adjudicate(
	query: str,
	candidates: list[dict[str, Any]],
	*,
	top_k: int,
	settings: Settings,
	enabled: bool | None = None,
) -> CitationAdjudicateResult:
	"""Weigh hits, drop low-relevance tails, truncate to top_k (context ≡ citations)."""
	limit = max(1, int(top_k))
	adjudicate_on = (
		bool(settings.citation_adjudicate_enabled)
		if enabled is None
		else bool(enabled)
	)
	absolute = float(settings.citation_adjudicate_absolute_floor)
	if absolute <= 0:
		absolute = (
			float(settings.answer_min_score) if settings.answer_min_score > 0 else 0.35
		)
	ratio = float(settings.citation_adjudicate_ratio)
	lexical_threshold = float(settings.citation_adjudicate_lexical_threshold)

	if not candidates:
		summary = {
			"enabled": adjudicate_on,
			"mode": "empty",
			"absolute_floor": absolute,
			"ratio": ratio,
			"semantic_floor": None,
			"has_lexical_signal": False,
			"kept_fallback_top": False,
		}
		return CitationAdjudicateResult([], 0, 0, 0, summary)

	merged: dict[str, dict[str, Any]] = {}
	for item in candidates:
		key = _hit_key(item)
		prev = merged.get(key)
		if prev is None or _raw_score(item) > _raw_score(prev):
			merged[key] = dict(item)
	pool = sorted(merged.values(), key=_raw_score, reverse=True)
	candidate_count = len(pool)
	top_raw = _raw_score(pool[0])
	semantic_floor = max(absolute, top_raw * ratio)

	if not adjudicate_on:
		selected = pool[:limit]
		summary = {
			"enabled": False,
			"mode": "passthrough",
			"absolute_floor": absolute,
			"ratio": ratio,
			"semantic_floor": round(semantic_floor, 6),
			"has_lexical_signal": False,
			"kept_fallback_top": False,
			"wide_limit": candidate_count,
			"final_top_k": limit,
		}
		return CitationAdjudicateResult(
			selected,
			candidate_count,
			len(selected),
			max(0, candidate_count - len(selected)),
			summary,
		)

	lexical_scores = {_hit_key(hit): lexical_relevance(query, hit) for hit in pool}
	bm25_values = [_bm25_signal(hit) for hit in pool]
	has_bm25 = any(v is not None and v > 0 for v in bm25_values)
	max_bm25 = max((v for v in bm25_values if v is not None), default=0.0) or 0.0
	has_lexical_signal = has_bm25 or any(
		score >= lexical_threshold for score in lexical_scores.values()
	)

	relevant: list[dict[str, Any]] = []
	for hit in pool:
		key = _hit_key(hit)
		raw = _raw_score(hit)
		lex = lexical_scores.get(key, 0.0)
		bm25 = _bm25_signal(hit)
		bm25_ok = False
		if has_bm25 and bm25 is not None and max_bm25 > 0:
			bm25_ok = (bm25 / max_bm25) >= 0.35 or bm25 > 0 and lex >= lexical_threshold
		hybrid_ok = bool(hit.get("rrf_score")) and raw >= absolute and (
			bm25_ok or lex >= lexical_threshold
		)

		if has_lexical_signal:
			keep = bm25_ok or lex >= lexical_threshold or hybrid_ok
		else:
			keep = raw >= semantic_floor
		if keep:
			relevant.append(hit)

	kept_fallback = False
	if not relevant:
		relevant = [pool[0]]
		kept_fallback = True

	selected = relevant[:limit]
	mode = "lexical" if has_lexical_signal else "semantic_floor"
	summary = {
		"enabled": True,
		"mode": mode,
		"absolute_floor": absolute,
		"ratio": ratio,
		"semantic_floor": round(semantic_floor, 6),
		"lexical_threshold": lexical_threshold,
		"has_lexical_signal": has_lexical_signal,
		"has_bm25_signal": has_bm25,
		"kept_fallback_top": kept_fallback,
		"wide_limit": candidate_count,
		"final_top_k": limit,
		"top_score": round(top_raw, 6),
	}
	return CitationAdjudicateResult(
		citations=selected,
		candidates_count=candidate_count,
		relevant_count=len(relevant),
		filtered_irrelevant=max(0, candidate_count - len(relevant)),
		citation_adjudication=summary,
	)


def adjudicate_debug_fields(result: CitationAdjudicateResult) -> dict[str, Any]:
	"""Fields to merge into retrieval_debug."""
	return {
		"candidates_count": result.candidates_count,
		"filtered_irrelevant": result.filtered_irrelevant,
		"relevant_count": result.relevant_count,
		"citation_adjudication": result.citation_adjudication,
	}
