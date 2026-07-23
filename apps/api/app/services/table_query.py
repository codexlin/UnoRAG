"""Lightweight TableQueryPlan — 仅在解析有把握时做结构化过滤/聚合；否则回退 table+LLM。"""

from __future__ import annotations

import re
from collections.abc import Callable
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

_UNIT_SCALE = {"千": 1_000.0, "万": 10_000.0, "亿": 100_000_000.0}
_ARABIC_NUMBER_TOKEN = r"-?[0-9][0-9,，]*(?:\.[0-9]+)?\s*[万千亿]?"

# 宽过滤 / count 命中整表时，避免 matched_rows 与证据 citation 撑爆 LLM/API 上下文
MATCHED_ROWS_PREVIEW_LIMIT = 8
EVIDENCE_GROUPS_LIMIT = 5

# (doc_id, document_version_id, table_id)
TableInstanceKey = tuple[str, str, str]

LoadTableGroupsFn = Callable[..., list[dict[str, Any]]]


def _apply_unit(val: float, unit: str | None) -> float:
	if not unit:
		return val
	return val * _UNIT_SCALE.get(unit, 1.0)


def _parse_chinese_number(text: str) -> float | None:
	raw = (text or "").strip().replace(",", "").replace("，", "")
	if not raw:
		return None
	# 阿拉伯数字 + 可选 万/千/亿
	m = re.fullmatch(r"(-?[0-9]+(?:\.[0-9]+)?)\s*(万|千|亿)?", raw)
	if m:
		return _apply_unit(float(m.group(1)), m.group(2))
	# 十万 / 二十万 / 十
	m2 = re.fullmatch(r"([一二两三四五六七八九十]?十?)(万|千|亿)?", raw)
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
		return _apply_unit(val, unit)
	# 「超过十万」里单独的「十万」
	if raw in {"十万", "十万块", "十万元"}:
		return 100_000.0
	if raw in {"一万", "万"}:
		return 10_000.0
	if raw in {"一千", "千"}:
		return 1_000.0
	if raw in {"一亿", "亿"}:
		return 100_000_000.0
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
	if re.search(r"(最低|最小|最少).{0,6}(价|报价|总价|单价|金额)", q) or re.search(
		r"(价|报价|总价|单价|金额).{0,4}(最低|最小)", q
	):
		plan.update(
			{
				"operation": "min",
				"column": "总价",
				"confident": True,
				"reason": "min_pattern",
				"select_columns": ["产品", "供应商", "总价"],
			}
		)
		return _finalize_columns(plan, headers)
	if re.search(r"(最高|最大|最多).{0,6}(价|报价|总价|单价|金额)", q) or re.search(
		r"(价|报价|总价|单价|金额).{0,4}(最高|最大)", q
	):
		plan.update(
			{
				"operation": "max",
				"column": "总价",
				"confident": True,
				"reason": "max_pattern",
				"select_columns": ["产品", "供应商", "总价"],
			}
		)
		return _finalize_columns(plan, headers)

	# filter: 超过 / 大于 / 小于 …
	op_match = re.search(
		r"(超过|大于等于|大于|不少于|不低于|小于等于|小于|不高于|不多于)\s*"
		rf"({_ARABIC_NUMBER_TOKEN}|[一二两三四五六七八九十]+[万千亿]?|十万)",
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
			col = (
				"总价"
				if ("价" in q or "报价" in q or "总价" in q or "金额" in q)
				else None
			)
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

	# ASCII ops（数值须走统一单位解析，避免「>= 10万」被当成 10；千分位交给 _cell_number）
	ascii_op = re.search(
		r"(中标金额|金额|总价|报价|单价|数量)\s*(>=|<=|>|<|==|=)\s*"
		rf"({_ARABIC_NUMBER_TOKEN})",
		q,
	)
	if ascii_op:
		op_raw = ascii_op.group(2)
		operator = "==" if op_raw == "=" else op_raw  # type: ignore[assignment]
		value = _cell_number(ascii_op.group(3))
		if value is None:
			plan["reason"] = "ascii_filter_bad_value"
			return plan
		col = ascii_op.group(1)
		if col in {"报价", "金额", "中标金额"}:
			col = "总价"
		plan.update(
			{
				"operation": "filter",
				"column": col,
				"operator": operator,
				"value": value,
				"select_columns": ["供应商", col],
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
	"""解析单元格数值；正确处理 万/千/亿。含单位却无法解析时返回 None，绝不截断成错误标量。"""
	text = str(raw or "").strip().replace(",", "").replace("，", "")
	if not text:
		return None
	cleaned = re.sub(r"[元块圆￥¥$]", "", text).strip()
	if not cleaned:
		return None

	parsed = _parse_chinese_number(cleaned)
	if parsed is not None:
		return parsed

	# 「约12万」「12万元整」等：数字+单位子串
	m_unit = re.search(r"(-?[0-9]+(?:\.[0-9]+)?)\s*(万|千|亿)", cleaned)
	if m_unit:
		return _apply_unit(float(m_unit.group(1)), m_unit.group(2))

	# 含中文单位却未能解析 → 拒绝，避免把「12万」当成 12
	if re.search(r"[万千亿]", cleaned):
		return None

	m_plain = re.search(r"-?[0-9]+(?:\.[0-9]+)?", cleaned)
	if not m_plain:
		return None
	try:
		return float(m_plain.group(0))
	except ValueError:
		return None


def _row_dict(headers: list[str], row: list[str], *, absolute_index: int) -> dict[str, Any]:
	cells = {headers[i]: (row[i] if i < len(row) else "") for i in range(len(headers))}
	cells["_row_index"] = absolute_index
	return cells


def _matched_row_indices(rows: list[dict[str, Any]]) -> list[int]:
	out: list[int] = []
	for row in rows:
		raw = row.get("_row_index")
		if raw is None:
			continue
		try:
			out.append(int(raw))
		except (TypeError, ValueError):
			continue
	return out


def _with_matched_preview(
	projected: list[dict[str, Any]],
	*,
	preview_limit: int = MATCHED_ROWS_PREVIEW_LIMIT,
	collect_evidence_indices: bool = False,
) -> dict[str, Any]:
	"""返回有界公开预览；完整行号仅按需作为节点内临时证据数据。"""
	count = len(projected)
	indices = _matched_row_indices(projected)
	result: dict[str, Any] = {
		"matched_count": count,
		"matched_rows": projected[:preview_limit],
		"matched_rows_truncated": count > preview_limit,
		"matched_row_indices": indices[:preview_limit],
		"matched_row_indices_truncated": len(indices) > preview_limit,
	}
	if collect_evidence_indices:
		# Ask 图选完证据组后必须 pop，禁止进入 state/archive/API。
		result["_evidence_row_indices"] = indices
	return result


def execute_table_query(
	plan: dict[str, Any],
	*,
	headers: list[str],
	rows: list[list[str]],
	row_offset: int = 0,
	collect_evidence_indices: bool = False,
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
		"matched_count": 0,
		"matched_rows_truncated": False,
		"matched_row_indices": [],
		"matched_row_indices_truncated": False,
		"answer_value": None,
		"answer_value_truncated": False,
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
		projected = [_project(r) for r in indexed_rows]
		result.update(
				{
					"ok": True,
					**_with_matched_preview(
						projected,
						collect_evidence_indices=collect_evidence_indices,
					),
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
			result.update(
					{
						"ok": True,
						**_with_matched_preview(
							[],
							collect_evidence_indices=collect_evidence_indices,
						),
						"answer_text": "未找到匹配行",
					"reason": "no_match",
				}
			)
			return result
		values = [matched[0].get(column)] if column else []
		answer = values[0] if values else None
		result.update(
				{
					"ok": True,
					**_with_matched_preview(
						[_project(r) for r in matched],
						collect_evidence_indices=collect_evidence_indices,
					),
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
			for r in matched[:MATCHED_ROWS_PREVIEW_LIMIT]
		]
		answer_values = [r.get(column) for r in matched[:MATCHED_ROWS_PREVIEW_LIMIT]]
		result.update(
			{
				"ok": True,
				**_with_matched_preview(
					[_project(r) for r in matched],
					collect_evidence_indices=collect_evidence_indices,
				),
				"answer_value": answer_values,
				"answer_value_truncated": len(matched) > len(answer_values),
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
			result.update(
					{
						"ok": True,
						**_with_matched_preview(
							[],
							collect_evidence_indices=collect_evidence_indices,
						),
						"answer_text": "无可用数值",
					"reason": "no_numeric",
				}
			)
			return result
		best_val, best_row = (max if op == "max" else min)(scored, key=lambda x: x[0])
		result.update(
				{
					"ok": True,
					**_with_matched_preview(
						[_project(best_row)],
						collect_evidence_indices=collect_evidence_indices,
					),
					"answer_value": best_val,
				"answer_text": f"{'最高' if op == 'max' else '最低'}{column}为 {best_val}",
				"reason": op,
			}
		)
		return result

	result["reason"] = f"unsupported:{op}"
	return result


def table_instance_key(item: dict[str, Any]) -> TableInstanceKey:
	"""表实例唯一键：跨文档的同名 table_id（如 t1）不得合并。"""
	return (
		str(item.get("doc_id") or ""),
		str(item.get("document_version_id") or ""),
		str(item.get("table_id") or ""),
	)


def locate_best_table_instance(citations: list[dict[str, Any]]) -> dict[str, Any] | None:
	"""Locate a table; row evidence wins, table_summary is discovery fallback."""
	best_row: dict[str, Any] | None = None
	best_summary: dict[str, Any] | None = None
	for item in citations:
		record_type = str(item.get("record_type") or "")
		if record_type not in {"table", "table_summary"} and not item.get("headers"):
			continue
		headers = [str(h) for h in (item.get("headers") or [])]
		if not headers and not item.get("table_id"):
			continue
		score = float(item.get("score") or 0)
		target = best_summary if record_type == "table_summary" else best_row
		if target is None or score > float(target.get("score") or 0):
			doc_id, version_id, table_id = table_instance_key(item)
			candidate = {
				"doc_id": doc_id,
				"document_version_id": version_id or None,
				"table_id": table_id or None,
				"score": score,
				"library_id": item.get("library_id"),
				"citation": item,
			}
			if record_type == "table_summary":
				best_summary = candidate
			else:
				best_row = candidate
	best = best_row or best_summary
	if best and not best.get("table_id"):
		return None
	return best


def validate_table_group_coverage(groups: list[dict[str, Any]]) -> tuple[bool, str]:
	"""校验行组从 0 连续覆盖，且与 table_row_count（若有）一致。缺组 → incomplete。"""
	if not groups:
		return False, "no_groups"
	missing_range = [
		g
		for g in groups
		if g.get("row_start") is None or g.get("row_end") is None
	]
	if missing_range:
		return False, "missing_row_range"

	ordered = sorted(groups, key=lambda g: (int(g["row_start"]), int(g["row_end"])))
	expected = 0
	for group in ordered:
		start = int(group["row_start"])
		end = int(group["row_end"])
		rows = group.get("rows") or []
		# 空表：仅 headers，row_end=-1
		if end < 0 and not rows:
			if start != 0:
				return False, f"empty_table_bad_start:{start}"
			declared_total = group.get("table_row_count")
			if declared_total is not None and int(declared_total) != 0:
				return False, f"empty_but_table_row_count:{declared_total}"
			return True, "complete_empty"
		if start != expected:
			return False, f"gap_or_missing:expected_{expected}_got_{start}"
		if end < start:
			return False, f"bad_range:{start}-{end}"
		# 行数应与声明区间一致
		declared = end - start + 1
		if len(rows) != declared:
			return False, f"row_count_mismatch:{start}-{end}:got_{len(rows)}"
		expected = end + 1

	# 有整表行数元数据时：必须覆盖到最后一行（防止 top_k 只召回前缀仍标 complete）
	totals = [
		int(g["table_row_count"])
		for g in ordered
		if g.get("table_row_count") is not None
	]
	if totals:
		table_row_count = totals[0]
		if any(t != table_row_count for t in totals):
			return False, "table_row_count_inconsistent"
		if expected != table_row_count:
			return False, f"truncated:got_{expected}_of_{table_row_count}"
	return True, "complete"


def assemble_table_from_groups(groups: list[dict[str, Any]]) -> dict[str, Any]:
	"""合并同一表实例的行组；incomplete 时仍返回已拼行供调试，但 complete=False。"""
	complete, reason = validate_table_group_coverage(groups)
	if not groups:
		return {
			"headers": [],
			"rows": [],
			"row_offset": 0,
			"complete": False,
			"reason": reason,
			"group_count": 0,
		}

	ordered = sorted(
		groups,
		key=lambda g: (
			int(g.get("row_start") if g.get("row_start") is not None else 10**9),
			int(g.get("row_end") if g.get("row_end") is not None else 10**9),
		),
	)
	headers = [str(h) for h in (ordered[0].get("headers") or [])]
	# 同实例内 headers 不一致 → 拒绝
	for group in ordered[1:]:
		other = [str(h) for h in (group.get("headers") or [])]
		if other and headers and other != headers:
			return {
				"headers": headers,
				"rows": [],
				"row_offset": 0,
				"complete": False,
				"reason": "header_mismatch",
				"group_count": len(groups),
				"doc_id": ordered[0].get("doc_id"),
				"document_version_id": ordered[0].get("document_version_id"),
				"table_id": ordered[0].get("table_id"),
			}

	merged_rows: list[tuple[int, list[str]]] = []
	for group in ordered:
		offset = int(group.get("row_start") or 0)
		for i, row in enumerate(group.get("rows") or []):
			merged_rows.append((offset + i, [str(c) for c in row]))
	merged_rows.sort(key=lambda x: x[0])
	seen: set[int] = set()
	rows_out: list[list[str]] = []
	min_idx: int | None = None
	for idx, row in merged_rows:
		if idx in seen:
			continue
		seen.add(idx)
		if min_idx is None:
			min_idx = idx
		rows_out.append(row)

	seed = ordered[0]
	return {
		"headers": headers,
		"rows": rows_out,
		"row_offset": int(min_idx or 0),
		"complete": complete,
		"reason": reason,
		"group_count": len(groups),
		"table_id": seed.get("table_id"),
		"document_version_id": seed.get("document_version_id"),
		"doc_id": seed.get("doc_id"),
		"page": seed.get("page"),
		"page_start": seed.get("page_start"),
		"page_end": seed.get("page_end"),
		"score": seed.get("score"),
		"library_id": seed.get("library_id"),
		"table_caption": seed.get("table_caption"),
		"table_quality": seed.get("table_quality") or {},
		"summary_rows": seed.get("summary_rows") or [],
		"footnotes": seed.get("footnotes") or [],
	}


def prepare_table_for_execute(
	citations: list[dict[str, Any]],
	*,
	load_table_groups: LoadTableGroupsFn | None = None,
	library_id: str | None = None,
) -> dict[str, Any]:
	"""两阶段：向量定位表实例 → 按键加载全表行组 → 校验完整性后供聚合。

	聚合不得只在 top_k 检索子集上执行；缺组时 complete=False（fail closed）。
	"""
	located = locate_best_table_instance(citations)
	if not located:
		return {
			"headers": [],
			"rows": [],
			"row_offset": 0,
			"complete": False,
			"reason": "no_table_hit",
			"group_count": 0,
		}

	doc_id = str(located.get("doc_id") or "")
	version_id = located.get("document_version_id")
	table_id = str(located.get("table_id") or "")
	lib = library_id or located.get("library_id")
	instance = (doc_id, str(version_id or ""), table_id)

	groups: list[dict[str, Any]]
	load_source = "citations"
	if load_table_groups is not None and doc_id and table_id:
		try:
			groups = list(
				load_table_groups(
					doc_id=doc_id,
					document_version_id=str(version_id) if version_id else None,
					table_id=table_id,
					library_id=str(lib) if lib else None,
				)
			)
			load_source = "store"
		except Exception as exc:  # noqa: BLE001 — fail closed
			return {
				"headers": [],
				"rows": [],
				"row_offset": 0,
				"complete": False,
				"reason": f"load_failed:{exc}",
				"group_count": 0,
				"doc_id": doc_id,
				"document_version_id": version_id,
				"table_id": table_id,
				"load_source": "store",
			}
	else:
		groups = [
			item
			for item in citations
			if table_instance_key(item) == instance
			and (str(item.get("record_type") or "") == "table" or item.get("headers"))
		]

	assembled = assemble_table_from_groups(groups)
	assembled["load_source"] = load_source
	assembled["score"] = located.get("score")
	assembled["citation"] = located.get("citation")
	if not assembled.get("table_quality"):
		assembled["table_quality"] = (
			(located.get("citation") or {}).get("table_quality") or {}
		)
	assembled["groups"] = groups
	# 定位键写回，便于 citation 标注
	assembled.setdefault("doc_id", doc_id)
	assembled.setdefault("document_version_id", version_id)
	assembled.setdefault("table_id", table_id)
	return assembled


def select_evidence_groups(
	groups: list[dict[str, Any]],
	matched_rows: list[dict[str, Any]] | None = None,
	*,
	matched_row_indices: list[int] | None = None,
	limit: int = EVIDENCE_GROUPS_LIMIT,
) -> dict[str, Any]:
	"""按命中行号选出覆盖证据行组；返回截断后的 groups 与审计字段。"""
	indices: set[int] = set()
	if matched_row_indices is not None:
		for raw in matched_row_indices:
			try:
				indices.add(int(raw))
			except (TypeError, ValueError):
				continue
	else:
		for row in matched_rows or []:
			raw = row.get("_row_index")
			if raw is None:
				continue
			try:
				indices.add(int(raw))
			except (TypeError, ValueError):
				continue
	if not indices:
		return {
			"groups": [],
			"total_group_count": 0,
			"evidence_truncated": False,
			"evidence_group_count": 0,
		}

	out: list[dict[str, Any]] = []
	seen: set[tuple[str, int, int]] = set()
	for group in groups:
		if group.get("row_start") is None or group.get("row_end") is None:
			continue
		start = int(group["row_start"])
		end = int(group["row_end"])
		if not any(start <= idx <= end for idx in indices):
			continue
		key = (
			str(group.get("record_id") or group.get("id") or ""),
			start,
			end,
		)
		if key in seen:
			continue
		seen.add(key)
		out.append(group)

	# 按行号稳定排序，截断时优先靠前的命中组
	out.sort(
		key=lambda g: (
			int(g.get("row_start") if g.get("row_start") is not None else 10**9),
			int(g.get("row_end") if g.get("row_end") is not None else 10**9),
		)
	)
	total = len(out)
	capped = out[: max(0, int(limit))]
	return {
		"groups": capped,
		"total_group_count": total,
		"evidence_truncated": total > len(capped),
		"evidence_group_count": len(capped),
	}


def citations_with_matched_evidence(
	citations: list[dict[str, Any]],
	*,
	groups: list[dict[str, Any]],
	matched_rows: list[dict[str, Any]],
	target_key: TableInstanceKey | None,
	seed_citation: dict[str, Any] | None = None,
	matched_row_indices: list[int] | None = None,
	evidence_limit: int = EVIDENCE_GROUPS_LIMIT,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
	"""用覆盖命中行的行组替换同表实例的向量 citation；附带证据截断审计字段。"""
	empty_meta = {
		"total_group_count": 0,
		"evidence_truncated": False,
		"evidence_group_count": 0,
	}
	if target_key is None:
		return citations, empty_meta
	selected = select_evidence_groups(
		groups,
		matched_rows,
		matched_row_indices=matched_row_indices,
		limit=evidence_limit,
	)
	evidence = selected["groups"]
	meta = {
		"total_group_count": selected["total_group_count"],
		"evidence_truncated": selected["evidence_truncated"],
		"evidence_group_count": selected["evidence_group_count"],
	}
	if not evidence:
		return citations, meta

	kept = [
		item
		for item in citations
		if not (
			(str(item.get("record_type") or "") == "table" or item.get("headers"))
			and table_instance_key(item) == target_key
		)
	]
	seed = seed_citation or next(
		(c for c in citations if table_instance_key(c) == target_key),
		{},
	)

	formatted: list[dict[str, Any]] = []
	for i, group in enumerate(evidence):
		body = str(group.get("body") or group.get("text") or group.get("snippet") or "")
		if not body:
			headers = [str(h) for h in (group.get("headers") or [])]
			rows = group.get("rows") or []
			lines = [" | ".join(headers)] if headers else []
			for row in rows:
				lines.append(" | ".join(str(c) for c in row))
			body = "\n".join(lines)
		score_raw = group.get("score")
		if score_raw is None:
			score_raw = seed.get("score")
		try:
			score = max(0.0, min(1.0, float(score_raw if score_raw is not None else 1.0)))
		except (TypeError, ValueError):
			score = 1.0
		formatted.append(
			{
				"id": str(
					group.get("id")
					or group.get("record_id")
					or f"table-evidence-{target_key[2]}-{group.get('row_start')}-{i}"
				),
				"index": i + 1,
				"title": str(group.get("title") or seed.get("title") or "表格证据"),
				"page": group.get("page") if group.get("page") is not None else seed.get("page"),
				"page_start": group.get("page_start", seed.get("page_start")),
				"page_end": group.get("page_end", seed.get("page_end")),
				"section_path": group.get("section_path", seed.get("section_path")),
				"preamble": group.get("preamble", seed.get("preamble")),
				"table_id": group.get("table_id") or target_key[2],
				"headers": group.get("headers") or seed.get("headers") or [],
				"rows": group.get("rows") or [],
				"row_start": group.get("row_start"),
				"row_end": group.get("row_end"),
				"table_row_count": group.get("table_row_count", seed.get("table_row_count")),
				"snippet": str(group.get("snippet") or body[:280]),
				"score": score,
				"dense_score": group.get("dense_score", seed.get("dense_score")),
				"bm25_score": group.get("bm25_score", seed.get("bm25_score")),
				"rrf_score": group.get("rrf_score", seed.get("rrf_score")),
				"text": body,
				"body": body,
				"doc_id": group.get("doc_id") or target_key[0] or seed.get("doc_id"),
				"chunk_index": group.get("chunk_index", seed.get("chunk_index")),
				"filename": group.get("filename", seed.get("filename")),
				"document_version_id": (
					group.get("document_version_id")
					or (target_key[1] or None)
					or seed.get("document_version_id")
				),
				"tenant_id": group.get("tenant_id", seed.get("tenant_id")),
				"record_type": "table",
				"record_id": group.get("record_id", seed.get("record_id")),
				"source_chunk_ids": group.get("source_chunk_ids")
				or seed.get("source_chunk_ids")
				or [],
				"source_node_ids": group.get("source_node_ids")
				or seed.get("source_node_ids")
				or [],
				"library_id": group.get("library_id", seed.get("library_id")),
			}
		)

	merged = formatted + [dict(item) for item in kept]
	for index, item in enumerate(merged, start=1):
		item["index"] = index
		item["record_type"] = item.get("record_type") or "table"
	return merged, meta


def merge_table_hits_for_execute(citations: list[dict[str, Any]]) -> dict[str, Any]:
	"""兼容入口：仅合并同实例 citation 行组（无 store 全表加载）。

	新路径请用 prepare_table_for_execute(..., load_table_groups=...)。
	"""
	return prepare_table_for_execute(citations, load_table_groups=None)
