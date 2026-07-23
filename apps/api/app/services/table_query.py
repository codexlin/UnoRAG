"""Lightweight TableQueryPlan — 仅在解析有把握时做结构化过滤/聚合；否则回退 table+LLM。"""

from __future__ import annotations

import re
from typing import Any, Literal

TableOp = Literal["lookup", "filter", "max", "min", "count", "fallback"]
TableOperator = Literal[">", ">=", "<", "<=", "=="]

# 列名别名：问法 → 可能命中的表头片段（匹配时仍需与真实 headers 对齐）
_COLUMN_ALIASES: dict[str, tuple[str, ...]] = {
	"总价": ("总价", "报价", "金额", "price", "amount"),
	"单价": ("单价", "unit"),
	"供应商": ("供应商", "厂商", "公司", "vendor", "supplier"),
	"数量": ("数量", "qty", "quantity"),
	"产品": ("产品", "品名", "名称", "product"),
	"交付": ("交付", "交期", "周期"),
	"质保": ("质保", "保修"),
}

_CN_NUM = {
	"零": 0,
	"一": 1,
	"二": 2,
	"两": 2,
	"三": 3,
	"四": 4,
	"五": 5,
	"六": 6,
	"七": 7,
	"八": 8,
	"九": 9,
	"十": 10,
}

_NUMERIC_INTENT = re.compile(
	r"(超过|大于|小于|不低于|不高于|至少|最多|最低|最高|最大|最小|多少行|几行|统计|平均值|>|>=|<|<=)"
)
_EQ_ENTITY = re.compile(
	r"(?P<entity>[\u4e00-\u9fffA-Za-z0-9]{1,24})(?P<col>总价|报价|单价|数量)"
)


def _parse_chinese_number(text: str) -> float | None:
	raw = (text or "").strip().replace(",", "").replace("，", "")
	if not raw:
		return None
	# 阿拉伯数字 + 可选 万/千
	m = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)\s*(万|千)?", raw)
	if m:
		val = float(m.group(1))
		unit = m.group(2)
		if unit == "万":
			val *= 10_000
		elif unit == "千":
			val *= 1_000
		return val
	# 十万 / 二十万 / 十
	m2 = re.fullmatch(r"([一二两三四五六七八九十]?十?)(万|千)?", raw)
	if m2 and m2.group(0):
		head = m2.group(1) or ""
		unit = m2.group(2)
		if head == "十":
			val = 10.0
		elif head.endswith("十") and len(head) == 2:
			val = float(_CN_NUM.get(head[0], 0)) * 10
		elif head in _CN_NUM:
			val = float(_CN_NUM[head])
		else:
			return None
		if unit == "万":
			val *= 10_000
		elif unit == "千":
			val *= 1_000
		return val
	# 「超过十万」里单独的「十万」
	if raw in {"十万", "十万块", "十万元"}:
		return 100_000.0
	if raw in {"一万", "万"}:
		return 10_000.0
	return None


def _match_header(column_hint: str | None, headers: list[str]) -> str | None:
	if not column_hint or not headers:
		return None
	hint = column_hint.strip()
	# 精确
	for h in headers:
		if h == hint:
			return h
	# 包含
	for h in headers:
		if hint in h or h in hint:
			return h
	# 别名
	aliases = _COLUMN_ALIASES.get(hint, (hint,))
	for alias in aliases:
		for h in headers:
			if alias in h or h in alias:
				return h
	return None


def looks_like_numeric_table_query(question: str) -> bool:
	q = (question or "").strip()
	if not q:
		return False
	if _NUMERIC_INTENT.search(q):
		return True
	if _EQ_ENTITY.search(q):
		return True
	return bool(re.search(r"[0-9]+万?", q) and ("价" in q or "报价" in q or "供应商" in q))


