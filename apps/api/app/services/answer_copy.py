"""Friendly Chinese copy for empty / weak RAG answers."""

from __future__ import annotations


def no_match_answer(*, library_name: str = "当前文库") -> str:
	name = (library_name or "当前文库").strip() or "当前文库"
	return (
		f"在「{name}」里没有找到和这个问题对得上的段落。"
		"可以换个说法再问，或到文库确认资料是否覆盖这个主题。"
	)


def weak_match_answer(*, library_name: str = "当前文库") -> str:
	name = (library_name or "当前文库").strip() or "当前文库"
	return (
		f"翻过「{name}」里的资料，但相关度不够高，不敢瞎猜。"
		"你可以问得更具体一点，或补充相关文档后再试。"
	)
