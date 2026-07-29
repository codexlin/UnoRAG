"""Ask 路由哲学：能确定的走捷径，不确定的找证据，证据不足就拒绝。

阶段1：高置信表格短路 → path=precise / precise_kind=table；其余 → path=fast。
阶段2：fast 命中强 table/table_summary + 数值/行列意图 → upgrade=precise。
"""

from __future__ import annotations

import re
from typing import Any

from app.services.query_router import (
	looks_like_table_detail_query,
	looks_like_table_summary_lookup,
)
from app.services.table_query import looks_like_numeric_table_query

# 阶段1：明显表格表面（写松——宁可漏过也不误抓文本）
_TABLE_SURFACE = (
	"表格",
	"表中",
	"表里",
	"明细",
	"逐行",
	"多少行",
	"哪几行",
	"列出",
)
# 强金额/报价信号：即使无「表」字也足够高置信（已验证行为）
_STRONG_PRICE_HINTS = (
	"最低报价",
	"最高报价",
	"中标金额",
	"金额最高",
	"金额最低",
	"最高金额",
	"最低金额",
	"最大金额",
	"最小金额",
	"金额最大",
	"金额最小",
)
_ROW_COL_INTENT = re.compile(
	r"(第\s*\d+\s*行|哪几行|多少行|几行|逐行|行列|第\s*\d+\s*列)"
)

# 阶段2：表命中视为「强」的最低分（相对排序后的 top table hit）
DEFAULT_UPGRADE_MIN_SCORE = 0.25


def looks_like_high_confidence_table_shortcircuit(question: str) -> bool:
	"""阶段1：仅明显表格信号才短路 precise。"""
	q = (question or "").strip()
	if not q:
		return False
	# 已钉死的高置信规则：明细覆盖 / 文末汇总查找
	if looks_like_table_detail_query(q):
		return True
	if looks_like_table_summary_lookup(q):
		return True
	# 「表格」是明确结构信号；「表中/表里」可能只是“申请表中”这类
	# 扫描文本表单，必须先走统一召回，实际命中 TableIR 后再阶段2升级。
	if "表格" in q:
		return True
	has_surface = any(token in q for token in _TABLE_SURFACE)
	has_strong_price = any(token in q for token in _STRONG_PRICE_HINTS)
	numeric = looks_like_numeric_table_query(q)
	row_col = bool(_ROW_COL_INTENT.search(q))
	if has_surface and (numeric or row_col or "列出" in q or "供应商" in q or "报价" in q):
		return True
	if has_strong_price:
		return True
	# 实体+总价/单价 等 lookup（无「表」字也可能是表题；仍偏保守：需数值意图）
	if numeric and any(token in q for token in ("总价", "单价", "报价", "金额", "供应商")):
		return True
	return False


def stage1_table_route_reason(question: str) -> str:
	"""阶段1短路时的可解释 reason（兼容既有 override/lookup 命名）。"""
	q = (question or "").strip()
	if looks_like_table_detail_query(q):
		return "table_detail_override"
	if looks_like_table_summary_lookup(q):
		return "table_summary_lookup"
	return "table_shortcircuit"


def strong_table_hit(
	citations: list[dict[str, Any]],
	*,
	min_score: float = DEFAULT_UPGRADE_MIN_SCORE,
) -> dict[str, Any] | None:
	"""返回最强 table / table_summary 命中；不足则 None。"""
	candidates = [
		item
		for item in citations
		if str(item.get("record_type") or "") in {"table", "table_summary"}
		and item.get("table_id")
	]
	if not candidates:
		return None
	top = max(candidates, key=lambda item: float(item.get("score") or 0.0))
	if float(top.get("score") or 0.0) < float(min_score):
		return None
	return top


def should_upgrade_fast_to_precise_table(
	question: str,
	citations: list[dict[str, Any]],
	*,
	min_score: float = DEFAULT_UPGRADE_MIN_SCORE,
) -> tuple[bool, str]:
	"""阶段2：写死升级条件。返回 (upgrade, upgrade_reason)。"""
	q = (question or "").strip()
	if not q or not citations:
		return False, ""
	hit = strong_table_hit(citations, min_score=min_score)
	if hit is None:
		return False, ""
	numeric = looks_like_numeric_table_query(q)
	row_col = bool(_ROW_COL_INTENT.search(q))
	summary_lookup = looks_like_table_summary_lookup(q)
	detail = looks_like_table_detail_query(q)
	if not (numeric or row_col or summary_lookup or detail):
		return False, ""
	score = float(hit.get("score") or 0.0)
	rt = str(hit.get("record_type") or "table")
	intent = (
		"query_has_numerical_intent"
		if numeric
		else (
			"query_has_row_col_intent"
			if row_col
			else ("table_summary_lookup" if summary_lookup else "table_detail_override")
		)
	)
	reason = f"{rt}(top, score={score:.2f}) + {intent}"
	return True, reason


def table_overview_downgrade_reason(
	*,
	plan_confident: bool,
	must_compute: bool,
	table_complete: bool,
) -> str | None:
	"""概述降级原因；若不应降级则 None。"""
	if must_compute:
		return None
	if plan_confident and table_complete:
		return None
	if not table_complete and not plan_confident:
		return "table_evidence_overview"
	if not plan_confident:
		return "plan_not_confident_overview"
	return "non_numeric_table_overview"