def build_table_query_plan(
	question: str,
	*,
	headers: list[str] | None = None,
) -> dict[str, Any]:
	"""从问题生成轻量 TableQueryPlan。

	不确定时：confident=False，operation=fallback — **不猜测**列名/运算符。
	若提供 headers，会尝试把 column 对齐到真实表头。
	"""
	q = (question or "").strip()
	plan: dict[str, Any] = {
		"operation": "fallback",
		"column": None,
		"operator": None,
		"value": None,
		"entity_column": None,
		"entity_value": None,
		"select_columns": [],
		"confident": False,
		"reason": "unparsed",
	}
	if not q:
		plan["reason"] = "empty"
		return plan

	# count
	if re.search(r"(多少行|几行|有几家|统计行数)", q):
		plan.update(
			{
				"operation": "count",
				"confident": True,
				"reason": "count_pattern",
				"select_columns": [],
			}
		)
		return _finalize_columns(plan, headers)

	# max / min
	if re.search(r"(最低|最小|最少).{0,6}(价|报价|总价|单价)", q) or re.search(
		r"(价|报价|总价|单价).{0,4}(最低|最小)", q
	):
		plan.update(
			{
				"operation": "min",
				"column": "总价",
				"confident": True,
				"reason": "min_pattern",
				"select_columns": ["供应商", "总价"],
			}
		)
		return _finalize_columns(plan, headers)
	if re.search(r"(最高|最大|最多).{0,6}(价|报价|总价|单价)", q) or re.search(
		r"(价|报价|总价|单价).{0,4}(最高|最大)", q
	):
		plan.update(
			{
				"operation": "max",
				"column": "总价",
				"confident": True,
				"reason": "max_pattern",
				"select_columns": ["供应商", "总价"],
			}
		)
		return _finalize_columns(plan, headers)

	# filter: 超过 / 大于 / 小于 …
	op_match = re.search(
		r"(超过|大于等于|大于|不少于|不低于|小于等于|小于|不高于|不多于)\s*"
		r"([0-9]+(?:\.[0-9]+)?\s*万?|[一二两三四五六七八九十]+万?|十万)",
		q,
	)
	if op_match:
		op_word = op_match.group(1)
		value = _parse_chinese_number(op_match.group(2))
		operator: TableOperator | None = {
			"超过": ">",
			"大于": ">",
			"大于等于": ">=",
			"不少于": ">=",
			"不低于": ">=",
			"小于": "<",
			"小于等于": "<=",
			"不高于": "<=",
			"不多于": "<=",
		}.get(op_word)
		if value is not None and operator:
			col = "总价" if ("价" in q or "报价" in q or "总价" in q) else None
			# 「超过十万的供应商」无显式「价」时，默认按总价/报价列过滤
			if col is None and ("供应商" in q or "哪" in q):
				col = "总价"
			if col is None:
				plan["reason"] = "filter_missing_column"
				return plan
			select = ["供应商", "总价"] if "供应商" in q or "哪" in q else ["总价"]
			plan.update(
				{
					"operation": "filter",
					"column": col,
					"operator": operator,
					"value": value,
					"select_columns": select,
					"confident": True,
					"reason": "filter_pattern",
				}
			)
			return _finalize_columns(plan, headers)

	# ASCII ops
	ascii_op = re.search(
		r"(总价|报价|单价|数量)\s*(>=|<=|>|<|==|=)\s*([0-9]+(?:\.[0-9]+)?)",
		q,
	)
	if ascii_op:
		op_raw = ascii_op.group(2)
		operator = "==" if op_raw == "=" else op_raw  # type: ignore[assignment]
		plan.update(
			{
				"operation": "filter",
				"column": ascii_op.group(1),
				"operator": operator,
				"value": float(ascii_op.group(3)),
				"select_columns": ["供应商", ascii_op.group(1)],
				"confident": True,
				"reason": "ascii_filter",
			}
		)
		return _finalize_columns(plan, headers)

	# lookup: 甲公司总价 / 乙科技的报价
	entity_m = _EQ_ENTITY.search(q)
	if entity_m:
		entity = entity_m.group("entity")
		col = entity_m.group("col")
		# 过滤掉「最低总价」之类已被上面覆盖的
		if entity in {"最低", "最高", "最大", "最小", "多少"}:
			plan["reason"] = "entity_ambiguous"
			return plan
		plan.update(
			{
				"operation": "lookup",
				"column": col if col != "报价" else "总价",
				"entity_column": "供应商",
				"entity_value": entity,
				"select_columns": ["供应商", col if col != "报价" else "总价"],
				"confident": True,
				"reason": "entity_lookup",
			}
		)
		return _finalize_columns(plan, headers)

	# 软表格问法：不自信，走 fallback
	if looks_like_numeric_table_query(q):
		plan["reason"] = "numeric_but_unparsed"
	else:
		plan["reason"] = "soft_table_fallback"
	return plan


