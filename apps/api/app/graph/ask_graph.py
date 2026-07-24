from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Callable
from typing import Any, Literal, TypedDict

from langgraph.graph import END, StateGraph

from app.security.access_scope import AccessScope, resolve_access_scope
from app.schemas import AskResponse, Citation
from app.services.answer_copy import (
	clarify_answer,
	no_match_answer,
	table_unclear_answer,
	weak_match_answer,
)
from app.services.ask_trace import (
	append_stage,
	citation_retrieve_detail,
	emit_ask_trace,
	finalize_ask_debug,
	initial_ask_debug,
	question_hash,
	resolve_trace_id,
)
from app.services.llm import ChatService
from app.services.ask_route import (
	should_upgrade_fast_to_precise_table,
	table_overview_downgrade_reason,
)
from app.services.query_router import looks_like_table_summary_lookup, route_query
from app.services.retrieval import RetrievalService
from app.services.retrieval_plan import build_retrieval_plan
from app.services.runtime import RuntimeCapability, resolve_runtime
from app.services.session_memory import SessionMemory, default_session_memory
from app.services.table_query import (
	build_table_query_plan,
	citations_for_table_overview,
	citations_with_matched_evidence,
	execute_table_query,
	looks_like_numeric_table_query,
	prepare_table_for_execute,
	table_instance_key,
)
from app.settings import Settings, get_settings

logger = logging.getLogger(__name__)

RetrieveFn = Callable[..., list[dict[str, Any]]]
GenerateFn = Callable[[str, list[dict[str, Any]]], str]
LoadTableGroupsFn = Callable[..., list[dict[str, Any]]]


class AskState(TypedDict, total=False):
	session_id: str
	question: str
	library_id: str | None
	history: list[dict[str, str]]
	rewritten_question: str
	citations: list[dict[str, Any]]
	answer: str
	refused: bool
	refuse_reason: str | None
	retrieval_attempts: int
	judgement: dict[str, Any]
	retrieval_debug: dict[str, Any]
	trace_id: str
	query_type: str
	route_reason: str
	retrieval_plan: dict[str, Any]
	table_query_plan: dict[str, Any]
	table_execution: dict[str, Any]
	upgrade: str | None
	upgrade_reason: str | None
	downgrade_reason: str | None


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


def _to_citation_models(raw_citations: list[dict[str, Any]]) -> list[Citation]:
	models: list[Citation] = []
	for item in raw_citations:
		full_text = str(item.get("body") or item.get("text") or item.get("snippet") or "")
		snippet = str(item.get("snippet") or full_text[:280])

		def _opt_float(key: str) -> float | None:
			raw = item.get(key)
			if raw is None:
				return None
			try:
				return float(raw)
			except (TypeError, ValueError):
				return None

		models.append(
			Citation.model_validate(
				{
					"id": item["id"],
					"index": item["index"],
					"title": item["title"],
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
					"score": item["score"],
					"dense_score": _opt_float("dense_score"),
					"bm25_score": _opt_float("bm25_score"),
					"rrf_score": _opt_float("rrf_score"),
					"used_rerank": bool(item.get("used_rerank")),
					"used_hybrid": bool(item.get("used_hybrid")),
					"doc_id": item.get("doc_id"),
					"chunk_index": item.get("chunk_index"),
					"filename": item.get("filename"),
					"document_version_id": item.get("document_version_id"),
					"tenant_id": item.get("tenant_id"),
					"record_type": item.get("record_type"),
					"record_id": item.get("record_id"),
					"source_chunk_ids": item.get("source_chunk_ids") or [],
					"source_node_ids": item.get("source_node_ids") or [],
				}
			)
		)
	return models


def _to_citation_dicts(raw_citations: list[dict[str, Any]]) -> list[dict[str, Any]]:
	return [item.model_dump() for item in _to_citation_models(raw_citations)]


def _renumber_citation_indexes(
	citations: list[dict[str, Any]],
) -> list[dict[str, Any]]:
	"""合并多路命中后重新编号为稳定唯一的 1..N（各路 retrieve 各自从 1 起编）。"""
	for index, item in enumerate(citations, start=1):
		item["index"] = index
	return citations


def _persist_turn(
	*,
	session_id: str,
	library_id: str | None,
	question: str,
	answer: str,
	citations: list[Citation],
	mode: str,
	refused: bool,
	refuse_reason: str | None,
	query_type: str | None = None,
	retrieval_plan: dict[str, Any] | None = None,
	retrieval_debug: dict[str, Any] | None = None,
	rewrite: str | None = None,
	rewritten_query: str | None = None,
	judge: dict[str, Any] | None = None,
	document_version_id: str | None = None,
	tenant_id: str | None = None,
	workspace_id: str | None = None,
	principal_id: str | None = None,
) -> dict[str, Any]:
	try:
		from app.services.metadata import get_metadata_store

		get_metadata_store().create_turn(
			session_id=session_id,
			library_id=library_id,
			question=question,
			answer=answer,
			citations=[item.model_dump() for item in citations],
			mode=mode,
			refused=refused,
			refuse_reason=refuse_reason,
			query_type=query_type,
			retrieval_plan=retrieval_plan,
			retrieval_debug=retrieval_debug,
			rewrite=rewrite,
			rewritten_query=rewritten_query,
			judge=judge,
			document_version_id=document_version_id,
			tenant_id=tenant_id,
			workspace_id=workspace_id,
			principal_id=principal_id,
		)
		return {"persisted": True, "persist_error": None}
	except Exception as exc:
		logger.exception("ask.persist_turn_failed session_id=%s", session_id)
		return {"persisted": False, "persist_error": str(exc)}


def _single_document_version_id(citations: list[Citation]) -> str | None:
	"""Turn 只有一个文档版本时提供便捷字段；完整快照仍以 citations 为准。"""
	version_ids = {
		item.document_version_id
		for item in citations
		if item.document_version_id
	}
	return next(iter(version_ids)) if len(version_ids) == 1 else None


def _retrieval_visibility(debug: dict[str, Any]) -> dict[str, Any]:
	hybrid_failed = bool(debug.get("hybrid_failed") or debug.get("hybrid_error"))
	rerank_failed = bool(debug.get("rerank_failed"))
	retrieval_mode = str(debug.get("retrieval_mode") or ("hybrid" if debug.get("used_hybrid") else "dense"))
	return {
		"hybrid_failed": hybrid_failed,
		"rerank_failed": rerank_failed,
		"retrieval_mode": retrieval_mode,
	}


def _library_label(library_id: str | None) -> str:
	if not library_id:
		return "当前知识库"
	return library_id


