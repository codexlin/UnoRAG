from __future__ import annotations

import logging
import math
import re
import threading
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any, Callable

logger = logging.getLogger(__name__)

_WORD_RE = re.compile(r"[a-z0-9_]+", re.IGNORECASE)
_CJK_RE = re.compile(r"[\u4e00-\u9fff]+")


def chunk_key(doc_id: str, chunk_index: int) -> str:
	return f"{doc_id}:{chunk_index}"


def tokenize(text: str) -> list[str]:
	"""Lightweight tokenizer for mixed Chinese / English BM25 (no jieba)."""
	if not text:
		return []
	lowered = text.lower()
	tokens: list[str] = []
	tokens.extend(_WORD_RE.findall(lowered))
	for span in _CJK_RE.findall(lowered):
		tokens.extend(list(span))
		if len(span) >= 2:
			tokens.extend(span[i : i + 2] for i in range(len(span) - 1))
	return tokens


def reciprocal_rank_fusion(
	ranked_lists: list[list[str]],
	*,
	k: int = 60,
) -> list[tuple[str, float]]:
	scores: dict[str, float] = defaultdict(float)
	for ranked in ranked_lists:
		for rank, key in enumerate(ranked, start=1):
			scores[key] += 1.0 / (k + rank)
	return sorted(scores.items(), key=lambda item: item[1], reverse=True)


class BM25Index:
	"""Okapi BM25 with Lucene-style IDF (stable on small corpora)."""

	def __init__(self, corpus: list[list[str]], *, k1: float = 1.5, b: float = 0.75) -> None:
		self.k1 = k1
		self.b = b
		self.corpus = corpus
		self.doc_count = len(corpus)
		self.doc_len = [len(doc) for doc in corpus]
		self.avgdl = (sum(self.doc_len) / self.doc_count) if self.doc_count else 0.0
		self.doc_freqs: list[Counter[str]] = [Counter(doc) for doc in corpus]
		df: Counter[str] = Counter()
		for freqs in self.doc_freqs:
			for token in freqs:
				df[token] += 1
		self.idf = {
			token: math.log(1.0 + (self.doc_count - freq + 0.5) / (freq + 0.5))
			for token, freq in df.items()
		}

	def get_scores(self, query_tokens: list[str]) -> list[float]:
		if not self.doc_count:
			return []
		scores = [0.0] * self.doc_count
		query_tf = Counter(query_tokens)
		for token, qtf in query_tf.items():
			idf = self.idf.get(token)
			if idf is None:
				continue
			for index, freqs in enumerate(self.doc_freqs):
				tf = freqs.get(token)
				if not tf:
					continue
				denom = tf + self.k1 * (1.0 - self.b + self.b * self.doc_len[index] / (self.avgdl or 1.0))
				scores[index] += idf * ((tf * (self.k1 + 1.0)) / denom) * qtf
		return scores


@dataclass
class Bm25LibraryIndex:
	library_id: str
	chunks: list[dict[str, Any]]
	keys: list[str]
	tokenized: list[list[str]]
	bm25: BM25Index

	def search(self, query: str, top_k: int) -> list[dict[str, Any]]:
		tokens = tokenize(query)
		if not tokens or not self.keys:
			return []
		scores = self.bm25.get_scores(tokens)
		ranked = sorted(enumerate(scores), key=lambda item: item[1], reverse=True)
		results: list[dict[str, Any]] = []
		for index, score in ranked[:top_k]:
			if score <= 0:
				continue
			chunk = dict(self.chunks[index])
			chunk["score"] = float(score)
			chunk["key"] = self.keys[index]
			results.append(chunk)
		return results


class Bm25IndexCache:
	"""In-memory BM25 index per library, rebuilt from chunk loader."""

	def __init__(self) -> None:
		self._lock = threading.Lock()
		self._indexes: dict[str, Bm25LibraryIndex] = {}

	def invalidate(self, library_id: str) -> None:
		with self._lock:
			keys = [
				key
				for key in self._indexes
				if key == library_id or f":{library_id}:" in key
			]
			removed = [self._indexes.pop(key) for key in keys]
		if removed:
			logger.info(
				"bm25.cache.invalidate library_id=%s chunks=%s",
				library_id,
				sum(len(index.chunks) for index in removed),
			)

	def get_or_build(
		self,
		library_id: str,
		load_chunks: Callable[[], list[dict[str, Any]]],
	) -> Bm25LibraryIndex:
		with self._lock:
			cached = self._indexes.get(library_id)
			if cached is not None:
				return cached

		started = time.perf_counter()
		chunks = load_chunks()
		keys = [
			chunk_key(str(chunk["doc_id"]), int(chunk["chunk_index"])) for chunk in chunks
		]
		tokenized = [tokenize(str(chunk.get("text", ""))) for chunk in chunks]
		index = Bm25LibraryIndex(
			library_id=library_id,
			chunks=chunks,
			keys=keys,
			tokenized=tokenized,
			bm25=BM25Index(tokenized),
		)
		with self._lock:
			self._indexes[library_id] = index
		logger.info(
			"bm25.cache.build library_id=%s chunks=%s duration_ms=%.1f",
			library_id,
			len(chunks),
			(time.perf_counter() - started) * 1000,
		)
		return index


def fuse_dense_and_bm25(
	*,
	dense_hits: list[dict[str, Any]],
	bm25_hits: list[dict[str, Any]],
	rrf_k: int,
	limit: int,
) -> list[dict[str, Any]]:
	by_key: dict[str, dict[str, Any]] = {}
	dense_keys: list[str] = []
	bm25_keys: list[str] = []

	for hit in dense_hits:
		key = chunk_key(str(hit["doc_id"]), int(hit["chunk_index"]))
		dense_keys.append(key)
		merged = dict(hit)
		merged["key"] = key
		merged["dense_score"] = float(hit.get("score", 0.0))
		merged["bm25_score"] = None
		by_key[key] = merged

	for hit in bm25_hits:
		key = chunk_key(str(hit["doc_id"]), int(hit["chunk_index"]))
		bm25_keys.append(key)
		if key in by_key:
			by_key[key]["bm25_score"] = float(hit.get("score", 0.0))
		else:
			merged = dict(hit)
			merged["key"] = key
			merged["dense_score"] = None
			merged["bm25_score"] = float(hit.get("score", 0.0))
			by_key[key] = merged

	fused = reciprocal_rank_fusion([dense_keys, bm25_keys], k=rrf_k)
	results: list[dict[str, Any]] = []
	for key, rrf_score in fused[:limit]:
		hit = by_key[key]
		hit["rrf_score"] = float(rrf_score)
		hit["score"] = float(rrf_score)
		results.append(hit)
	return results


_bm25_cache = Bm25IndexCache()


def get_bm25_cache() -> Bm25IndexCache:
	return _bm25_cache