def _finalize_columns(plan: dict[str, Any], headers: list[str] | None) -> dict[str, Any]:
	if not headers:
		return plan
	col = _match_header(plan.get("column"), headers)
	if plan.get("column") and col is None:
		plan["confident"] = False
		plan["reason"] = f"column_unresolved:{plan.get('column')}"
		plan["operation"] = "fallback"
		return plan
	if col:
		plan["column"] = col
	entity_col = _match_header(plan.get("entity_column"), headers)
	if plan.get("entity_column") and entity_col is None:
		plan["confident"] = False
		plan["reason"] = f"entity_column_unresolved:{plan.get('entity_column')}"
		plan["operation"] = "fallback"
		return plan
	if entity_col:
		plan["entity_column"] = entity_col
	resolved_select: list[str] = []
	for name in plan.get("select_columns") or []:
		matched = _match_header(str(name), headers)
		if matched and matched not in resolved_select:
			resolved_select.append(matched)
	plan["select_columns"] = resolved_select
	return plan


def _cell_number(raw: Any) -> float | None:
	text = str(raw or "").strip().replace(",", "").replace("，", "").replace("元", "")
	if not text:
		return None
	m = re.search(r"-?[0-9]+(?:\.[0-9]+)?", text)
	if not m:
		return None
	try:
		return float(m.group(0))
	except ValueError:
		return None


def _row_dict(headers: list[str], row: list[str], *, absolute_index: int) -> dict[str, Any]:
	cells = {headers[i]: (row[i] if i < len(row) else "") for i in range(len(headers))}
	cells["_row_index"] = absolute_index
	return cells


