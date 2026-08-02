import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "run_ab_live_e2e.py"
SPEC = importlib.util.spec_from_file_location("run_ab_live_e2e", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class AbLiveScorerTests(unittest.TestCase):
	def test_gold_cases_have_explicit_atomic_key_facts(self):
		gold_path = ROOT / "testdata" / "ab" / "golds.jsonl"
		cases = RUNNER.load_gold_cases(gold_path)

		self.assertEqual(33, len(cases))
		for index, case in enumerate(cases, 1):
			with self.subTest(case=index):
				facts = RUNNER.key_facts_from(case)
				self.assertGreater(len(facts), 0)
				self.assertNotIn(case["answer"], facts)
				self.assertTrue(
					all(RUNNER.fact_matches_answer(fact, case["answer"]) for fact in facts)
				)

	def test_missing_key_facts_fail_closed_instead_of_using_answer_prefix(self):
		with self.assertRaisesRegex(ValueError, "must define non-empty key_facts"):
			RUNNER.key_facts_from({"answer": "这是一段很长、不能整体作为断言的参考答案。"})

	def test_arabic_and_chinese_numbers_are_equivalent(self):
		pairs = [
			("三十六个月", "36个月"),
			("四位作者", "4位作者"),
			("九百五十万人", "950万人"),
			("人民币叁亿柒仟伍佰万元", "人民币375,000,000元"),
			("1.66亿元", "166,000,000元"),
		]
		for fact, answer in pairs:
			with self.subTest(fact=fact, answer=answer):
				self.assertTrue(RUNNER.fact_matches_answer(fact, answer))

	def test_number_normalization_does_not_accept_a_different_value(self):
		self.assertFalse(RUNNER.fact_matches_answer("三十六个月", "合同期限为35个月"))
		self.assertFalse(RUNNER.fact_matches_answer("1.66亿元", "投资金额为1.65亿元"))
		self.assertFalse(RUNNER.fact_matches_answer("115", "设备单价为1150元"))
		self.assertFalse(RUNNER.fact_matches_answer("CM-R7425", "型号为CM-R74250"))

	def test_latex_wrapped_percentages_match_plain_reference_facts(self):
		self.assertTrue(RUNNER.fact_matches_answer("99.97%", r"成功率为 $99.97\%$"))
		self.assertTrue(RUNNER.fact_matches_answer("55-65%", "发生概率约55–65%"))

	def test_case_eight_scores_only_the_requested_fields(self):
		gold_path = ROOT / "testdata" / "ab" / "golds.jsonl"
		case = json.loads(gold_path.read_text().splitlines()[7])

		self.assertEqual(["边缘计算网关", "115", "5,750"], case["key_facts"])
		answer = "序号1是边缘计算网关，单价115元，合计5750元。"
		self.assertEqual(
			[],
			[fact for fact in case["key_facts"] if not RUNNER.fact_matches_answer(fact, answer)],
		)


if __name__ == "__main__":
	unittest.main()
