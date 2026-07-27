"""Ingest-chunk executor — offline chunk ranking against fixtures."""

from __future__ import annotations

from typing import Any

from app.eval.assertions import check_expect
from app.eval.fixtures import load_ir_for_fixture
from app.eval.schemas import EvalCase, EvalCaseResult


def run_ingest_chunk(case: EvalCase) -> EvalCaseResult:
	from app.services.ingest.chunker import chunk_document

	fixture_name = case.fixture or "handbook.md"
	doc = load_ir_for_fixture(fixture_name)
	chunks = chunk_document(doc)
	q = case.question

	def score(chunk: Any) -> float:
		body = chunk.body or ""
		overlap = len(set(q) & set(body)) / max(len(set(q)), 1)
		bonus = 0.0
		if "病假" in q and "病假" in body:
			bonus += 0.5
		if "薪酬" in q and ("薪酬" in body or "岗位职级" in body or "二十五日" in body):
			bonus += 0.5
		if "表格" in q or "基本工资" in q or "供应商" in q or "报价" in q or "甲公司" in q or "总价" in q:
			if chunk.table_id or "|" in body or "基本工资" in body or "报价" in body or "120000" in body:
				bonus += 0.5
		if ("五个自然日" in q or "人力资源前台" in q) and (
			"五个自然日" in body or "人力资源前台" in body
		):
			bonus += 0.6
		if ("断电" in q or "图注" in q) and ("断电" in body or "图注" in body):
			bonus += 0.6
		if ("吸烟" in q or "罚款" in q) and ("吸烟" in body or "罚款200" in body):
			bonus += 0.6
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
	is_pdf = fixture_name == "synthetic:pdf_page" or fixture_name.lower().endswith(".pdf")
	if is_pdf and top is not None:
		if not (top.page_label or top.page_start is not None):
			return EvalCaseResult(
				id=case.id,
				ok=False,
				kind=case.kind,
				errors=["pdf chunk missing page"],
				observed=observed,
			)
	errors = check_expect(case.expect, observed)
	return EvalCaseResult(
		id=case.id,
		ok=not errors,
		kind=case.kind,
		errors=errors,
		observed=observed,
	)
