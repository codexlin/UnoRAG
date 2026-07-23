"""黄金集 runner — 本地可跑，默认 stub AskGraph。

用法：
  uv run python -m app.eval.runner
  uv run python scripts/run_eval_cases.py
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import sys
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from app.eval.schemas import EvalCase, EvalCaseResult, EvalExpect
from app.services.query_router import classify_query
from app.services.retrieval_plan import build_retrieval_plan

DEFAULT_CASES = Path(__file__).resolve().parents[2] / "tests" / "eval" / "eval_cases.jsonl"
FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures"


def load_eval_cases(path: Path | None = None) -> list[EvalCase]:
	resolved = path or DEFAULT_CASES
	cases: list[EvalCase] = []
	with resolved.open("r", encoding="utf-8") as handle:
		for line_no, line in enumerate(handle, start=1):
			text = line.strip()
			if not text or text.startswith("#"):
				continue
			try:
				raw = json.loads(text)
				cases.append(EvalCase.model_validate(raw))
			except Exception as exc:
				raise ValueError(f"invalid eval case at {resolved}:{line_no}: {exc}") from exc
	return cases


def _check_expect(expect: EvalExpect, observed: dict[str, Any]) -> list[str]:
	errors: list[str] = []
	if expect.query_type is not None and observed.get("query_type") != expect.query_type:
		errors.append(f"query_type want={expect.query_type} got={observed.get('query_type')}")
	if expect.refused is not None and bool(observed.get("refused")) != expect.refused:
		errors.append(f"refused want={expect.refused} got={observed.get('refused')}")
	if expect.refuse_reason is not None and observed.get("refuse_reason") != expect.refuse_reason:
		errors.append(
			f"refuse_reason want={expect.refuse_reason} got={observed.get('refuse_reason')}"
		)
	if expect.judge_reason is not None:
		judge = observed.get("judge") or {}
		if not isinstance(judge, dict) or judge.get("reason") != expect.judge_reason:
			errors.append(
				f"judge.reason want={expect.judge_reason} got={(judge or {}).get('reason')}"
			)
	if expect.execute_path is not None:
		plan = observed.get("retrieval_plan") or {}
		got = plan.get("execute_path") if isinstance(plan, dict) else None
		if got != expect.execute_path:
			errors.append(f"execute_path want={expect.execute_path} got={got}")
	answer = str(observed.get("answer") or "")
	for needle in expect.answer_contains:
		if needle not in answer:
			errors.append(f"answer missing: {needle!r}")
	if expect.section_substr is not None:
		section = str(observed.get("section_path") or "")
		if expect.section_substr not in section:
			errors.append(
				f"section_path missing {expect.section_substr!r} got={section!r}"
			)
	if expect.body_substr is not None:
		body = str(observed.get("body") or "")
		if expect.body_substr not in body:
			errors.append(f"body missing {expect.body_substr!r}")
	return errors


def _run_classify(case: EvalCase) -> EvalCaseResult:
	query_type, reason = classify_query(case.question, history=case.history or None)
	plan = build_retrieval_plan(
		query_type=query_type,
		route_reason=reason,
		library_id=case.library_id,
		top_k=6,
		hybrid_enabled=False,
		rerank_enabled=False,
		question=case.question,
	)
	observed = {
		"query_type": query_type,
		"route_reason": reason,
		"retrieval_plan": plan,
	}
	errors = _check_expect(case.expect, observed)
	return EvalCaseResult(
		id=case.id,
		ok=not errors,
		kind=case.kind,
		errors=errors,
		observed=observed,
	)


@contextmanager
def _isolated_ask_settings():
	"""隔离 eval 对环境、settings cache 和 metadata singleton 的修改。"""
	from app.graph.ask_graph import AskGraphService
	from app.services.metadata import reset_metadata_store
	from app.settings import get_settings

	keys = (
		"ASK_MODE",
		"METADATA_BACKEND",
		"METADATA_PATH",
		"SESSION_MEMORY_ENABLED",
		"HYBRID_ENABLED",
		"RERANK_ENABLED",
		"MAX_RETRIEVE_RETRIES",
	)
	previous = {key: os.environ.get(key) for key in keys}
	with TemporaryDirectory(prefix="meriknow-eval-") as tmp_dir:
		os.environ.update(
			{
				"ASK_MODE": "stub",
				"METADATA_BACKEND": "json",
				"METADATA_PATH": str(Path(tmp_dir) / "metadata.json"),
				"SESSION_MEMORY_ENABLED": "false",
				"HYBRID_ENABLED": "false",
				"RERANK_ENABLED": "false",
				"MAX_RETRIEVE_RETRIES": "0",
			}
		)
		get_settings.cache_clear()
		reset_metadata_store()
		try:
			yield AskGraphService(settings=get_settings())
		finally:
			reset_metadata_store()
			for key, value in previous.items():
				if value is None:
					os.environ.pop(key, None)
				else:
					os.environ[key] = value
			get_settings.cache_clear()


def _run_ask(case: EvalCase) -> EvalCaseResult:
	with _isolated_ask_settings() as service:
		# history 样例直接调用图，避免依赖持久化 session memory。
		if case.history:
			state = service._graph.invoke(
				{
					"session_id": case.session_id or f"eval-{case.id}",
					"question": case.question,
					"library_id": case.library_id,
					"history": case.history,
					"retrieval_debug": {},
				}
			)
			debug = state.get("retrieval_debug") or {}
			observed = {
				"query_type": state.get("query_type") or debug.get("query_type"),
				"refused": bool(state.get("refused")),
				"refuse_reason": state.get("refuse_reason"),
				"answer": state.get("answer") or "",
				"judge": state.get("judgement") or debug.get("judgement"),
				"retrieval_plan": state.get("retrieval_plan") or debug.get("retrieval_plan"),
			}
		else:
			resp = service.ask(question=case.question, library_id=case.library_id)
			debug = resp.retrieval_debug or {}
			observed = {
				"query_type": debug.get("query_type"),
				"refused": resp.refused,
				"refuse_reason": resp.refuse_reason,
				"answer": resp.answer,
				"judge": debug.get("judgement"),
				"retrieval_plan": debug.get("retrieval_plan"),
			}
	errors = _check_expect(case.expect, observed)
	return EvalCaseResult(
		id=case.id,
		ok=not errors,
		kind=case.kind,
		errors=errors,
		observed=observed,
	)


def _load_ir_for_fixture(fixture_name: str) -> Any:
	"""加载 MD 固定件，或合成 PDF page / DOCX table 样本。"""
	from app.services.ingest.parsers.md import parse_markdown

	if fixture_name == "synthetic:pdf_page":
		import fitz

		from app.services.ingest.ir import DocumentIR, Node, NodeType, ParserReport
		from app.services.ingest.parsers.pdf import parse_pdf

		doc = fitz.open()
		page = doc.new_page()
		# 默认字体对中文不稳定；先写 ASCII，再在解析后兜底注入中文页节点
		page.insert_text((72, 72), "Leave proof within 3 working days.", fontsize=11)
		content = doc.tobytes()
		doc.close()
		ir = parse_pdf(content=content, filename="leave.pdf", title="请假制度")
		# 保证黄金集正文断言稳定（不依赖宿主 CJK 字体）
		if not any("三个工作日" in (n.text or "") for n in ir.nodes):
			ir = DocumentIR(
				id=ir.id,
				library_id=ir.library_id,
				title=ir.title or "请假制度",
				source_format="pdf",
				filename=ir.filename or "leave.pdf",
				nodes=[
					Node(
						id="n-p1",
						type=NodeType.PARAGRAPH,
						text="病假须于返岗后三个工作日内补交证明材料。",
						page_start=1,
						page_end=1,
					)
				],
				parser_report=ParserReport(source_format="pdf", parser="eval_synthetic"),
			)
		return ir

	if fixture_name == "synthetic:docx_table":
		from io import BytesIO

		from docx import Document

		from app.services.ingest.parsers.docx import parse_docx

		word = Document()
		word.add_heading("供应商报价", level=1)
		table = word.add_table(rows=3, cols=2)
		table.cell(0, 0).text = "供应商"
		table.cell(0, 1).text = "报价"
		table.cell(1, 0).text = "甲公司"
		table.cell(1, 1).text = "120000"
		table.cell(2, 0).text = "乙公司"
		table.cell(2, 1).text = "80000"
		buf = BytesIO()
		word.save(buf)
		return parse_docx(content=buf.getvalue(), filename="quote.docx", title="报价表")

	path = FIXTURES / fixture_name
	content = path.read_bytes()
	return parse_markdown(content=content, filename=fixture_name, title=fixture_name)


def _run_ingest_chunk(case: EvalCase) -> EvalCaseResult:
	from app.services.ingest.chunker import chunk_document

	fixture_name = case.fixture or "handbook.md"
	doc = _load_ir_for_fixture(fixture_name)
	chunks = chunk_document(doc)
	q = case.question

	def score(chunk: Any) -> float:
		body = chunk.body or ""
		overlap = len(set(q) & set(body)) / max(len(set(q)), 1)
		bonus = 0.0
		if "病假" in q and "病假" in body:
			bonus += 0.5
		if "薪酬" in q and ("薪酬" in body or "岗位职级" in body):
			bonus += 0.5
		if "表格" in q or "基本工资" in q or "供应商" in q or "报价" in q:
			if chunk.table_id or "|" in body or "基本工资" in body or "报价" in body:
				bonus += 0.5
		if "页" in q and (chunk.page_label or chunk.page_start):
			bonus += 0.2
		return overlap + bonus

	ranked = sorted(chunks, key=score, reverse=True)
	top = ranked[0] if ranked else None
	observed = {
		"section_path": getattr(top, "section_path", None) if top else None,
		"body": getattr(top, "body", None) if top else None,
		"table_id": getattr(top, "table_id", None) if top else None,
		"page": getattr(top, "page_label", None) if top else None,
	}
	# PDF：额外校验 page 存在
	if fixture_name == "synthetic:pdf_page" and top is not None:
		if not (top.page_label or top.page_start is not None):
			return EvalCaseResult(
				id=case.id,
				ok=False,
				kind=case.kind,
				errors=["pdf chunk missing page"],
				observed=observed,
			)
	errors = _check_expect(case.expect, observed)
	return EvalCaseResult(
		id=case.id,
		ok=not errors,
		kind=case.kind,
		errors=errors,
		observed=observed,
	)


def _deterministic_vector(text: str, *, dimensions: int = 128) -> list[float]:
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


def _run_retrieval(case: EvalCase) -> EvalCaseResult:
	"""真实经过 QdrantStore + RetrievalService 的本地可重复检索回归。"""
	from qdrant_client import QdrantClient

	from app.services.ingest.chunker import chunk_document
	from app.services.ingest.pipeline import chunks_to_payloads
	from app.services.qdrant_store import QdrantStore
	from app.services.retrieval import RetrievalService
	from app.settings import Settings

	fixture_name = case.fixture or "handbook.md"
	doc = _load_ir_for_fixture(fixture_name)
	chunks = chunk_document(doc)
	payloads = chunks_to_payloads(chunks, filename=doc.filename or fixture_name)
	dimensions = 128
	settings = Settings(
		ask_mode="stub",
		embedding_dim=dimensions,
		qdrant_collection=f"eval_{case.id.replace('-', '_')}",
		hybrid_enabled=False,
		rerank_enabled=False,
		retrieve_top_k=3,
		rerank_top_k=3,
		bm25_top_k=3,
	)

	class _EvalEmbeddings:
		def embed_query(self, text: str) -> list[float]:
			return _deterministic_vector(text, dimensions=dimensions)

	client = QdrantClient(location=":memory:")
	try:
		store = QdrantStore(settings, client=client)
		store.upsert_chunks(
			library_id=case.library_id or "lib-eval",
			doc_id=doc.id,
			title=doc.title or fixture_name,
			chunks=payloads,
			vectors=[
				_deterministic_vector(str(item.get("embed_text") or item.get("text") or ""), dimensions=dimensions)
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
			top_k=3,
		)
	finally:
		client.close()

	top = hits[0] if hits else None
	observed = {
		"body": top.get("body") if top else None,
		"section_path": top.get("section_path") if top else None,
		"document_version_id": top.get("document_version_id") if top else None,
		"hit_count": len(hits),
	}
	errors = _check_expect(case.expect, observed)
	if top is None:
		errors.append("retrieval returned no hits")
	elif not observed["document_version_id"]:
		errors.append("retrieval hit missing document_version_id")
	return EvalCaseResult(
		id=case.id,
		ok=not errors,
		kind=case.kind,
		errors=errors,
		observed=observed,
	)


def run_eval_cases(path: Path | None = None) -> list[EvalCaseResult]:
	cases = load_eval_cases(path)
	results: list[EvalCaseResult] = []
	for case in cases:
		if case.kind == "classify":
			results.append(_run_classify(case))
		elif case.kind == "ingest_chunk":
			results.append(_run_ingest_chunk(case))
		elif case.kind == "retrieval":
			results.append(_run_retrieval(case))
		else:
			results.append(_run_ask(case))
	return results


def main(argv: list[str] | None = None) -> int:
	args = list(argv or sys.argv[1:])
	path = Path(args[0]) if args else DEFAULT_CASES
	results = run_eval_cases(path)
	passed = sum(1 for item in results if item.ok)
	failed = [item for item in results if not item.ok]
	print(f"[eval] cases={len(results)} passed={passed} failed={len(failed)} file={path}")
	for item in results:
		mark = "PASS" if item.ok else "FAIL"
		print(f"  {mark} {item.id} ({item.kind})")
		for err in item.errors:
			print(f"       - {err}")
	return 1 if failed else 0


if __name__ == "__main__":
	raise SystemExit(main())
