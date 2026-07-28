from __future__ import annotations

import logging
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterator

from langchain_openai import ChatOpenAI
from openai import OpenAI

from app.settings import Settings

logger = logging.getLogger(__name__)

# Process-local LLM inflight gate (Ask generate + ingest embeddings/chat).
_gate_lock = threading.Lock()
_gate: threading.Semaphore | None = None
_gate_limit: int | None = None


def reset_llm_inflight_gate_for_tests() -> None:
	"""Clear process gate so tests can reconfigure LLM_MAX_INFLIGHT."""
	global _gate, _gate_limit
	with _gate_lock:
		_gate = None
		_gate_limit = None


def _resolve_gate(limit: int) -> threading.Semaphore | None:
	"""Return a semaphore for positive limits; None disables the gate."""
	global _gate, _gate_limit
	if limit <= 0:
		return None
	with _gate_lock:
		if _gate is None or _gate_limit != limit:
			_gate = threading.Semaphore(limit)
			_gate_limit = limit
		return _gate


@contextmanager
def llm_inflight_slot(settings: Settings) -> Iterator[None]:
	"""Acquire a process-local LLM slot (no-op when LLM_MAX_INFLIGHT <= 0)."""
	gate = _resolve_gate(int(settings.llm_max_inflight))
	if gate is None:
		yield
		return
	wait_t0 = time.perf_counter()
	gate.acquire()
	wait_ms = (time.perf_counter() - wait_t0) * 1000.0
	held_t0 = time.perf_counter()
	try:
		if wait_ms >= 1.0:
			logger.info(
				"llm.inflight_acquired wait_ms=%.1f limit=%s",
				wait_ms,
				settings.llm_max_inflight,
			)
		yield
	finally:
		held_ms = (time.perf_counter() - held_t0) * 1000.0
		gate.release()
		logger.debug(
			"llm.inflight_released held_ms=%.1f limit=%s",
			held_ms,
			settings.llm_max_inflight,
		)


def build_chat_model(settings: Settings) -> ChatOpenAI:
	if not settings.has_llm_key:
		raise RuntimeError("OPENAI_API_KEY / DASHSCOPE_API_KEY is required for chat")
	return ChatOpenAI(
		api_key=settings.llm_api_key,
		base_url=settings.llm_base_url,
		model=settings.chat_model,
		temperature=0.2,
	)


class EmbeddingService:
	"""DashScope-compatible embeddings via raw OpenAI client.

	LangChain OpenAIEmbeddings may tokenize inputs before send; DashScope
	rejects that shape (`contents is neither str nor list of str`).
	"""

	def __init__(self, settings: Settings) -> None:
		if not settings.has_llm_key:
			raise RuntimeError("OPENAI_API_KEY / DASHSCOPE_API_KEY is required for embeddings")
		self.settings = settings
		self._client = OpenAI(
			api_key=settings.llm_api_key,
			base_url=settings.llm_base_url,
		)

	def embed_texts(self, texts: list[str]) -> list[list[float]]:
		if not texts:
			return []
		batch_size = max(1, int(self.settings.embedding_batch_size))
		vectors: list[list[float]] = []
		with llm_inflight_slot(self.settings):
			for offset in range(0, len(texts), batch_size):
				batch = texts[offset : offset + batch_size]
				response = self._client.embeddings.create(
					model=self.settings.embedding_model,
					input=batch,
					dimensions=self.settings.embedding_dim,
				)
				items = sorted(response.data, key=lambda item: getattr(item, "index", 0))
				vectors.extend(list(item.embedding) for item in items)
		logger.info(
			"llm.embedding model=%s inputs=%s dim=%s",
			self.settings.embedding_model,
			len(texts),
			len(vectors[0]) if vectors else 0,
		)
		return vectors

	def embed_query(self, text: str) -> list[float]:
		return self.embed_texts([text])[0]


CHAT_SYSTEM_PROMPT = (
	"你是 UnoRAG 企业知识库助手：根据已收录资料回答，并便于核对原文。"
	"只根据「资料」回答；资料没写到的内容直接说「资料未覆盖」，不要编造。"
	"只回答用户所问，不要主动列举「未使用的技术 / 未提及的框架」等对比注脚；"
	"除非用户明确问技术对比或用了哪些框架。"
	"语气简洁专业，用中文；必要时分点。引用资料时可用 [1]、[2] 对应来源编号。"
	"若有多轮对话历史，结合上文理解指代与追问，但仍以当前资料为准。"
)


class ChatService:
	def __init__(self, settings: Settings) -> None:
		self.settings = settings
		self._model = build_chat_model(settings)
		self._client = OpenAI(
			api_key=settings.llm_api_key,
			base_url=settings.llm_base_url,
		)

	def _messages(
		self,
		*,
		question: str,
		context: str,
		history: list[dict[str, str]] | None = None,
	) -> list[dict[str, str]]:
		"""Build chat messages: system + prior user/assistant turns + current user (资料+问题)."""
		msgs: list[dict[str, str]] = [{"role": "system", "content": CHAT_SYSTEM_PROMPT}]
		for item in history or []:
			role = item.get("role")
			content = (item.get("content") or "").strip()
			if role in {"user", "assistant"} and content:
				msgs.append({"role": role, "content": content})
		msgs.append(
			{
				"role": "user",
				"content": f"资料：\n{context}\n\n问题：{question}",
			}
		)
		return msgs

	def answer(
		self,
		*,
		question: str,
		context: str,
		history: list[dict[str, str]] | None = None,
	) -> str:
		return self.answer_messages(
			self._messages(question=question, context=context, history=history)
		)

	def answer_messages(self, messages: list[dict[str, str]]) -> str:
		lc_messages: list[tuple[str, str]] = [
			(item["role"], item["content"]) for item in messages
		]
		with llm_inflight_slot(self.settings):
			response: Any = self._model.invoke(lc_messages)
		content = getattr(response, "content", "") or ""
		if isinstance(content, list):
			content = "".join(str(part) for part in content)
		answer = str(content).strip()
		user_len = sum(len(m["content"]) for m in messages if m.get("role") == "user")
		logger.info(
			"llm.chat model=%s messages=%s user_chars=%s answer_len=%s",
			self.settings.chat_model,
			len(messages),
			user_len,
			len(answer),
		)
		return answer

	def stream_answer(
		self,
		*,
		question: str,
		context: str,
		history: list[dict[str, str]] | None = None,
	):
		yield from self.stream_messages(
			self._messages(question=question, context=context, history=history)
		)

	def stream_messages(self, messages: list[dict[str, str]]):
		chunk_count = 0
		with llm_inflight_slot(self.settings):
			response = self._client.chat.completions.create(
				model=self.settings.chat_model,
				messages=messages,
				temperature=0.2,
				stream=True,
			)
			for chunk in response:
				if not chunk.choices:
					continue
				token = chunk.choices[0].delta.content or ""
				if not token:
					continue
				chunk_count += 1
				yield token
		logger.info(
			"llm.chat_stream model=%s messages=%s chunks=%s",
			self.settings.chat_model,
			len(messages),
			chunk_count,
		)
