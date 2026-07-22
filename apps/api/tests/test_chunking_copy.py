from app.services.answer_copy import no_match_answer, weak_match_answer
from app.services.chunking import chunk_text


def test_chunk_text_overlap() -> None:
	text = "甲" * 120
	chunks = chunk_text(text, chunk_size=50, chunk_overlap=10)
	assert len(chunks) >= 2
	assert chunks[0].index == 0


def test_chunk_short() -> None:
	chunks = chunk_text("短文档", chunk_size=500, chunk_overlap=80)
	assert len(chunks) == 1
	assert chunks[0].text == "短文档"


def test_answer_copy() -> None:
	assert "没有找到" in no_match_answer(library_name="人事制度库")
	assert "相关度不够高" in weak_match_answer(library_name="人事制度库")
