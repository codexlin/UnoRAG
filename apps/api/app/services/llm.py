from __future__ import annotations

import logging
from typing import Any

from langchain_openai import ChatOpenAI, OpenAIEmbeddings

from app.settings import Settings

logger = logging.getLogger(__name__)


def build_embeddings(settings: Settings) -> OpenAIEmbeddings:
	if not settings.has_llm_key:
		raise RuntimeError("OPENAI_API_KEY / DASHSCOPE_API_KEY is required for embeddings")
	return OpenAIEmbeddings(
		api_key=settings.llm_api_key,
		base_url=settings.llm_base_url,
		model=settings.embedding_model,
		dimensions=settings.embedding_dim,
		chunk_size=max(1, settings.embedding_batch_size),
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
	def __init__(self, settings: Settings) -> None:
		self.settings = settings
		self._client = build_embeddings(settings)

	def embed_texts(self, texts: list[str]) -> list[list[float]]:
		if not texts:
			return []
		vectors = self._client.embed_documents(texts)
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

	def answer(self, *, question: str, context: str) -> str:
		system = (
			"你是 MeriKnow 文库助手：根据已收录资料回答，并便于核对原文。"
			"只根据「资料」回答；资料没写到的内容要直说不知道或资料未覆盖，不要编造。"
			"语气简洁友好，用中文；必要时分点。引用资料时可用 [1]、[2] 对应来源编号。"
		)
		messages: list[tuple[str, str]] = [
			("system", system),
			("user", f"资料：\n{context}\n\n问题：{question}"),
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
