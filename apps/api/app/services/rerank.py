from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from app.settings import Settings

logger = logging.getLogger(__name__)


class RerankClient:
	"""Optional DashScope-compatible /reranks client (DustyKB-style hook)."""

	def __init__(self, settings: Settings) -> None:
		if not settings.llm_api_key:
			raise RuntimeError("OPENAI_API_KEY / DASHSCOPE_API_KEY is required for rerank")
		self.settings = settings
		self.endpoint = f"{settings.rerank_base_url.rstrip('/')}/reranks"

	def rerank(
		self,
		*,
		query: str,
		documents: list[str],
		top_n: int,
	) -> list[tuple[int, float]]:
		if not documents:
			return []

		started = time.perf_counter()
		response = httpx.post(
			self.endpoint,
			headers={"Authorization": f"Bearer {self.settings.llm_api_key}"},
			json={
				"model": self.settings.rerank_model,
				"query": query,
				"documents": documents,
				"top_n": min(top_n, len(documents)),
			},
			timeout=30.0,
		)
		response.raise_for_status()
		payload: dict[str, Any] = response.json()
		results = [
			(int(item["index"]), float(item["relevance_score"]))
			for item in payload.get("results", [])
		]
		logger.info(
			"llm.rerank model=%s docs=%s returned=%s duration_ms=%.1f",
			self.settings.rerank_model,
			len(documents),
			len(results),
			(time.perf_counter() - started) * 1000,
		)
		return results
