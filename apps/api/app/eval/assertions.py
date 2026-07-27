"""Eval expect checks — observed dict vs EvalExpect."""

from __future__ import annotations

from typing import Any

from app.eval.schemas import EvalExpect


def collect_ids(observed: dict[str, Any], *, keys: tuple[str, ...]) -> set[str]:
	"""Harvest id-like fields from observed answer / citations / hits."""
	found: set[str] = set()

	def walk(node: Any) -> None:
		if isinstance(node, dict):
			for key, value in node.items():
				if key in keys:
					if isinstance(value, str) and value:
						found.add(value)
					elif isinstance(value, list):
						for item in value:
							if isinstance(item, str) and item:
								found.add(item)
				walk(value)
		elif isinstance(node, list):
			for item in node:
				walk(item)

	walk(observed)
	return found


def check_expect(expect: EvalExpect, observed: dict[str, Any]) -> list[str]:
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
	for point in expect.expected_answer_points:
		if point not in answer:
			errors.append(f"expected_answer_point missing: {point!r}")
	# Domain gold: require observed evidence ids when gold is annotated.
	# Missing observed ids is a failure (do not silently pass).
	if expect.gold_chunk_ids:
		observed_chunks = collect_ids(observed, keys=("chunk_id", "chunk_ids"))
		if not observed_chunks:
			errors.append(
				f"gold_chunk_ids required {expect.gold_chunk_ids} but no chunk_id in observed"
			)
		elif not (set(expect.gold_chunk_ids) & observed_chunks):
			errors.append(
				f"gold_chunk_ids miss: want any of {expect.gold_chunk_ids} got={sorted(observed_chunks)}"
			)
	if expect.gold_document_version_ids:
		observed_versions = collect_ids(
			observed,
			keys=("document_version_id", "doc_version_id", "version_id"),
		)
		if not observed_versions:
			errors.append(
				"gold_document_version_ids required "
				f"{expect.gold_document_version_ids} but none observed"
			)
		elif not (set(expect.gold_document_version_ids) & observed_versions):
			errors.append(
				"gold_document_version_ids miss: "
				f"want any of {expect.gold_document_version_ids} got={sorted(observed_versions)}"
			)
	if expect.gold_table_ids:
		observed_tables = collect_ids(observed, keys=("table_id", "table_ids"))
		if not observed_tables:
			errors.append(
				f"gold_table_ids required {expect.gold_table_ids} but none observed"
			)
		elif not (set(expect.gold_table_ids) & observed_tables):
			errors.append(
				f"gold_table_ids miss: want any of {expect.gold_table_ids} got={sorted(observed_tables)}"
			)
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
	if expect.max_rank is not None:
		rank = observed.get("observed_rank")
		if rank is None:
			errors.append(f"max_rank={expect.max_rank} but observed_rank is missing (no hit in Recall@K)")
		elif int(rank) > int(expect.max_rank):
			errors.append(f"observed_rank={rank} exceeds max_rank={expect.max_rank}")
	if expect.http_status is not None and observed.get("http_status") != expect.http_status:
		errors.append(
			f"http_status want={expect.http_status} got={observed.get('http_status')}"
		)
	if expect.http_status_any:
		got_status = observed.get("http_status")
		if got_status not in expect.http_status_any:
			errors.append(
				f"http_status want one of {expect.http_status_any} got={got_status}"
			)
	if expect.doc_status is not None and observed.get("doc_status") != expect.doc_status:
		errors.append(
			f"doc_status want={expect.doc_status} got={observed.get('doc_status')}"
		)
	if expect.error_substr is not None:
		blob = str(observed.get("error") or "")
		if expect.error_substr not in blob:
			errors.append(f"error missing {expect.error_substr!r} got={blob!r}")
	if expect.detail_substr is not None:
		blob = str(observed.get("detail") or "")
		if expect.detail_substr not in blob:
			errors.append(f"detail missing {expect.detail_substr!r} got={blob!r}")
	if expect.record_type is not None and observed.get("record_type") != expect.record_type:
		errors.append(
			f"record_type want={expect.record_type} got={observed.get('record_type')}"
		)
	return errors


# Transition aliases (private names historically imported from runner).
_check_expect = check_expect
_collect_ids = collect_ids
