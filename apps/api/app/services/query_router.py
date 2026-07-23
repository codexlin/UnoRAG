"""规则版 QueryRouter — Phase 1+2A：分类 intent，不引入 LLM classifier。"""

from __future__ import annotations

from typing import Any, Literal

from app.services.ingest.index_record import looks_like_section_lookup

QueryType = Literal[
	"fact",
	"follow_up",
	"summary",
	"compare",
	"table",
	"section_lookup",
	"ambiguous",
]

SUMMARY_KEYWORDS = (
	"总结",
	"概括",
	"综述",
	"汇总",
	"梳理",
	"概述",
	"归纳",
	"整体介绍",
	"本库有哪些",
	"全部内容",
)
TABLE_KEYWORDS = (
	"表格",
	"表中",
	"列表",
	"列出",
	"哪几行",
	"供应商",
	"报价",
	"统计",
	"多少行",
	"表里",
)
COMPARE_KEYWORDS = (
	"对比",
	"区别",
	"差异",
	"相比",
	"有什么不同",
	"优缺点",
	"vs",
	"VS",
	"versus",
)
FOLLOW_UP_TOKENS = (
	"呢",
	"还有",
	"另外",
	"继续",
	"上述",
	"刚才",
	"那逾期",
	"那如果",
	"然后呢",
)
FOLLOW_UP_PRONOUNS = ("它", "这个", "那个", "上述", "刚才")
AMBIGUOUS_EXACT = {"?", "？", "嗯", "啊", "哦", "那个", "这个", "怎么样", "如何", "什么"}


def classify_query(
	question: str,
	*,
	history: list[dict[str, str]] | None = None,
) -> tuple[QueryType, str]:
	"""按规则返回 (query_type, reason)。

	优先级：ambiguous → section_lookup → summary → table → compare → follow_up → fact。
	"""
	q = (question or "").strip()
	if not q or q in AMBIGUOUS_EXACT or len(q) <= 1:
		return "ambiguous", "too_short_or_vague"

	if looks_like_section_lookup(q):
		return "section_lookup", "section_lookup_pattern"

	if any(token in q for token in SUMMARY_KEYWORDS):
		return "summary", "summary_keyword"
	if any(token in q for token in TABLE_KEYWORDS):
		return "table", "table_keyword"
	if any(token in q for token in COMPARE_KEYWORDS):
		return "compare", "compare_keyword"

	has_history = bool(
		history
		and any(
			(item.get("role") == "user" and (item.get("content") or "").strip())
			for item in history
		)
	)
	if has_history:
		# 有历史不等于追问：只在有明确承接词或指代词时进入 follow_up。
		needs_follow_up = any(token in q for token in FOLLOW_UP_TOKENS) or any(
			token in q for token in FOLLOW_UP_PRONOUNS
		)
		if needs_follow_up:
			return "follow_up", "history_follow_up"

	# 极短且无实质主题词 → ambiguous（无历史时）
	if len(q) <= 3:
		return "ambiguous", "too_short"

	return "fact", "default_fact"


def route_query(
	question: str,
	*,
	history: list[dict[str, str]] | None = None,
	library_id: str | None = None,
) -> dict[str, Any]:
	"""QueryRouter 入口：输出可落盘的分类结果。"""
	query_type, reason = classify_query(question, history=history)
	return {
		"query_type": query_type,
		"reason": reason,
		"library_id": library_id,
		"question": (question or "").strip(),
	}
