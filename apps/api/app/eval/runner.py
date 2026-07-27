"""黄金集 runner — 本地可跑，默认 stub AskGraph。

输入：eval JSONL cases（默认 tests/eval/eval_cases.jsonl）+ 可选真实/stub AskGraph
输出：逐案 EvalCaseResult / 汇总报告
不变量：本模块是质量工具，不是 CI release gate；消融见 ablation.py（亦非门禁）
所有者：Data Plane / Eval

用法：
  uv run python -m app.eval.runner
  uv run python scripts/run_eval_cases.py

过渡期：本文件保留历史符号 re-export（`_check_expect` 等），新代码请从
`cases` / `assertions` / `fixtures` / `environment` / `executors` 导入。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from app.eval.assertions import check_expect, collect_ids
from app.eval.cases import DEFAULT_CASES, load_eval_cases
from app.eval.environment import (
	EVAL_ASK_OVERRIDES,
	isolated_ask_settings,
	resolve_ablation,
)
from app.eval.executors import run_case
from app.eval.executors.ask import run_ask
from app.eval.executors.classify import run_classify
from app.eval.executors.ingest_chunk import run_ingest_chunk
from app.eval.executors.ingest_http import run_ingest_http
from app.eval.executors.retrieval import deterministic_vector, run_retrieval
from app.eval.fixtures import (
	FIXTURES,
	REPO_ROOT,
	TESTDATA,
	load_ir_for_fixture,
	resolve_fixture_path,
)
from app.eval.schemas import EvalCaseResult

# Transition aliases (tests / scripts historically imported private names).
_check_expect = check_expect
_collect_ids = collect_ids
_resolve_ablation = resolve_ablation
_isolated_ask_settings = isolated_ask_settings
_EVAL_ASK_OVERRIDES = EVAL_ASK_OVERRIDES
_resolve_fixture_path = resolve_fixture_path
_load_ir_for_fixture = load_ir_for_fixture
_run_classify = run_classify
_run_ask = run_ask
_run_ingest_chunk = run_ingest_chunk
_run_retrieval = run_retrieval
_run_ingest_http = run_ingest_http
_deterministic_vector = deterministic_vector


def run_eval_cases(path: Path | None = None) -> list[EvalCaseResult]:
	"""跑黄金集；整段强制 INTERNAL_AUTH_ENABLED=false，避免宿主 .env 绊倒 gate。"""
	from app.settings import get_settings

	prev_auth = os.environ.get("INTERNAL_AUTH_ENABLED")
	os.environ["INTERNAL_AUTH_ENABLED"] = "false"
	get_settings.cache_clear()
	try:
		cases = load_eval_cases(path)
		return [run_case(case) for case in cases]
	finally:
		if prev_auth is None:
			os.environ.pop("INTERNAL_AUTH_ENABLED", None)
		else:
			os.environ["INTERNAL_AUTH_ENABLED"] = prev_auth
		get_settings.cache_clear()


def main(argv: list[str] | None = None) -> int:
	args = list(argv or sys.argv[1:])
	path = Path(args[0]) if args else DEFAULT_CASES
	results = run_eval_cases(path)
	passed = sum(1 for item in results if item.ok)
	failed = [item for item in results if not item.ok]
	print(f"[eval] cases={len(results)} passed={passed} failed={len(failed)} file={path}")
	print("[eval] retrieval metric default = Recall@K (K=3 unless expect.recall_at_k overrides)")
	for item in results:
		mark = "PASS" if item.ok else "FAIL"
		extra = ""
		if item.kind == "retrieval":
			rank = (item.observed or {}).get("observed_rank")
			metric = (item.observed or {}).get("metric") or "Recall@3"
			extra = f" {metric} rank={rank}"
		print(f"  {mark} {item.id} ({item.kind}){extra}")
		for err in item.errors:
			print(f"       - {err}")
	return 1 if failed else 0


if __name__ == "__main__":
	raise SystemExit(main())