def rewrite_with_history(question: str, history: list[dict[str, str]] | None) -> tuple[str, str]:
	"""Return (rewritten_query, rewrite_mode). Lightweight QueryNest-style follow-up rewrite."""
	q = question.strip()
	if not history:
		return q, "passthrough"
	previous_questions = [
		item["content"]
		for item in reversed(history)
		if item.get("role") == "user" and (item.get("content") or "").strip()
	]
	if not previous_questions:
		return q, "passthrough"
	prev = previous_questions[0].strip()
	# Pronoun / short follow-ups benefit most from prior turn context.
	needs_context = len(q) <= 24 or any(
		token in q for token in ("它", "这个", "那个", "上述", "刚才", "还有", "呢", "吗")
	)
	if not needs_context:
		return q, "passthrough"
	return f"上一轮用户问题：{prev}\n当前追问：{q}", "history"


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


def stub_generate(question: str, citations: list[dict[str, Any]]) -> str:
	_ = question
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


def _format_context(citations: list[dict[str, Any]]) -> str:
	blocks: list[str] = []
	for item in citations:
		idx = item.get("index", len(blocks) + 1)
		title = item.get("title") or "资料"
		# 模型上下文用 body（与抽屉一致）；章节路径作定位前缀
		text = item.get("body") or item.get("text") or item.get("snippet") or ""
		section = item.get("section_path")
		table_id = item.get("table_id")
		row_start = item.get("row_start")
		row_end = item.get("row_end")
		loc_bits = []
		if section:
			loc_bits.append(str(section))
		if table_id:
			loc_bits.append(f"table={table_id}")
		if row_start is not None and row_end is not None:
			loc_bits.append(f"rows={row_start}-{row_end}")
		header = f"[{idx}] {title}" + (f" · {' · '.join(loc_bits)}" if loc_bits else "")
		blocks.append(f"{header}\n{text}")
	return "\n\n".join(blocks)


def _format_table_generate_context(
	question: str,
	citations: list[dict[str, Any]],
	execution: dict[str, Any] | None,
) -> str:
	"""表格路径：把代码侧计算结果与行证据交给 LLM 解释（禁止心算）。"""
	parts = [_format_context(citations)]
	if execution and execution.get("ok"):
		parts.append(
			"【已由程序计算，请据此解释，勿自行改算】\n"
			f"operation={execution.get('operation')} column={execution.get('column')} "
			f"operator={execution.get('operator')} value={execution.get('value')}\n"
			f"answer_text={execution.get('answer_text')}\n"
			f"matched_count={execution.get('matched_count')} "
			f"matched_rows_truncated={execution.get('matched_rows_truncated')}\n"
			f"matched_rows={execution.get('matched_rows')}"
		)
	parts.append(f"用户问题：{question}")
	return "\n\n".join(parts)


def _merge_debug(state: AskState, **extra: Any) -> dict[str, Any]:
	debug = dict(state.get("retrieval_debug") or {})
	debug.update(extra)
	return debug


