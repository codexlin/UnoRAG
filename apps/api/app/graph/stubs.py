"""Deterministic stub retrieve / generate / table store for AskGraph tests."""

from __future__ import annotations

from typing import Any

STUB_CITATIONS: list[dict[str, Any]] = [
	{
		"id": "c1",
		"index": 1,
		"title": "员工手册-休假篇",
		"page": "p.12",
		"snippet": "病假须于返岗后三个工作日内补交证明材料，并由直属主管确认。",
		"score": 0.91,
		"text": "病假须于返岗后三个工作日内补交证明材料，并由直属主管确认。",
		"doc_id": "doc-hr-leave",
		"chunk_index": 0,
		"filename": "员工手册-休假篇.pdf",
	},
	{
		"id": "c2",
		"index": 2,
		"title": "考勤管理细则",
		"page": "§3.2",
		"snippet": "未能按期提交病假证明的，人力资源部有权按事假或旷工规则核算。",
		"score": 0.78,
		"text": "未能按期提交病假证明的，人力资源部有权按事假或旷工规则核算。",
		"doc_id": "doc-hr-attendance",
		"chunk_index": 0,
		"filename": "考勤管理细则.docx",
	},
]


def stub_retrieve(
	query: str,
	library_id: str | None,
	_top_k: int,
	filters: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
	"""Deterministic stub hits; special queries exercise refuse paths in tests."""
	normalized = query.strip().lower()
	if "无命中" in query or normalized.startswith("__no_hit__"):
		return []
	if "弱相关" in query or normalized.startswith("__weak__"):
		return [
			{
				"id": "weak-1",
				"index": 1,
				"title": "无关附录.pdf",
				"page": "p.99",
				"snippet": "本附录仅作排版示例，不含人事制度条款。",
				"score": 0.11,
				"text": "本附录仅作排版示例，不含人事制度条款。",
				"used_rerank": False,
				"record_type": "chunk",
			}
		]
	_ = library_id
	record_type = str((filters or {}).get("record_type") or "chunk")
	# fast 双路会查 table_summary：无表信号时返回空，避免 stub 同分抢占文本 citation
	if record_type == "table_summary":
		tableish = any(
			token in query
			for token in ("表", "报价", "总价", "供应商", "金额", "明细", "单价")
		)
		if not tableish:
			return []
	hits = [dict(item) for item in STUB_CITATIONS]
	for item in hits:
		item["used_rerank"] = False
		item["record_type"] = "chunk" if record_type == "chunk+table_summary" else record_type
		if record_type == "section":
			item["section_path"] = item.get("section_path") or "第3章 请假制度"
			item["source_chunk_ids"] = ["chk:stub-doc:0"]
			item["record_id"] = "sec:stub-leave"
		if record_type in {"table", "table_summary"}:
			item["table_id"] = "t1"
			item["record_id"] = (
				"tblsum:stub-quote" if record_type == "table_summary" else "tbl:stub-quote"
			)
			item["record_type"] = record_type
			item["headers"] = ["供应商", "总价"]
			item["rows"] = [["甲公司", "120000"], ["乙公司", "80000"]]
			item["row_start"] = 0
			item["row_end"] = 1
			item["table_row_count"] = 2
			item["body"] = (
				"报价表摘要：供应商/总价；共2行；含甲公司120000、乙公司80000"
				if record_type == "table_summary"
				else "供应商 | 总价\n甲公司 | 120000\n乙公司 | 80000"
			)
			item["text"] = item["body"]
			item["snippet"] = item["body"][:280]
			item["source_chunk_ids"] = ["chk:stub-doc:0"]
			item["document_version_id"] = "stub-version"
	return hits


def stub_load_table_groups(
	*,
	doc_id: str,
	table_id: str,
	document_version_id: str | None = None,
	library_id: str | None = None,
) -> list[dict[str, Any]]:
	"""In-memory store aligned with stub_retrieve table hits (eval / ASK_MODE=stub).

	Does not relax production fail-closed paths: live mode still requires a real store loader.
	"""
	if str(table_id) != "t1":
		return []
	headers = ["供应商", "总价"]
	rows = [["甲公司", "120000"], ["乙公司", "80000"]]
	return [
		{
			"id": "stub-g0",
			"record_type": "table",
			"doc_id": doc_id,
			"document_version_id": document_version_id or "stub-version",
			"library_id": library_id,
			"table_id": table_id,
			"title": "报价表",
			"headers": headers,
			"rows": rows,
			"row_start": 0,
			"row_end": 1,
			"table_row_count": 2,
			"score": 0.9,
			"body": "供应商 | 总价\n甲公司 | 120000\n乙公司 | 80000",
		}
	]


def stub_generate(
	messages: list[dict[str, str]],
	citations: list[dict[str, Any]],
) -> str:
	_ = messages
	# section 总结：若有章节路径，稍作提示（仍为 stub 固定答）
	sectionish = any(
		str(item.get("record_type") or "") == "section" or item.get("section_path")
		for item in citations
	)
	tableish = any(str(item.get("record_type") or "") == "table" for item in citations)
	if tableish:
		prefix = "（表格）"
	elif sectionish:
		prefix = "（章节摘要）"
	else:
		prefix = ""
	return (
		f"{prefix}根据现行人事制度，病假须于返岗后三个工作日内补交证明材料，并由直属主管确认。"
		"逾期未补交的，可按事假或旷工规则处理（以制度原文为准）。"
		"\n\n（当前为 stub 路径：未调用真实 LLM。）"
	)
