"""Retrieval executor — in-memory Qdrant + deterministic embeddings."""

from __future__ import annotations

import hashlib
import math

from app.eval.assertions import check_expect
from app.eval.fixtures import load_ir_for_fixture
from app.eval.schemas import EvalCase, EvalCaseResult


def deterministic_vector(text: str, *, dimensions: int = 128) -> list[float]:
	"""CI 用确定性字符/二元组向量，不调用外部 embedding 服务。"""
	compact = "".join(char.lower() for char in text if not char.isspace())
	tokens = list(compact)
	tokens.extend(compact[index : index + 2] for index in range(max(0, len(compact) - 1)))
	vector = [0.0] * dimensions
	for token in tokens:
		digest = hashlib.sha256(token.encode("utf-8")).digest()
		index = int.from_bytes(digest[:4], "big") % dimensions
		vector[index] += 1.0
	norm = math.sqrt(sum(value * value for value in vector))
	return [value / norm for value in vector] if norm else vector


def run_retrieval(case: EvalCase) -> EvalCaseResult:
	"""真实经过 QdrantStore + RetrievalService 的本地可重复检索回归。

	默认指标是 Recall@K（K=expect.recall_at_k 或 3）：目标片段出现在前 K 条即算命中。
	可用 expect.max_rank 收紧名次（1-based）。
	"""
	from qdrant_client import QdrantClient

	from app.services.ingest.chunker import chunk_document
	from app.services.ingest.pipeline import chunks_to_payloads
	from app.services.qdrant_store import QdrantStore
	from app.services.retrieval import RetrievalService
	from app.settings import Settings

	fixture_name = case.fixture or "handbook.md"
	doc = load_ir_for_fixture(fixture_name)
	chunks = chunk_document(doc)
	record_type = str(case.expect.record_type or "chunk")
	payloads = chunks_to_payloads(
		chunks,
		filename=doc.filename or fixture_name,
		doc_id=doc.id,
		library_id=case.library_id or "lib-eval",
		document_version_id=f"eval-{case.id}-version",
		generation_id=f"eval-{case.id}-generation",
		lifecycle_visibility="active",
		include_sections=True,
	)
	# fact 隔离：只 upsert 所需粒度时仍写入全部，靠 search filter 验证 section 不进 fact
	dimensions = 128
	recall_at_k = int(case.expect.recall_at_k or 3)
	settings = Settings(
		ask_mode="stub",
		embedding_dim=dimensions,
		qdrant_collection=f"eval_{case.id.replace('-', '_')}",
		rerank_top_k=recall_at_k,
		bm25_top_k=recall_at_k,
	)

	class _EvalEmbeddings:
		def embed_query(self, text: str) -> list[float]:
			return deterministic_vector(text, dimensions=dimensions)

		def embed_texts(self, texts: list[str]) -> list[list[float]]:
			return [deterministic_vector(text, dimensions=dimensions) for text in texts]

	client = QdrantClient(location=":memory:")
	try:
		store = QdrantStore(settings, client=client)
		store.upsert_chunks(
			library_id=case.library_id or "lib-eval",
			doc_id=doc.id,
			title=doc.title or fixture_name,
			chunks=payloads,
			vectors=[
				deterministic_vector(str(item.get("embed_text") or item.get("text") or ""), dimensions=dimensions)
				for item in payloads
			],
			filename=doc.filename or fixture_name,
		)
		service = RetrievalService(
			settings,
			embeddings=_EvalEmbeddings(),  # type: ignore[arg-type]
			store=store,
			reranker=None,
		)
		hits = service.search(
			query=case.question,
			library_id=case.library_id or "lib-eval",
			top_k=recall_at_k,
			record_type=record_type,
			filters={"record_type": record_type},
		)
	finally:
		client.close()

	top = hits[0] if hits else None
	body_substr = (case.expect.body_substr or "").strip()
	section_substr = (case.expect.section_substr or "").strip()
	observed_rank: int | None = None
	matched = None
	for index, item in enumerate(hits, start=1):
		body = str(item.get("body") or "")
		section = str(item.get("section_path") or "")
		body_ok = (not body_substr) or (body_substr in body)
		section_ok = (not section_substr) or (section_substr in section)
		if body_ok and section_ok and (body_substr or section_substr):
			observed_rank = index
			matched = item
			break
		if not body_substr and not section_substr and index == 1:
			observed_rank = 1
			matched = item
			break

	chosen = matched or top
	mrr = (1.0 / observed_rank) if observed_rank else 0.0
	# fact 隔离：chunk 检索结果中不得出现 section 记录
	polluted = [
		item for item in hits if str(item.get("record_type") or "") == "section"
	] if record_type == "chunk" else []
	observed = {
		"body": chosen.get("body") if chosen else None,
		"section_path": chosen.get("section_path") if chosen else None,
		"document_version_id": chosen.get("document_version_id") if chosen else None,
		"record_type": (chosen.get("record_type") if chosen else None) or record_type,
		"source_chunk_ids": chosen.get("source_chunk_ids") if chosen else None,
		"hit_count": len(hits),
		"recall_at_k": recall_at_k,
		"recall_hit": observed_rank is not None,
		"observed_rank": observed_rank,
		"mrr": mrr,
		"metric": f"Recall@{recall_at_k}",
		"section_pollution_count": len(polluted),
	}
	errors = check_expect(case.expect, observed)
	if top is None:
		errors.append("retrieval returned no hits")
	elif (body_substr or section_substr) and matched is None:
		errors.append(
			f"Recall@{recall_at_k} miss: no hit contains "
			f"body={body_substr!r} section={section_substr!r}"
		)
	elif chosen and not observed["document_version_id"]:
		errors.append("retrieval hit missing document_version_id")
	if record_type == "chunk" and polluted:
		errors.append("section records leaked into chunk retrieval")
	if record_type == "section" and chosen and not (chosen.get("source_chunk_ids") or []):
		errors.append("section hit missing source_chunk_ids")
	return EvalCaseResult(
		id=case.id,
		ok=not errors,
		kind=case.kind,
		errors=errors,
		observed=observed,
	)
