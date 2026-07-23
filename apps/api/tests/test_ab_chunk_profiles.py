from pathlib import Path

from scripts.ab_chunk_profiles import _gold_key_facts, _index_record_type, _load_ab_suite


def test_ab_suite_loads_fixtures_and_all_gold_cases() -> None:
	docs, cases = _load_ab_suite()

	assert len(docs) == 7
	assert len(cases) == 33
	assert {doc["key"] for doc in docs} == {
		"contract-long",
		"crosstable-large",
		"mixed-charts",
		"quote-big-80rows",
		"report-narrative-5k",
		"scan-lowcontrast",
		"twocolumn",
	}
	assert all((Path(__file__).parents[3] / "testdata" / doc["path"]).is_file() for doc in docs)


def test_ab_suite_uses_explicit_key_facts_for_conflicting_summary_and_rows() -> None:
	_, cases = _load_ab_suite()
	by_question = {case["question"]: case for case in cases}

	detail_case = next(
		case
		for question, case in by_question.items()
		if question.startswith("忽略文末汇总说明")
	)
	assert detail_case["answer_contains"] == [
		"医疗信息系统升级",
		"5,673,173",
		"食品安全追溯系统",
		"42,996",
	]
	assert detail_case["expect_record_type"] == "table"


def test_gold_key_fact_fallback_extracts_stable_values() -> None:
	assert _gold_key_facts({"answer": "编号BH-ZHJC-2026-0042，成功率99.97%。"}) == [
		"BH-ZHJC-2026-0042",
		"99.97%",
	]


def test_gold_source_types_map_to_current_index_types() -> None:
	assert _index_record_type("text") == "chunk"
	assert _index_record_type("table") == "table"
	assert _index_record_type("image") == "chunk"
