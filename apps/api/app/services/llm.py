from __future__ import annotations

import logging
from typing import Any

from langchain_openai import ChatOpenAI
from openai import OpenAI

from app.settings import Settings

logger = logging.getLogger(__name__)


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


class ChatService:
	def __init__(self, settings: Settings) -> None:
		self.settings = settings
		self._model = build_chat_model(settings)
		self._client = OpenAI(
			api_key=settings.llm_api_key,
			base_url=settings.llm_base_url,
		)

	def _messages(self, *, question: str, context: str) -> list[dict[str, str]]:
		system = (
			"你是 MeriKnow 企业知识库助手：根据已收录资料回答，并便于核对原文。"
			"只根据「资料」回答；资料没写到的内容直接说「资料未覆盖」，不要编造。"
			"只回答用户所问，不要主动列举「未使用的技术 / 未提及的框架」等对比注脚；"
			"除非用户明确问技术对比或用了哪些框架。"
			"语气简洁专业，用中文；必要时分点。引用资料时可用 [1]、[2] 对应来源编号。"
		)
		return [
			{"role": "system", "content": system},
			{"role": "user", "content": f"资料：\n{context}\n\n问题：{question}"},
		]

	def answer(self, *, question: str, context: str) -> str:
		messages: list[tuple[str, str]] = [
			(item["role"], item["content"]) for item in self._messages(question=question, context=context)
		]
		response: Any = self._model.invoke(messages)
		content = getattr(response, "content", "") or ""
		if isinstance(content, list):
			content = "".join(str(part) for part in content)
		answer = str(content).strip()
		logger.info(
			"llm.chat model=%s question_len=%s context_len=%s answer_len=%s",
			self.settings.chat_model,
			len(question),
			len(context),
			len(answer),
		)
		return answer

	def stream_answer(self, *, question: str, context: str):
		chunk_count = 0
		response = self._client.chat.completions.create(
			model=self.settings.chat_model,
			messages=self._messages(question=question, context=context),
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
			"llm.chat_stream model=%s question_len=%s context_len=%s chunks=%s",
			self.settings.chat_model,
			len(question),
			len(context),
			chunk_count,
		)
