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
	"总价",
	"单价",
	"统计",
	"多少行",
	"表里",
	"最低报价",
	"最高报价",
	"中标金额",
	"金额最高",
	"金额最低",
	"最高金额",
	"最低金额",
	"最大金额",
	"最小金额",
)
# 明确「忽略汇总 / 按明细聚合」时优先 table，避免被「汇总」打成 summary。
TABLE_DETAIL_OVERRIDE_HINTS = (
	"忽略文末汇总",
	"忽略汇总说明",
	"忽略汇总",
	"按表格",
	"按表中",
	"逐行比较",
	"逐行",
	"条明细",
	"明细逐行",
	"明细里",
	"明细中",
)
TABLE_AGG_HINTS = (
	"最大和最小",
	"最大最小",
	"最大与最小",
	"最高和最低",
	"最高最低",
	"金额最大",
	"金额最小",
	"最大的",
	"最小的",
)
# 问文末/表尾「汇总说明」本身的事实 → 走 table（召回 table_summary），而非 section 总结。
TABLE_SUMMARY_LOOKUP_HINTS = (
	"文末汇总说明",
	"文末汇总",
	"汇总说明声称",
	"汇总说明中",
	"汇总说明里",
	"汇总说明称",
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


def looks_like_table_detail_query(question: str) -> bool:
	"""表格明细聚合/比较：即使含「汇总」也应走 table，不被 summary 劫持。"""
	q = (question or "").strip()
	if not q:
		return False
	if any(hint in q for hint in TABLE_DETAIL_OVERRIDE_HINTS):
		# 「忽略汇总…按表格…最大最小」或「明细里最大最小」
		if any(hint in q for hint in TABLE_AGG_HINTS) or any(
			token in q for token in TABLE_KEYWORDS
		):
			return True
		if "明细" in q or "表格" in q or "表中" in q or "逐行" in q:
			return True
	if ("明细" in q or "表格" in q) and any(hint in q for hint in TABLE_AGG_HINTS):
		return True
	return False


def looks_like_table_summary_lookup(question: str) -> bool:
	"""问表尾/文末汇总说明段落本身（共收录、占比等），需召回 table_summary。"""
	q = (question or "").strip()
	if not q:
		return False
	# 与明细覆盖互斥：明确忽略汇总时不算 summary-lookup
	if looks_like_table_detail_query(q):
		return False
	return any(hint in q for hint in TABLE_SUMMARY_LOOKUP_HINTS)


def classify_query(
	question: str,
	*,
	history: list[dict[str, str]] | None = None,
) -> tuple[QueryType, str]:
	"""按规则返回 (query_type, reason)。

	阶段1表格短路写松：仅高置信表格信号 → query_type=table；
	弱「表/供应商」类词不再硬判 table（交给 path=fast + 阶段2升级）。

	优先级：ambiguous → section_lookup → high-confidence table shortcircuit →
	summary → compare → follow_up → fact。
	"""
	# 延迟导入：避免 ask_route ↔ query_router 循环
	from app.services.ask_route import (
		looks_like_high_confidence_table_shortcircuit,
		stage1_table_route_reason,
	)

	q = (question or "").strip()
	if not q or q in AMBIGUOUS_EXACT or len(q) <= 1:
		return "ambiguous", "too_short_or_vague"

	if looks_like_section_lookup(q):
		return "section_lookup", "section_lookup_pattern"

	# 阶段1：高置信表格短路（含 table_detail_override / table_summary_lookup）
	if looks_like_high_confidence_table_shortcircuit(q):
		return "table", stage1_table_route_reason(q)

	if any(token in q for token in SUMMARY_KEYWORDS):
		return "summary", "summary_keyword"
	# 弱表格词不再短路；阶段2 用命中证据 upgrade
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
