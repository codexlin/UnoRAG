from __future__ import annotations

from app.services.ingest.tools import quote_source


def test_quote_source_prefers_body() -> None:
	raw = {
		"id": "c1",
		"index": 1,
		"title": "手册",
		"text": "preamble\n\n正文条款",
		"body": "正文条款",
		"section_path": "第3章 考勤",
		"page": "p.5",
		"score": 0.9,
	}
	quoted = quote_source(raw)
	assert quoted["body"] == "正文条款"
	assert quoted["text"] == "正文条款"
	assert quoted["section_path"] == "第3章 考勤"