def execute_table_query(
	plan: dict[str, Any],
	*,
	headers: list[str],
	rows: list[list[str]],
	row_offset: int = 0,
) -> dict[str, Any]:
	"""在代码侧执行 TableQueryPlan；返回可归档的 execution result。"""
	op = str(plan.get("operation") or "fallback")
	result: dict[str, Any] = {
		"ok": False,
		"operation": op,
		"column": plan.get("column"),
		"operator": plan.get("operator"),
		"value": plan.get("value"),
		"matched_rows": [],
		"answer_value": None,
		"answer_text": None,
		"reason": "not_run",
	}
	if not plan.get("confident") or op == "fallback":
		result["reason"] = "fallback"
		return result
	if not headers:
		result["reason"] = "no_headers"
		return result

	plan = _finalize_columns(dict(plan), headers)
	if not plan.get("confident"):
		result["reason"] = str(plan.get("reason") or "column_unresolved")
		result["operation"] = "fallback"
		return result

	op = str(plan.get("operation") or "fallback")
	result["operation"] = op
	result["column"] = plan.get("column")
	result["operator"] = plan.get("operator")
	result["value"] = plan.get("value")

	indexed_rows = [
		_row_dict(headers, row, absolute_index=row_offset + i) for i, row in enumerate(rows)
	]

	def _project(row: dict[str, Any]) -> dict[str, Any]:
		cols = plan.get("select_columns") or headers
		out = {c: row.get(c) for c in cols if c in row}
		out["_row_index"] = row.get("_row_index")
		return out

	if op == "count":
		result.update(
			{
				"ok": True,
				"matched_rows": [_project(r) for r in indexed_rows],
				"answer_value": len(indexed_rows),
				"answer_text": f"共 {len(indexed_rows)} 行",
				"reason": "count",
			}
		)
		return result

	column = str(plan.get("column") or "")
	if op == "lookup":
		entity_col = str(plan.get("entity_column") or "")
		entity_val = str(plan.get("entity_value") or "").strip()
		matched = [
			r
			for r in indexed_rows
			if entity_val and entity_val in str(r.get(entity_col) or "")
		]
		if not matched:
			result.update({"ok": True, "matched_rows": [], "answer_text": "未找到匹配行", "reason": "no_match"})
			return result
		values = [matched[0].get(column)] if column else []
		answer = values[0] if values else None
		result.update(
			{
				"ok": True,
				"matched_rows": [_project(r) for r in matched],
				"answer_value": answer,
				"answer_text": f"{entity_val} 的{column}为 {answer}" if answer is not None else None,
				"reason": "lookup",
			}
		)
		return result

	if op == "filter":
		operator = str(plan.get("operator") or "")
		threshold = plan.get("value")
		if threshold is None or operator not in {">", ">=", "<", "<=", "=="}:
			result["reason"] = "bad_filter"
			return result
		matched = []
		for row in indexed_rows:
			num = _cell_number(row.get(column))
			if num is None:
				continue
			ok = {
				">": num > float(threshold),
				">=": num >= float(threshold),
				"<": num < float(threshold),
				"<=": num <= float(threshold),
				"==": num == float(threshold),
			}[operator]
			if ok:
				matched.append(row)
		labels = [
			f"{r.get(next((c for c in (plan.get('select_columns') or []) if c != column), column))}={r.get(column)}"
			for r in matched
		]
		result.update(
			{
				"ok": True,
				"matched_rows": [_project(r) for r in matched],
				"answer_value": [r.get(column) for r in matched],
				"answer_text": (
					f"满足 {column} {operator} {threshold} 的共 {len(matched)} 行："
					+ ("；".join(str(x) for x in labels[:8]) if labels else "无")
				),
				"reason": "filter",
			}
		)
		return result

	if op in {"max", "min"}:
		scored: list[tuple[float, dict[str, Any]]] = []
		for row in indexed_rows:
			num = _cell_number(row.get(column))
			if num is not None:
				scored.append((num, row))
		if not scored:
			result.update({"ok": True, "matched_rows": [], "answer_text": "无可用数值", "reason": "no_numeric"})
			return result
		best_val, best_row = (max if op == "max" else min)(scored, key=lambda x: x[0])
		result.update(
			{
				"ok": True,
				"matched_rows": [_project(best_row)],
				"answer_value": best_val,
				"answer_text": f"{'最高' if op == 'max' else '最低'}{column}为 {best_val}",
				"reason": op,
			}
		)
		return result

	result["reason"] = f"unsupported:{op}"
	return result


def merge_table_hits_for_execute(citations: list[dict[str, Any]]) -> dict[str, Any]:
	"""合并检索到的 table records（同 table_id 优先取分最高的一组行）。"""
	best: dict[str, Any] | None = None
	for item in citations:
		if str(item.get("record_type") or "") != "table" and not item.get("headers"):
			continue
		headers = [str(h) for h in (item.get("headers") or [])]
		rows = [[str(c) for c in row] for row in (item.get("rows") or [])]
		if not headers:
			continue
		if best is None or float(item.get("score") or 0) > float(best.get("score") or 0):
			best = {
				"headers": headers,
				"rows": rows,
				"row_offset": int(item.get("row_start") or 0),
				"table_id": item.get("table_id"),
				"document_version_id": item.get("document_version_id"),
				"page": item.get("page"),
				"page_start": item.get("page_start"),
				"page_end": item.get("page_end"),
				"doc_id": item.get("doc_id"),
				"score": item.get("score"),
				"citation": item,
			}
	# 同 table 多分片：合并同一 table_id 的所有行
	if best and best.get("table_id"):
		tid = best["table_id"]
		merged_rows: list[tuple[int, list[str]]] = []
		headers = best["headers"]
		for item in citations:
			if item.get("table_id") != tid:
				continue
			offset = int(item.get("row_start") or 0)
			for i, row in enumerate(item.get("rows") or []):
				merged_rows.append((offset + i, [str(c) for c in row]))
		merged_rows.sort(key=lambda x: x[0])
		# 去重行号
		seen: set[int] = set()
		rows_out: list[list[str]] = []
		min_idx = None
		for idx, row in merged_rows:
			if idx in seen:
				continue
			seen.add(idx)
			if min_idx is None:
				min_idx = idx
			rows_out.append(row)
		best["rows"] = rows_out
		best["row_offset"] = int(min_idx or 0)
		best["headers"] = headers
	return best or {}
