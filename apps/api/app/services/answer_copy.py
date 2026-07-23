"""Friendly Chinese copy for empty / weak RAG answers."""

from __future__ import annotations


def no_match_answer(*, library_name: str = "当前知识库") -> str:
	name = (library_name or "当前知识库").strip() or "当前知识库"
	return (
		f"在「{name}」里没有找到和这个问题对得上的段落。"
		"可以换个说法再问，或到知识库确认资料是否覆盖这个主题。"
	)


def weak_match_answer(*, library_name: str = "当前知识库") -> str:
	name = (library_name or "当前知识库").strip() or "当前知识库"
	return (
		f"检索过「{name}」中的资料，但相关度不够高，暂不生成猜测性回答。"
		"你可以问得更具体一点，或补充相关文档后再试。"
	)


def clarify_answer(*, library_name: str = "当前知识库") -> str:
	"""ambiguous 问题：Phase 1 澄清，不进入检索生成。"""
	name = (library_name or "当前知识库").strip() or "当前知识库"
	return (
		f"问题表述不够具体，暂时无法在「{name}」中准确检索。"
		"请补充主题、制度名称或想了解的条款，例如「病假证明几天内补交」。"
	)


def table_unclear_answer(*, library_name: str = "当前知识库") -> str:
	"""表格数值问法无法安全解析列/运算符时：澄清，禁止 LLM 自由心算。"""
	name = (library_name or "当前知识库").strip() or "当前知识库"
	return (
		f"已在「{name}」检索到相关表格，但无法确定要计算的列或条件，暂不进行数值推算。"
		"请写明列名与条件，例如「总价超过100000的供应商」或「甲公司的总价」。"
	)
