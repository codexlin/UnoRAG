"""AskGraph generation node + citation reconcile / context formatting."""

from __future__ import annotations

import time
from types import SimpleNamespace
from typing import Any

from app.graph.context import AskGraphContext
from app.graph.messages import build_generate_messages, history_for_generate
from app.graph.nodes.common import _merge_debug
from app.graph.state import AskState
from app.schemas import Citation
from app.services.ask_trace import append_stage
from app.services.generation_contract import (
	citation_from_hit,
	reconcile_generation_output,
)


def _to_citation_models(raw_citations: list[dict[str, Any]]) -> list[Citation]:
	return [citation_from_hit(item) for item in raw_citations]


def _finalize_generation_output(
	*,
	answer: str,
	raw_citations: list[dict[str, Any]],
	allowed_hits: list[dict[str, Any]] | None = None,
	debug: dict[str, Any] | None = None,
) -> tuple[str, list[Citation]]:
	"""generation 共享出口：结构化校验 + 命中集对账（非法引用剔除，不 500）。"""
	hits = allowed_hits if allowed_hits is not None else raw_citations
	result = reconcile_generation_output(
		answer=answer,
		citations=raw_citations,
		allowed_hits=hits,
	)
	if debug is not None:
		debug["citation_reconcile"] = result.debug_fields()
	return result.answer, result.citations


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


def _table_execution_context_block(execution: dict[str, Any] | None) -> str:
	"""表格路径：把代码侧计算结果交给 LLM 解释（禁止心算）。"""
	if not execution or not execution.get("ok"):
		return ""
	return (
		"【已由程序计算，请据此解释，勿自行改算】\n"
		f"operation={execution.get('operation')} column={execution.get('column')} "
		f"operator={execution.get('operator')} value={execution.get('value')}\n"
		f"answer_text={execution.get('answer_text')}\n"
		f"matched_count={execution.get('matched_count')} "
		f"matched_rows_truncated={execution.get('matched_rows_truncated')}\n"
		f"matched_rows={execution.get('matched_rows')}"
	)


def _format_generate_context(
	citations: list[dict[str, Any]],
	execution: dict[str, Any] | None = None,
) -> str:
	parts = [_format_context(citations)]
	table_block = _table_execution_context_block(execution)
	if table_block:
		parts.append(table_block)
	return "\n\n".join(parts)


def _format_table_generate_context(
	question: str,
	citations: list[dict[str, Any]],
	execution: dict[str, Any] | None,
) -> str:
	"""Deprecated blob helper — prefer build_generate_messages + _format_generate_context."""
	parts = [_format_generate_context(citations, execution)]
	parts.append(f"用户问题：{question}")
	return "\n\n".join(parts)


def build_generation_nodes(ctx: AskGraphContext) -> SimpleNamespace:
	def generate_node(state: AskState) -> AskState:
		t0 = time.perf_counter()
		citations = state.get("citations") or []
		execution = state.get("table_execution") or {}
		tq = state.get("table_query_plan") or {}
		stream_mode = bool((state.get("retrieval_debug") or {}).get("stream"))
		history = state.get("history") or []
		gen_history = history_for_generate(history)
		question = (state.get("question") or "").strip()
		# 结构化表格结果：优先用程序答案（LLM 仅在 live 路径解释）；stub 直接给 answer_text
		if (
			str(state.get("query_type") or "") == "table"
			and execution.get("ok")
			and tq.get("confident")
			and execution.get("answer_text")
		):
			if ctx.mode == "stub":
				answer = str(execution["answer_text"])
			else:
				# live：把计算结果注入资料上下文；history 仍为完整多轮 messages
				messages = build_generate_messages(
					question=question,
					context=_format_generate_context(citations, execution),
					history=gen_history,
				)
				answer = ctx.generate(messages, citations)
		else:
			messages = build_generate_messages(
				question=question,
				context=_format_generate_context(citations),
				history=gen_history,
			)
			answer = ctx.generate(messages, citations)
		debug = _merge_debug(
			state,
			generate=ctx.mode,
			generate_history_turns=len(gen_history),
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
					"mode": ctx.mode,
					"model": ctx.settings.chat_model if ctx.mode == "live" else None,
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
	return SimpleNamespace(generate=generate_node)