def build_ask_graph(
	*,
	settings: Settings,
	retrieve_fn: RetrieveFn,
	generate_fn: GenerateFn,
	mode: str,
	load_table_groups_fn: LoadTableGroupsFn | None = None,
	access_scope: AccessScope | None = None,
):
	min_score = float(settings.answer_min_score)
	max_retries = max(0, int(settings.max_retrieve_retries))
	scope = resolve_access_scope(settings, access_scope)
	tenant_id = scope.tenant_id
	workspace_id = scope.workspace_id

	def query_router_node(state: AskState) -> AskState:
		"""规则分类；summary/table/ambiguous 等仅落盘，不建子图。"""
		routed = route_query(
			state["question"],
			history=state.get("history") or [],
			library_id=state.get("library_id"),
		)
		query_type = str(routed["query_type"])
		route_reason = str(routed["reason"])
		return {
			"query_type": query_type,
			"route_reason": route_reason,
			"retrieval_attempts": 0,
			"refused": False,
			"refuse_reason": None,
			"retrieval_debug": _merge_debug(
				state,
				query_type=query_type,
				route_reason=route_reason,
				mode=mode,
				answer_min_score=min_score,
				rerank_enabled=bool(settings.rerank_enabled),
				tenant_id=tenant_id,
				workspace_id=workspace_id,
			),
		}

	def build_plan_node(state: AskState) -> AskState:
		t0 = time.perf_counter()
		query_type = str(state.get("query_type") or "fact")
		route_reason = str(state.get("route_reason") or "default_fact")
		plan = build_retrieval_plan(
			query_type=query_type,
			route_reason=route_reason,
			library_id=state.get("library_id"),
			top_k=settings.retrieve_top_k,
			hybrid_enabled=bool(settings.hybrid_enabled),
			rerank_enabled=bool(settings.rerank_enabled),
			tenant_id=tenant_id,
			workspace_id=workspace_id,
			question=state.get("question"),
		)
		debug = _merge_debug(
			state,
			retrieval_plan=plan,
			route=plan.get("route"),
			path=plan.get("path"),
			precise_kind=plan.get("precise_kind"),
			upgrade=None,
			upgrade_reason=None,
			downgrade_reason=None,
		)
		append_stage(
			debug,
			name="route",
			duration_ms=(time.perf_counter() - t0) * 1000,
			detail={
				"path": plan.get("path"),
				"route": plan.get("route"),
				"decision_reason": plan.get("reason") or route_reason,
			},
		)
		return {
			"retrieval_plan": plan,
			"upgrade": None,
			"upgrade_reason": None,
			"downgrade_reason": None,
			"retrieval_debug": debug,
		}

	def route_after_plan(state: AskState) -> Literal["clarify", "rewrite", "table"]:
		plan = state.get("retrieval_plan") or {}
		path = str(plan.get("path") or "")
		execute_path = str(plan.get("execute_path") or "short")
		if path == "clarify" or execute_path == "clarify":
			return "clarify"
		if path == "precise" and plan.get("precise_kind") == "table":
			return "table"
		if execute_path == "table":
			return "table"
		return "rewrite"

	def clarify_node(state: AskState) -> AskState:
		library_name = _library_label(state.get("library_id"))
		judgement = {
			"sufficient": False,
			"action": "clarify",
			"reason": "ambiguous",
			"can_retry": False,
		}
		return {
			"answer": clarify_answer(library_name=library_name),
			"citations": [],
			"refused": True,
			"refuse_reason": "ambiguous",
			"judgement": judgement,
			"retrieval_debug": _merge_debug(
				state,
				judgement=judgement,
				generate="clarify",
				refuse_reason="ambiguous",
			),
		}

	def build_table_plan_node(state: AskState) -> AskState:
		"""轻量 TableQueryPlan；不确定则 fallback（retrieve 后仍可能 clarify）。"""
		question = state.get("question") or ""
		tq = build_table_query_plan(question)
		return {
			"table_query_plan": tq,
			"retrieval_debug": _merge_debug(state, table_query_plan=tq),
		}

	def table_retrieve_node(state: AskState) -> AskState:
		"""Retrieve table summaries for discovery plus row groups for evidence."""
		t0 = time.perf_counter()
		query = state.get("rewritten_question") or state["question"]
		attempts = int(state.get("retrieval_attempts") or 0) + 1
		plan = state.get("retrieval_plan") or {}
		top_k = int(plan.get("top_k") or settings.retrieve_top_k)
		filters = dict(plan.get("filters") or {})
		filters["record_type"] = "table"
		citations = retrieve_fn(query, state.get("library_id"), top_k, filters)
		summary_filters = dict(filters)
		summary_filters["record_type"] = "table_summary"
		summaries = retrieve_fn(
			query,
			state.get("library_id"),
			min(4, top_k),
			summary_filters,
		)
		combined = [*summaries, *citations]
		deduped: list[dict[str, Any]] = []
		seen: set[str] = set()
		for item in sorted(
			combined,
			key=lambda value: float(value.get("score") or 0),
			reverse=True,
		):
			key = str(
				item.get("record_id")
				or item.get("id")
				or (
					item.get("doc_id"),
					item.get("table_id"),
					item.get("record_type"),
					item.get("row_start"),
				)
			)
			if key in seen:
				continue
			seen.add(key)
			deduped.append(item)
		citations = _renumber_citation_indexes(deduped[: top_k + min(4, top_k)])
		citation_check = {
			"ok": all(item.get("table_id") for item in citations) if citations else True,
			"missing_table_id": sum(1 for item in citations if not item.get("table_id")),
		}
		top_score = float(citations[0]["score"]) if citations else None
		retrieve_detail = citation_retrieve_detail(citations)
		debug = _merge_debug(
			state,
			retrieve=mode,
			library_id=state.get("library_id"),
			hit_count=len(citations),
			top_score=top_score,
			retrieval_attempts=attempts,
			query=query,
			record_type="table+table_summary",
			filters=filters,
			citation_check=citation_check,
		)
		append_stage(
			debug,
			name="retrieve",
			duration_ms=(time.perf_counter() - t0) * 1000,
			detail=retrieve_detail,
		)
		return {
			"citations": citations,
			"retrieval_attempts": attempts,
			"retrieval_debug": debug,
		}

	def table_execute_node(state: AskState) -> AskState:
		"""定位表实例 → 全表加载 → 代码侧过滤/聚合；缺组/不确定 → clarify。"""
		t_load0 = time.perf_counter()
		citations = list(state.get("citations") or [])
		question = state.get("question") or ""
		merged = prepare_table_for_execute(
			citations,
			load_table_groups=load_table_groups_fn,
			library_id=state.get("library_id"),
			question=question,
		)
		load_ms = (time.perf_counter() - t_load0) * 1000
		headers = list(merged.get("headers") or [])
		table_complete = bool(merged.get("complete"))
		table_quality = dict(merged.get("table_quality") or {})
		quality_executable = table_quality.get("executable", True) is not False
		# 用真实表头 refinement plan
		base_plan = dict(state.get("table_query_plan") or {})
		refined = build_table_query_plan(question, headers=headers or None)
		# 若初始已自信且 refinement 因缺 headers 仍自信，保留；否则用 refined
		tq = refined if headers else base_plan

		t_exec0 = time.perf_counter()
		if headers and table_complete and quality_executable:
			execution = execute_table_query(
				tq,
				headers=headers,
				rows=list(merged.get("rows") or []),
				row_offset=int(merged.get("row_offset") or 0),
				collect_evidence_indices=True,
				summary_rows=list(merged.get("summary_rows") or []),
			)
		elif headers and table_complete and not quality_executable:
			execution = {
				"ok": False,
				"operation": str(tq.get("operation") or "fallback"),
				"matched_rows": [],
				"reason": "table_quality_not_executable",
				"quality_report": table_quality,
			}
		elif headers and not table_complete:
			# fail closed：禁止在 top_k 子集上聚合后标 table_exec_ok
			execution = {
				"ok": False,
				"operation": str(tq.get("operation") or "fallback"),
				"matched_rows": [],
				"reason": f"table_incomplete:{merged.get('reason') or 'unknown'}",
				"group_count": merged.get("group_count"),
				"load_source": merged.get("load_source"),
			}
		else:
			execution = {
				"ok": False,
				"operation": "fallback",
				"matched_rows": [],
				"reason": "no_table_payload",
			}
		exec_ms = (time.perf_counter() - t_exec0) * 1000
		evidence_row_indices = list(
			execution.pop(
				"_evidence_row_indices",
				execution.get("matched_row_indices") or [],
			)
		)

		def _with_table_stages(debug: dict[str, Any]) -> dict[str, Any]:
			append_stage(
				debug,
				name="table_load",
				duration_ms=load_ms,
				ok=bool(merged.get("complete")),
				detail={
					"load_source": merged.get("load_source"),
					"complete": bool(merged.get("complete")),
					"table_id": merged.get("table_id"),
				},
			)
			matched_count = execution.get("matched_count")
			if matched_count is None and isinstance(execution.get("matched_rows"), list):
				matched_count = len(execution["matched_rows"])
			append_stage(
				debug,
				name="table_execute",
				duration_ms=exec_ms,
				ok=bool(execution.get("ok")),
				detail={
					"operation": execution.get("operation"),
					"ok": bool(execution.get("ok")),
					"matched_count": matched_count,
				},
			)
			return debug

		# 标注 citation 行范围 / 版本（供 UI）；仅同实例
		# 保留 table_summary 的 record_type，避免与行组混淆（store 才是可执行路径）。
		target_key = (
			table_instance_key(merged)
			if merged.get("table_id")
			else None
		)
		enriched: list[dict[str, Any]] = []
		for item in citations:
			row = dict(item)
			rt = str(row.get("record_type") or "")
			if rt not in {"table", "table_summary"}:
				row["record_type"] = "table"
			if target_key and table_instance_key(row) == target_key:
				row.setdefault("document_version_id", merged.get("document_version_id"))
			enriched.append(row)

		# 全表执行命中的行可能在向量 top_k 之外：用证据行组替换同实例 citation
		if (
			execution.get("ok")
			and tq.get("confident")
			and table_complete
			and (
				evidence_row_indices
				or execution.get("matched_rows")
			)
			and merged.get("groups")
		):
			enriched, evidence_meta = citations_with_matched_evidence(
				enriched,
				groups=list(merged.get("groups") or []),
				matched_rows=list(execution.get("matched_rows") or []),
				matched_row_indices=evidence_row_indices,
				target_key=target_key,
				seed_citation=merged.get("citation") or (citations[0] if citations else None),
			)
			execution.update(evidence_meta)

		# 精路径三岔门：能算则算 / 只能述则述 / 该拒则拒
		can_execute = bool(
			execution.get("ok") and tq.get("confident") and table_complete
		)
		must_compute = bool(
			looks_like_numeric_table_query(question)
			and not looks_like_table_summary_lookup(question)
		)
		table_load = {
			"complete": table_complete,
			"reason": merged.get("reason"),
			"group_count": merged.get("group_count"),
			"load_source": merged.get("load_source"),
			"doc_id": merged.get("doc_id"),
			"table_id": merged.get("table_id"),
		}

		if can_execute:
			return {
				"table_query_plan": tq,
				"table_execution": execution,
				"citations": enriched,
				"downgrade_reason": None,
				"retrieval_debug": _with_table_stages(
					_merge_debug(
						state,
						table_query_plan=tq,
						table_execution=execution,
						table_load=table_load,
						downgrade_reason=None,
						precise_gate="execute",
					)
				),
			}

		# 必须算数但 store/plan 不行 → 拒答（禁止 LLM 估数）
		if must_compute and citations:
			library_name = _library_label(state.get("library_id"))
			judgement = {
				"sufficient": False,
				"action": "clarify",
				"reason": "table_unclear" if table_complete else "table_incomplete",
				"can_retry": False,
			}
			refuse_reason = "table_unclear" if table_complete else "table_incomplete"
			return {
				"table_query_plan": tq,
				"table_execution": execution,
				"citations": enriched,
				"answer": table_unclear_answer(library_name=library_name),
				"refused": True,
				"refuse_reason": refuse_reason,
				"judgement": judgement,
				"downgrade_reason": None,
				"retrieval_debug": _with_table_stages(
					_merge_debug(
						state,
						table_query_plan=tq,
						table_execution=execution,
						table_load=table_load,
						judgement=judgement,
						generate="table_unclear",
						refuse_reason=refuse_reason,
						precise_gate="refuse",
						downgrade_reason=None,
					)
				),
			}

		# 不需精确算 / plan 不自信但表证据够 → LLM 概述（summary + 有界行预览）
		has_overview_evidence = bool(
			(headers and (table_complete or any(
				str(c.get("record_type") or "") == "table_summary" for c in enriched
			)))
			or any(str(c.get("record_type") or "") == "table_summary" for c in enriched)
		)
		downgrade = table_overview_downgrade_reason(
			plan_confident=bool(tq.get("confident")),
			must_compute=must_compute,
			table_complete=table_complete,
		)
		if has_overview_evidence and downgrade:
			overview_citations = citations_for_table_overview(
				enriched,
				merged=merged,
			)
			return {
				"table_query_plan": tq,
				"table_execution": execution,
				"citations": overview_citations,
				"downgrade_reason": downgrade,
				"retrieval_debug": _with_table_stages(
					_merge_debug(
						state,
						table_query_plan=tq,
						table_execution=execution,
						table_load=table_load,
						downgrade_reason=downgrade,
						precise_gate="overview",
					)
				),
			}

		return {
			"table_query_plan": tq,
			"table_execution": execution,
			"citations": enriched,
			"downgrade_reason": None,
			"retrieval_debug": _with_table_stages(
				_merge_debug(
					state,
					table_query_plan=tq,
					table_execution=execution,
					table_load=table_load,
					precise_gate="fallback_llm",
				)
			),
		}

	def route_after_table_execute(
		state: AskState,
	) -> Literal["judge", "end"]:
		if state.get("refuse_reason") in {"table_unclear", "table_incomplete"}:
			return "end"
		return "judge"

	def rewrite_node(state: AskState) -> AskState:
		question = state["question"].strip()
		history = state.get("history") or []
		rewritten, rewrite_mode = rewrite_with_history(question, history)
		return {
			"rewritten_question": rewritten,
			"retrieval_attempts": 0,
			"refused": False,
			"refuse_reason": None,
			"retrieval_debug": _merge_debug(
				state,
				rewrite=rewrite_mode,
				history_turns=len(history),
				mode=mode,
				answer_min_score=min_score,
				rerank_enabled=bool(settings.rerank_enabled),
			),
		}

	def retrieve_node(state: AskState) -> AskState:
		t0 = time.perf_counter()
		query = state.get("rewritten_question") or state["question"]
		attempts = int(state.get("retrieval_attempts") or 0) + 1
		plan = dict(state.get("retrieval_plan") or {})
		top_k = int(plan.get("top_k") or settings.retrieve_top_k)
		filters = dict(plan.get("filters") or {})
		plan_rt = str(plan.get("record_type") or filters.get("record_type") or "chunk")
		unified_fast = plan_rt == "chunk+table_summary" or (
			str(plan.get("path") or "") == "fast"
			and plan_rt not in {"section", "table", "table_summary"}
		)

		if unified_fast:
			chunk_filters = dict(filters)
			chunk_filters["record_type"] = "chunk"
			citations = retrieve_fn(
				query, state.get("library_id"), top_k, chunk_filters
			)
			summary_filters = dict(filters)
			summary_filters["record_type"] = "table_summary"
			summaries = retrieve_fn(
				query,
				state.get("library_id"),
				min(4, top_k),
				summary_filters,
			)
			combined = [*summaries, *citations]
			deduped: list[dict[str, Any]] = []
			seen: set[str] = set()
			for item in sorted(
				combined,
				key=lambda value: float(value.get("score") or 0),
				reverse=True,
			):
				key = str(
					item.get("record_id")
					or item.get("id")
					or (
						item.get("doc_id"),
						item.get("table_id"),
						item.get("record_type"),
						item.get("chunk_index"),
					)
				)
				if key in seen:
					continue
				seen.add(key)
				deduped.append(item)
			citations = _renumber_citation_indexes(deduped[: top_k + min(4, top_k)])
			filters = {**filters, "record_type": "chunk+table_summary"}
			resolved_rt = "chunk+table_summary"
		else:
			if plan.get("record_type") and "record_type" not in filters:
				filters["record_type"] = plan["record_type"]
			citations = retrieve_fn(query, state.get("library_id"), top_k, filters)
			resolved_rt = str(filters.get("record_type") or plan_rt)

		# 薄 citation_check：section 命中应能回溯 source_chunk_ids
		citation_check = {"ok": True, "missing_source_chunk_ids": 0}
		if resolved_rt == "section":
			missing = sum(
				1
				for item in citations
				if not (item.get("source_chunk_ids") or [])
			)
			citation_check = {
				"ok": missing == 0,
				"missing_source_chunk_ids": missing,
			}
		debug_extra: dict[str, Any] = {
			"record_type": resolved_rt,
			"filters": filters,
			"citation_check": citation_check,
		}
		tool_trace: list[dict[str, Any]] = []
		# TOOL_ASK：默认仍短路径；仅规范化 citation + 记录 search_docs 轨迹（多跳工具后续扩展）
		if settings.tool_ask:
			from app.services.ingest.tools import quote_source

			citations = [quote_source(item) for item in citations]
			tool_trace.append(
				{
					"tool": "search_docs",
					"query": query,
					"hit_count": len(citations),
				}
			)
		# 防御保障：多路合并 / quote_source 后 index 仍为唯一连续 1..N
		citations = _renumber_citation_indexes(citations)
		top_score = float(citations[0]["score"]) if citations else None
		used_rerank = bool(citations and citations[0].get("used_rerank"))
		retrieve_ms = (time.perf_counter() - t0) * 1000
		retrieve_detail = citation_retrieve_detail(citations)

		# 阶段2：fast → precise 升级（写死条件 + upgrade_reason）
		t_gate0 = time.perf_counter()
		upgrade: str | None = None
		upgrade_reason: str | None = None
		out_plan = plan
		out_query_type = str(state.get("query_type") or plan.get("query_type") or "fact")
		if str(plan.get("path") or "fast") == "fast" and resolved_rt != "section":
			do_upgrade, reason = should_upgrade_fast_to_precise_table(
				state.get("question") or query,
				citations,
			)
			if do_upgrade:
				upgrade = "precise"
				upgrade_reason = reason
				out_query_type = "table"
				out_plan = {
					**plan,
					"path": "precise",
					"precise_kind": "table",
					"execute_path": "table",
					"record_type": "table",
					"query_type": "table",
					"route": plan.get("route") or "fast",
					"reason": f"upgrade:{reason}",
				}
				filters_up = dict(out_plan.get("filters") or {})
				filters_up["record_type"] = "table"
				out_plan["filters"] = filters_up
		gate_ms = (time.perf_counter() - t_gate0) * 1000

		debug = _merge_debug(
			state,
			retrieve=mode,
			library_id=state.get("library_id"),
			hit_count=len(citations),
			top_score=top_score,
			used_rerank=used_rerank,
			retrieval_attempts=attempts,
			query=query,
			tool_ask=bool(settings.tool_ask),
			tool_trace=tool_trace,
			retrieval_plan=out_plan,
			route=out_plan.get("route") or plan.get("route"),
			path=out_plan.get("path"),
			precise_kind=out_plan.get("precise_kind"),
			upgrade=upgrade,
			upgrade_reason=upgrade_reason,
			**debug_extra,
		)
		append_stage(
			debug,
			name="retrieve",
			duration_ms=retrieve_ms,
			detail=retrieve_detail,
		)
		append_stage(
			debug,
			name="gate",
			duration_ms=gate_ms,
			detail={
				"decision": "upgrade" if upgrade else "keep",
				"decision_reason": upgrade_reason,
				"upgrade_to": upgrade,
			},
		)
		return {
			"citations": citations,
			"retrieval_attempts": attempts,
			"retrieval_plan": out_plan,
			"query_type": out_query_type,
			"upgrade": upgrade,
			"upgrade_reason": upgrade_reason,
			"retrieval_debug": debug,
		}

	def route_after_retrieve(
		state: AskState,
	) -> Literal["upgrade_precise", "judge"]:
		if state.get("upgrade") == "precise":
			return "upgrade_precise"
		return "judge"

	def judge_node(state: AskState) -> AskState:
		citations = state.get("citations") or []
		attempts = int(state.get("retrieval_attempts") or 0)
		library_name = _library_label(state.get("library_id"))
		table_execution = state.get("table_execution") or {}
		query_type = str(state.get("query_type") or "")

		# 表格结构化执行成功：证据充分，跳过 dense score 阈值
		if (
			query_type == "table"
			and table_execution.get("ok")
			and (state.get("table_query_plan") or {}).get("confident")
		):
			judgement = {
				"sufficient": True,
				"action": "generate",
				"reason": "table_exec_ok",
				"top_score": float(citations[0].get("score") or 1.0) if citations else 1.0,
				"min_score": min_score,
			}
			return {
				"judgement": judgement,
				"refuse_reason": None,
				"retrieval_debug": _merge_debug(
					state, judgement=judgement, library_name=library_name
				),
			}

		if not citations:
			can_retry = attempts <= max_retries
			judgement = {
				"sufficient": False,
				"action": "retry" if can_retry else "refuse",
				"reason": "no_hit",
				"can_retry": can_retry,
			}
		else:
			top_score = float(citations[0].get("score") or 0.0)
			# 低于阈值必须走正式 refuse（refused=true），禁止落到 generate 再靠模型口头「未覆盖」
			weak = min_score > 0 and top_score < min_score
			# table fallback（软问法）：有命中即生成，不因分数卡死 stub/结构化表
			if query_type == "table" and not weak:
				judgement = {
					"sufficient": True,
					"action": "generate",
					"reason": "table_fallback_llm",
					"top_score": top_score,
					"min_score": min_score,
				}
			elif weak:
				can_retry = attempts <= max_retries
				judgement = {
					"sufficient": False,
					"action": "retry" if can_retry else "refuse",
					"reason": "weak_match",
					"top_score": top_score,
					"min_score": min_score,
					"can_retry": can_retry,
				}
			else:
				judgement = {
					"sufficient": True,
					"action": "generate",
					"reason": "ok",
					"top_score": top_score,
					"min_score": min_score,
				}

		# Attach human-facing refuse reason early for refuse path.
		refuse_reason = None
		if judgement["action"] == "refuse":
			refuse_reason = judgement["reason"]

		return {
			"judgement": judgement,
			"refuse_reason": refuse_reason,
			"retrieval_debug": _merge_debug(state, judgement=judgement, library_name=library_name),
		}

	def route_after_judge(state: AskState) -> Literal["retry", "generate", "refuse"]:
		action = (state.get("judgement") or {}).get("action") or "generate"
		if action == "retry":
			return "retry"
		if action == "refuse":
			return "refuse"
		return "generate"

	def route_after_retry(state: AskState) -> Literal["retrieve", "table_retrieve"]:
		plan = state.get("retrieval_plan") or {}
		if (
			str(state.get("query_type") or "") == "table"
			or plan.get("path") == "precise"
			or state.get("upgrade") == "precise"
		):
			return "table_retrieve"
		return "retrieve"

	def retry_node(state: AskState) -> AskState:
		"""Broaden query once, then re-enter retrieve."""
		base = state.get("rewritten_question") or state["question"]
		reason = (state.get("judgement") or {}).get("reason")
		if reason == "weak_match":
			broadened = f"{base} 相关制度 条款 规定"
		else:
			broadened = f"{base} 关键词 概要"
		return {
			"rewritten_question": broadened,
			"retrieval_debug": _merge_debug(
				state,
				retry={"from": base, "to": broadened, "reason": reason},
			),
		}

	def refuse_node(state: AskState) -> AskState:
		reason = (state.get("judgement") or {}).get("reason") or state.get("refuse_reason") or "no_hit"
		library_name = _library_label(state.get("library_id"))
		if reason == "weak_match":
			answer = weak_match_answer(library_name=library_name)
			# Keep weak citations for transparency (DustyKB behavior).
			citations = state.get("citations") or []
		else:
			answer = no_match_answer(library_name=library_name)
			citations = []
		return {
			"answer": answer,
			"citations": citations,
			"refused": True,
			"refuse_reason": reason,
			"retrieval_debug": _merge_debug(state, generate="refuse", refuse_reason=reason),
		}

	def generate_node(state: AskState) -> AskState:
		t0 = time.perf_counter()
		citations = state.get("citations") or []
		execution = state.get("table_execution") or {}
		tq = state.get("table_query_plan") or {}
		stream_mode = bool((state.get("retrieval_debug") or {}).get("stream"))
		# 结构化表格结果：优先用程序答案（LLM 仅在 live 路径解释）；stub 直接给 answer_text
		if (
			str(state.get("query_type") or "") == "table"
			and execution.get("ok")
			and tq.get("confident")
			and execution.get("answer_text")
		):
			if mode == "stub":
				answer = str(execution["answer_text"])
			else:
				# live：把计算结果注入 generate_fn 上下文
				ctx_question = _format_table_generate_context(
					state["question"], citations, execution
				)
				answer = generate_fn(ctx_question, citations)
		else:
			answer = generate_fn(state["question"], citations)
		debug = _merge_debug(
			state,
			generate=mode,
			table_query_plan=tq or None,
			table_execution=execution or None,
		)
		# stream：真实生成在 iter_ask_events 结束时计时；此处跳过以免 TTFB 污染
		if not stream_mode:
			append_stage(
				debug,
				name="generate",
				duration_ms=(time.perf_counter() - t0) * 1000,
				detail={
					"mode": mode,
					"model": settings.chat_model if mode == "live" else None,
					"input_tokens": None,
					"output_tokens": None,
				},
			)
		return {
			"answer": answer,
			"refused": False,
			"refuse_reason": None,
			"retrieval_debug": debug,
		}

	graph: StateGraph[AskState] = StateGraph(AskState)
	graph.add_node("query_router", query_router_node)
	graph.add_node("build_retrieval_plan", build_plan_node)
	graph.add_node("clarify", clarify_node)
	graph.add_node("build_table_plan", build_table_plan_node)
	graph.add_node("table_retrieve", table_retrieve_node)
	graph.add_node("table_execute", table_execute_node)
	graph.add_node("rewrite", rewrite_node)
	graph.add_node("retrieve", retrieve_node)
	graph.add_node("judge", judge_node)
	graph.add_node("retry", retry_node)
	graph.add_node("generate", generate_node)
	graph.add_node("refuse", refuse_node)
	graph.set_entry_point("query_router")
	graph.add_edge("query_router", "build_retrieval_plan")
	graph.add_conditional_edges(
		"build_retrieval_plan",
		route_after_plan,
		{"clarify": "clarify", "rewrite": "rewrite", "table": "build_table_plan"},
	)
	graph.add_edge("clarify", END)
	graph.add_edge("build_table_plan", "table_retrieve")
	graph.add_edge("table_retrieve", "table_execute")
	graph.add_conditional_edges(
		"table_execute",
		route_after_table_execute,
		{"judge": "judge", "end": END},
	)
	graph.add_edge("rewrite", "retrieve")
	graph.add_conditional_edges(
		"retrieve",
		route_after_retrieve,
		{"upgrade_precise": "build_table_plan", "judge": "judge"},
	)
	graph.add_conditional_edges(
		"judge",
		route_after_judge,
		{"retry": "retry", "generate": "generate", "refuse": "refuse"},
	)
	graph.add_conditional_edges(
		"retry",
		route_after_retry,
		{"retrieve": "retrieve", "table_retrieve": "table_retrieve"},
	)
	graph.add_edge("generate", END)
	graph.add_edge("refuse", END)
	return graph.compile()


