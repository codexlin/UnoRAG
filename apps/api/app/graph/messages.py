"""AskGraph history / rewrite / generate message builders."""

from __future__ import annotations

from app.services.llm import CHAT_SYSTEM_PROMPT
from app.services.session_memory import (
	GENERATE_HISTORY_MAX_CHARS,
	WORKING_MEMORY_MAX_TURNS,
)


def _last_turn_qa(
	history: list[dict[str, str]] | None,
) -> tuple[str | None, str | None]:
	"""Return (last_user_question, its assistant answer) from chronological history."""
	if not history:
		return None, None
	prev_q: str | None = None
	prev_a: str | None = None
	for item in reversed(history):
		role = item.get("role")
		content = (item.get("content") or "").strip()
		if not content:
			continue
		if role == "assistant" and prev_a is None:
			prev_a = content
			continue
		if role == "user":
			prev_q = content
			break
	return prev_q, prev_a


def _compact_answer_hint(answer: str | None, *, max_len: int = 80) -> str:
	"""First-line snippet of prior answer for retrieval / generate coreference."""
	if not answer:
		return ""
	text = answer.strip().split("\n")[0].strip()
	if len(text) > max_len:
		text = text[:max_len].rstrip()
	return text


def rewrite_with_history(question: str, history: list[dict[str, str]] | None) -> tuple[str, str]:
	"""Return (rewritten_query, rewrite_mode). Lightweight follow-up rewrite with coref.

	Must include the prior *answer* (not only the prior question) so pronouns like
	「它」resolve to entities such as「边缘计算网关」for retrieval.
	Rewrite serves retrieval only — it does not replace generate history messages.
	"""
	q = question.strip()
	if not history:
		return q, "passthrough"
	prev, prev_answer = _last_turn_qa(history)
	if not prev:
		return q, "passthrough"
	# Pronoun / short follow-ups benefit most from prior turn context.
	needs_context = len(q) <= 24 or any(
		token in q
		for token in ("它", "这个", "那个", "上述", "刚才", "还有", "呢", "吗", "那")
	)
	if not needs_context:
		return q, "passthrough"
	answer_hint = _compact_answer_hint(prev_answer)
	if answer_hint:
		# Lead with the referent so dense/BM25 latch onto the entity, not just the prior ask.
		return f"{answer_hint}：{q}\n（上一轮问：{prev}）", "history"
	return f"上一轮用户问题：{prev}\n当前追问：{q}", "history"


def history_for_generate(
	history: list[dict[str, str]] | None,
	*,
	max_turns: int = WORKING_MEMORY_MAX_TURNS,
	max_chars: int = GENERATE_HISTORY_MAX_CHARS,
) -> list[dict[str, str]]:
	"""Last N complete Q/A turns for LLM messages; drop oldest if over char budget."""
	if not history:
		return []
	normalized: list[dict[str, str]] = []
	for item in history:
		role = item.get("role")
		content = (item.get("content") or "").strip()
		if role in {"user", "assistant"} and content:
			normalized.append({"role": role, "content": content})
	# Keep at most max_turns pairs (2 messages each), from the end.
	cap = max(1, int(max_turns)) * 2
	trimmed = normalized[-cap:] if cap > 0 else normalized
	budget = max(0, int(max_chars))
	if budget <= 0 or not trimmed:
		return trimmed
	# Drop oldest messages until under budget (prefer keeping recent full turns).
	while trimmed and sum(len(m["content"]) for m in trimmed) > budget:
		trimmed = trimmed[2:] if len(trimmed) >= 2 else trimmed[1:]
	return trimmed


def build_generate_messages(
	*,
	question: str,
	context: str,
	history: list[dict[str, str]] | None = None,
) -> list[dict[str, str]]:
	"""Assemble generate messages: system + history(user/assistant) + current user."""
	msgs: list[dict[str, str]] = [{"role": "system", "content": CHAT_SYSTEM_PROMPT}]
	for item in history_for_generate(history):
		msgs.append({"role": item["role"], "content": item["content"]})
	q = (question or "").strip()
	msgs.append(
		{
			"role": "user",
			"content": f"资料：\n{context}\n\n问题：{q}",
		}
	)
	return msgs


def question_with_working_memory(
	question: str,
	history: list[dict[str, str]] | None,
) -> str:
	"""Deprecated compatibility helper — prefer build_generate_messages for generate.

	Kept for older tests; returns a short prior-turn hint line (not used by ask path).
	"""
	q = (question or "").strip()
	prev_q, prev_a = _last_turn_qa(history)
	if not prev_q:
		return q
	answer_hint = _compact_answer_hint(prev_a)
	if answer_hint:
		return f"上一轮：问「{prev_q}」答「{answer_hint}」。\n当前问题：{q}"
	return f"上一轮问题：{prev_q}\n当前问题：{q}"
