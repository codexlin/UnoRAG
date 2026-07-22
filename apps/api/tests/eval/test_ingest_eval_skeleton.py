"""Eval skeleton — 检索命中 / 章节定位基线（可扩展 PDF/表样本）。

运行：`uv run pytest tests/eval -q`
"""

from __future__ import annotations

from pathlib import Path

from app.services.ingest.chunker import chunk_document
from app.services.ingest.parsers.md import parse_markdown

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"

# 黄金问答：期望命中的章节关键词（离线、不依赖 LLM/Qdrant）
GOLDEN_MD = [
	{
		"question": "病假需要在几天内补交证明？",
		"expect_section_substr": "第3章",
		"expect_body_substr": "三个工作日",
	},
	{
		"question": "薪酬如何发放？",
		"expect_section_substr": "第4章",
		"expect_body_substr": "岗位职级",
	},
]


def _score_chunk(question: str, body: str, section: str | None) -> float:
	"""极简词重叠打分，仅作可重复基线。"""
	q_tokens = set(question)
	b_tokens = set(body)
	overlap = len(q_tokens & b_tokens) / max(len(q_tokens), 1)
	bonus = 0.2 if section and any(k in (section or "") for k in ("考勤", "薪酬", "病假")) else 0.0
	# 关键词硬加成
	if "病假" in question and "病假" in body:
		bonus += 0.5
	if "薪酬" in question and ("薪酬" in body or "岗位职级" in body):
		bonus += 0.5
	return overlap + bonus


def test_md_section_hit_baseline() -> None:
	content = (FIXTURES / "handbook.md").read_bytes()
	doc = parse_markdown(content=content, filename="handbook.md", title="员工手册")
	chunks = chunk_document(doc)
	assert chunks

	hits = 0
	section_hits = 0
	for item in GOLDEN_MD:
		ranked = sorted(
			chunks,
			key=lambda c: _score_chunk(item["question"], c.body, c.section_path),
			reverse=True,
		)
		top = ranked[0]
		if item["expect_body_substr"] in top.body:
			hits += 1
		if item["expect_section_substr"] in (top.section_path or ""):
			section_hits += 1

	# 基线门槛：正文命中全中；章节至少 1 条（启发式检索非向量）
	assert hits == len(GOLDEN_MD)
	assert section_hits >= 1
	print(
		f"[eval] md_body_hit={hits}/{len(GOLDEN_MD)} "
		f"section_hit={section_hits}/{len(GOLDEN_MD)}"
	)