class AskGraphService:
	"""query_router → plan → rewrite → retrieve → judge → (retry) → generate | refuse | clarify."""

	def __init__(
		self,
		settings: Settings | None = None,
		*,
		capability: RuntimeCapability | None = None,
		retrieve_fn: RetrieveFn | None = None,
		generate_fn: GenerateFn | None = None,
		session_memory: SessionMemory | None = None,
		retrieval_service: RetrievalService | None = None,
		access_scope: AccessScope | None = None,
	) -> None:
		self.settings = settings or get_settings()
		self.capability = capability or resolve_runtime(self.settings)
		self.mode = self.capability.effective_mode
		self.session_memory = session_memory or default_session_memory
		self.access_scope = resolve_access_scope(self.settings, access_scope)
		self._retrieval_service = retrieval_service
		self._chat: ChatService | None = None

		if retrieve_fn is not None:
			self._retrieve = retrieve_fn
		elif self.mode == "live":
			retrieval = retrieval_service or RetrievalService(
				self.settings,
				access_scope=self.access_scope,
			)
			self._retrieval_service = retrieval

			def live_retrieve(
				query: str,
				library_id: str | None,
				top_k: int,
				filters: dict[str, Any] | None = None,
			) -> list[dict[str, Any]]:
				if not library_id or not str(library_id).strip():
					raise ValueError("library_id is required for live retrieval")
				return retrieval.search(
					query=query,
					library_id=library_id,
					top_k=top_k,
					filters=filters,
					record_type=str((filters or {}).get("record_type") or "chunk"),
				)

			self._retrieve = live_retrieve
		else:
			self._retrieve = stub_retrieve

		if generate_fn is not None:
			self._generate = generate_fn
		elif self.mode == "live":
			self._chat = ChatService(self.settings)

			def live_generate(question: str, citations: list[dict[str, Any]]) -> str:
				assert self._chat is not None
				return self._chat.answer(question=question, context=_format_context(citations))

			self._generate = live_generate
		else:
			self._generate = stub_generate

		load_table_groups_fn: LoadTableGroupsFn | None = None
		if self._retrieval_service is not None:
			retrieval_for_table = self._retrieval_service

			def _load_table_groups(
				*,
				doc_id: str,
				table_id: str,
				document_version_id: str | None = None,
				library_id: str | None = None,
			) -> list[dict[str, Any]]:
				return retrieval_for_table.load_table_groups(
					doc_id=doc_id,
					table_id=table_id,
					document_version_id=document_version_id,
					library_id=library_id,
				)

			load_table_groups_fn = _load_table_groups

		# Keep for iter_ask_events — it rebuilds the graph with a capture generate_fn.
		self._load_table_groups_fn = load_table_groups_fn

		self._graph = build_ask_graph(
			settings=self.settings,
			retrieve_fn=self._retrieve,
			generate_fn=self._generate,
			mode=self.mode,
			load_table_groups_fn=load_table_groups_fn,
			access_scope=self.access_scope,
		)

	def _merge_retrieval_debug(self, debug: dict[str, Any]) -> dict[str, Any]:
		merged = dict(debug)
		if self._retrieval_service is not None and getattr(self._retrieval_service, "last_debug", None):
			merged.update(self._retrieval_service.last_debug)
		return merged

	def _memory_session_id(self, session_id: str) -> str:
		return f"{self.access_scope.cache_key()}:{session_id}"

	def ask(
		self,
		*,
		question: str,
		library_id: str | None = None,
		session_id: str | None = None,
		trace_id: str | None = None,
	) -> AskResponse:
		started_at = time.perf_counter()
		resolved_trace = resolve_trace_id(request_id=trace_id)
		resolved_session = session_id or str(uuid.uuid4())
		memory_session = self._memory_session_id(resolved_session)
		history: list[dict[str, str]] = []
		if self.settings.session_memory_enabled:
			history = self.session_memory.load(
				memory_session,
				limit=self.settings.session_memory_max_turns * 2,
			)

		state = self._graph.invoke(
			{
				"session_id": resolved_session,
				"question": question,
				"library_id": library_id,
				"history": history,
				"trace_id": resolved_trace,
				"retrieval_debug": initial_ask_debug(
					trace_id=resolved_trace,
					question=question,
					library_id=library_id,
					requested_mode=self.capability.requested_mode,
					effective_mode=self.capability.effective_mode,
					degraded=self.capability.degraded,
					reasons=list(self.capability.reasons),
					session_memory=self.settings.session_memory_enabled,
					hybrid_enabled=self.settings.hybrid_enabled,
					stream=False,
				),
			}
		)

		if self.settings.session_memory_enabled:
			self.session_memory.append(memory_session, "user", question)
			self.session_memory.append(memory_session, "assistant", state.get("answer") or "")

		raw_citations = state.get("citations") or []
		citations = _to_citation_models(raw_citations)
		debug = self._merge_retrieval_debug(state.get("retrieval_debug") or {})
		debug.setdefault("trace_id", resolved_trace)
		debug.setdefault("question_hash", question_hash(question))
		debug.setdefault("library_id", library_id)
		judge = state.get("judgement") or debug.get("judgement")
		plan = state.get("retrieval_plan") or debug.get("retrieval_plan")
		if isinstance(plan, dict):
			plan = dict(plan)
			if state.get("table_query_plan"):
				plan["table_query_plan"] = state["table_query_plan"]
			elif debug.get("table_query_plan"):
				plan["table_query_plan"] = debug["table_query_plan"]
			if state.get("table_execution"):
				plan["table_execution"] = state["table_execution"]
			elif debug.get("table_execution"):
				plan["table_execution"] = debug["table_execution"]
		query_type = state.get("query_type") or debug.get("query_type")
		rewrite_mode = debug.get("rewrite")
		finalize_ask_debug(debug, started_at=started_at, truncated=False)
		persist = _persist_turn(
			session_id=resolved_session,
			library_id=library_id,
			question=question,
			answer=state["answer"],
			citations=citations,
			mode=self.mode,
			refused=bool(state.get("refused")),
			refuse_reason=state.get("refuse_reason"),
			query_type=str(query_type) if query_type else None,
			retrieval_plan=plan if isinstance(plan, dict) else None,
			retrieval_debug=debug,
			rewrite=str(rewrite_mode) if rewrite_mode else None,
			rewritten_query=state.get("rewritten_question"),
			judge=judge if isinstance(judge, dict) else None,
			document_version_id=_single_document_version_id(citations),
			tenant_id=self.access_scope.tenant_id,
			workspace_id=self.access_scope.workspace_id,
			principal_id=self.access_scope.principal_id,
		)
		emit_ask_trace(debug)
		visibility = _retrieval_visibility(debug)
		return AskResponse(
			session_id=resolved_session,
			question=question,
			answer=state["answer"],
			citations=citations,
			mode=self.mode,
			access_scope=self.access_scope,
			refused=bool(state.get("refused")),
			refuse_reason=state.get("refuse_reason"),
			retrieval_debug=debug,
			persisted=bool(persist["persisted"]),
			persist_error=persist.get("persist_error"),
			hybrid_failed=bool(visibility["hybrid_failed"]),
			rerank_failed=bool(visibility["rerank_failed"]),
			retrieval_mode=str(visibility["retrieval_mode"]),
		)

	def iter_ask_events(
		self,
		*,
		question: str,
		library_id: str | None = None,
		session_id: str | None = None,
		trace_id: str | None = None,
	):
		"""Yield SSE-friendly dicts: meta → citations → token* → done | error."""
		started_at = time.perf_counter()
		resolved_trace = resolve_trace_id(request_id=trace_id)
		resolved_session = session_id or str(uuid.uuid4())
		memory_session = self._memory_session_id(resolved_session)
		history: list[dict[str, str]] = []
		if self.settings.session_memory_enabled:
			history = self.session_memory.load(
				memory_session,
				limit=self.settings.session_memory_max_turns * 2,
			)

		held: dict[str, Any] = {"citations": [], "question": question}

		def capture_generate(q: str, citations: list[dict[str, Any]]) -> str:
			held["citations"] = citations
			held["question"] = q
			return ""

		graph = build_ask_graph(
			settings=self.settings,
			retrieve_fn=self._retrieve,
			generate_fn=capture_generate,
			mode=self.mode,
			load_table_groups_fn=self._load_table_groups_fn,
			access_scope=self.access_scope,
		)
		state = graph.invoke(
			{
				"session_id": resolved_session,
				"question": question,
				"library_id": library_id,
				"history": history,
				"trace_id": resolved_trace,
				"retrieval_debug": initial_ask_debug(
					trace_id=resolved_trace,
					question=question,
					library_id=library_id,
					requested_mode=self.capability.requested_mode,
					effective_mode=self.capability.effective_mode,
					degraded=self.capability.degraded,
					reasons=list(self.capability.reasons),
					session_memory=self.settings.session_memory_enabled,
					hybrid_enabled=self.settings.hybrid_enabled,
					stream=True,
				),
			}
		)
		debug = self._merge_retrieval_debug(state.get("retrieval_debug") or {})
		debug.setdefault("trace_id", resolved_trace)
		debug.setdefault("question_hash", question_hash(question))
		debug.setdefault("library_id", library_id)
		visibility = _retrieval_visibility(debug)
		refused = bool(state.get("refused"))
		raw_citations = state.get("citations") or held.get("citations") or []
		citations = _to_citation_dicts(raw_citations)
		citation_models = _to_citation_models(raw_citations)
		truncated = False
		finished = False
		persist: dict[str, Any] = {"persisted": False, "persist_error": None}
		answer = state.get("answer") or ""

		def _finish(*, mark_truncated: bool) -> None:
			nonlocal finished, debug, persist, answer
			if finished:
				return
			finished = True
			finalize_ask_debug(debug, started_at=started_at, truncated=mark_truncated)
			judge = state.get("judgement") or debug.get("judgement")
			plan = state.get("retrieval_plan") or debug.get("retrieval_plan")
			if isinstance(plan, dict):
				plan = dict(plan)
				if state.get("table_query_plan"):
					plan["table_query_plan"] = state["table_query_plan"]
				elif debug.get("table_query_plan"):
					plan["table_query_plan"] = debug["table_query_plan"]
				if state.get("table_execution"):
					plan["table_execution"] = state["table_execution"]
				elif debug.get("table_execution"):
					plan["table_execution"] = debug["table_execution"]
			query_type_final = state.get("query_type") or debug.get("query_type")
			rewrite_mode = debug.get("rewrite")
			persist = _persist_turn(
				session_id=resolved_session,
				library_id=library_id,
				question=question,
				answer=answer,
				citations=citation_models,
				mode=self.mode,
				refused=refused,
				refuse_reason=state.get("refuse_reason"),
				query_type=str(query_type_final) if query_type_final else None,
				retrieval_plan=plan if isinstance(plan, dict) else None,
				retrieval_debug=debug,
				rewrite=str(rewrite_mode) if rewrite_mode else None,
				rewritten_query=state.get("rewritten_question"),
				judge=judge if isinstance(judge, dict) else None,
				document_version_id=_single_document_version_id(citation_models),
				tenant_id=self.access_scope.tenant_id,
				workspace_id=self.access_scope.workspace_id,
				principal_id=self.access_scope.principal_id,
			)
			emit_ask_trace(debug)

		try:
			yield {
				"event": "meta",
				"data": {
					"session_id": resolved_session,
					"mode": self.mode,
					"refused": refused,
					"refuse_reason": state.get("refuse_reason"),
					"trace_id": resolved_trace,
					"hybrid_failed": visibility["hybrid_failed"],
					"rerank_failed": visibility["rerank_failed"],
					"retrieval_mode": visibility["retrieval_mode"],
				},
			}
			yield {"event": "citations", "data": citations}

			execution = state.get("table_execution") or debug.get("table_execution") or {}
			tq = state.get("table_query_plan") or debug.get("table_query_plan") or {}
			query_type = str(state.get("query_type") or debug.get("query_type") or "")
			# 与 generate_node 对齐：结构化 table 结果须注入 stream 上下文，避免 LLM 自行改算
			stream_question = question
			if (
				query_type == "table"
				and isinstance(execution, dict)
				and execution.get("ok")
				and isinstance(tq, dict)
				and tq.get("confident")
				and execution.get("answer_text")
			):
				stream_question = _format_table_generate_context(
					question, raw_citations, execution
				)

			t_gen = time.perf_counter()
			if refused:
				answer = state.get("answer") or ""
				step = 12 if len(answer) > 24 else max(1, len(answer) or 1)
				for offset in range(0, len(answer), step):
					yield {"event": "token", "data": answer[offset : offset + step]}
			elif self.mode == "live" and self._chat is not None and raw_citations:
				parts: list[str] = []
				try:
					for token in self._chat.stream_answer(
						question=stream_question,
						context=_format_context(raw_citations),
					):
						parts.append(token)
						yield {"event": "token", "data": token}
				except Exception as exc:
					logger.exception("ask.stream.llm_failed")
					append_stage(
						debug,
						name="generate",
						duration_ms=(time.perf_counter() - t_gen) * 1000,
						ok=False,
						detail={
							"mode": self.mode,
							"model": self.settings.chat_model,
							"input_tokens": None,
							"output_tokens": None,
						},
					)
					truncated = True
					_finish(mark_truncated=True)
					yield {"event": "error", "data": {"message": f"流式生成失败：{exc}"}}
					return
				answer = "".join(parts).strip()
				state["answer"] = answer
			else:
				answer = self._generate(stream_question, raw_citations)
				state["answer"] = answer
				step = 12 if len(answer) > 24 else max(1, len(answer) or 1)
				for offset in range(0, len(answer), step):
					yield {"event": "token", "data": answer[offset : offset + step]}

			append_stage(
				debug,
				name="generate",
				duration_ms=(time.perf_counter() - t_gen) * 1000,
				detail={
					"mode": self.mode,
					"model": self.settings.chat_model if self.mode == "live" else None,
					"input_tokens": None,
					"output_tokens": None,
				},
			)

			answer = state.get("answer") or ""
			if self.settings.session_memory_enabled:
				self.session_memory.append(memory_session, "user", question)
				self.session_memory.append(memory_session, "assistant", answer)

			_finish(mark_truncated=False)
			yield {
				"event": "done",
				"data": {
					"session_id": resolved_session,
					"question": question,
					"answer": answer,
					"citations": citations,
					"mode": self.mode,
					"refused": refused,
					"refuse_reason": state.get("refuse_reason"),
					"trace_id": resolved_trace,
					"retrieval_debug": debug,
					"persisted": bool(persist["persisted"]),
					"persist_error": persist.get("persist_error"),
					"hybrid_failed": visibility["hybrid_failed"],
					"rerank_failed": visibility["rerank_failed"],
					"retrieval_mode": visibility["retrieval_mode"],
				},
			}
		except GeneratorExit:
			truncated = True
			_finish(mark_truncated=True)
			raise
		except Exception:
			truncated = True
			_finish(mark_truncated=True)
			raise
		finally:
			if not finished:
				_finish(mark_truncated=truncated)
