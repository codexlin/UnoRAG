"""Ask 消融最小骨架——实验工具，非 release gate（不进发布门禁 / CI 质量红灯）。

保留：变体定义、category 焦点、可跑/不可评测标记。
不生成 keep/delete 决策——统计基础未稳前禁止自动结论。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

AblationId = Literal[
	"A0_full",
	"A1_no_rewrite",
	"A2_no_structured_plan",
	"A3_dense_only",
	"A4_no_rerank",
	"A5_no_retry",
	"A6_no_adjudication",
	"A7_no_table_route",
	"A8_no_evidence_judge",
]


@dataclass(frozen=True, slots=True)
class AblationVariant:
	id: AblationId
	label: str
	question: str
	ask_overrides: dict[str, Any] = field(default_factory=dict)
	env: dict[str, str] = field(default_factory=dict)
	focus_categories: tuple[str, ...] = ()
	# Graph kill-switch not implemented yet.
	requires_graph_hook: bool = False
	# Cannot evaluate until A0 enables the feature under test (e.g. hybrid/rerank) + live.
	not_evaluable: bool = False
	note: str = ""


# A0 baseline for stub/private contract runs: hybrid/rerank OFF (matches ASK_DEFAULTS).
# Therefore A3/A4 are not_evaluable until Full turns those on in a live matrix.
_FULL_OVERRIDES: dict[str, Any] = {
	"session_memory_enabled": True,
	"hybrid_enabled": False,
	"rerank_enabled": False,
	"citation_adjudicate_enabled": True,
}


ABLATION_VARIANTS: tuple[AblationVariant, ...] = (
	AblationVariant(
		id="A0_full",
		label="完整链路",
		question="当前完整 Ask 链路基准",
		ask_overrides=dict(_FULL_OVERRIDES),
		env={"MAX_RETRIEVE_RETRIES": "1"},
	),
	AblationVariant(
		id="A1_no_rewrite",
		label="关闭 query rewrite",
		question="多轮改写是否真有收益",
		ask_overrides={**_FULL_OVERRIDES, "session_memory_enabled": False},
		env={"MAX_RETRIEVE_RETRIES": "1"},
		focus_categories=("follow_up", "multi_turn"),
		requires_graph_hook=True,
		note="需图内跳过 rewrite_node",
	),
	AblationVariant(
		id="A2_no_structured_plan",
		label="关闭 structured plan",
		question="检索计划是否比直接检索更好",
		ask_overrides=dict(_FULL_OVERRIDES),
		env={"MAX_RETRIEVE_RETRIES": "1"},
		requires_graph_hook=True,
		note="需图内跳过 build_retrieval_plan",
	),
	AblationVariant(
		id="A3_dense_only",
		label="只用 dense（关 hybrid）",
		question="hybrid 的净贡献",
		ask_overrides={**_FULL_OVERRIDES, "hybrid_enabled": False},
		env={"MAX_RETRIEVE_RETRIES": "1"},
		focus_categories=("exact_term", "sku", "code"),
		not_evaluable=True,
		note="A0 未启用 hybrid；live + Full 开 hybrid 后再评",
	),
	AblationVariant(
		id="A4_no_rerank",
		label="关闭 rerank",
		question="rerank 是否改善 Top-K / 引用精度",
		ask_overrides={**_FULL_OVERRIDES, "rerank_enabled": False},
		env={"MAX_RETRIEVE_RETRIES": "1"},
		focus_categories=("near_dup", "single_fact", "semantic"),
		not_evaluable=True,
		note="A0 未启用 rerank；live + Full 开 rerank 后再评",
	),
	AblationVariant(
		id="A5_no_retry",
		label="关闭 retry",
		question="第二次检索是否值得",
		ask_overrides=dict(_FULL_OVERRIDES),
		env={"MAX_RETRIEVE_RETRIES": "0"},
		focus_categories=("weak_evidence", "borderline", "weak_match"),
	),
	AblationVariant(
		id="A6_no_adjudication",
		label="关闭 citation adjudication",
		question="引用裁决改善了多少精度",
		ask_overrides={**_FULL_OVERRIDES, "citation_adjudicate_enabled": False},
		env={"MAX_RETRIEVE_RETRIES": "1"},
		focus_categories=("citation", "single_fact", "near_dup"),
	),
	AblationVariant(
		id="A7_no_table_route",
		label="禁用 table route",
		question="表格专用路径的收益",
		ask_overrides=dict(_FULL_OVERRIDES),
		env={"MAX_RETRIEVE_RETRIES": "1"},
		focus_categories=("table", "table_calc"),
		requires_graph_hook=True,
		note="需图内强制 table→retrieve",
	),
	AblationVariant(
		id="A8_no_evidence_judge",
		label="关闭最终 evidence judge",
		question="judge 对拒答质量的贡献",
		ask_overrides=dict(_FULL_OVERRIDES),
		env={"MAX_RETRIEVE_RETRIES": "1"},
		focus_categories=("no_answer", "refuse", "weak_match"),
		requires_graph_hook=True,
		note="需图内跳过 judge_node",
	),
)


def variant_by_id(variant_id: str) -> AblationVariant:
	for variant in ABLATION_VARIANTS:
		if variant.id == variant_id:
			return variant
	raise KeyError(f"unknown ablation variant: {variant_id}")


def runnable_variants() -> list[AblationVariant]:
	"""Variants that can execute today (not hook-blocked, not marked not_evaluable)."""
	return [
		v
		for v in ABLATION_VARIANTS
		if not v.requires_graph_hook and not v.not_evaluable
	]


def case_matches_focus(case_category: str | None, variant: AblationVariant) -> bool:
	if not variant.focus_categories:
		return True
	if not case_category:
		return False
	return case_category in variant.focus_categories
