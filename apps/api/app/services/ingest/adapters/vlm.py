"""VLM adapter — 仅 complex 页/图按需调用；无密钥时 NoOp（标记 vlm_pending）。"""

from __future__ import annotations

import base64
import logging
from typing import Protocol, runtime_checkable

logger = logging.getLogger(__name__)


@runtime_checkable
class VlmAdapter(Protocol):
	def describe_image(
		self,
		image_bytes: bytes,
		*,
		page_number: int | None = None,
		hint: str = "",
	) -> str:
		...


class NoOpVlmAdapter:
	"""显式 no-op：不假装理解了复杂页。"""

	def describe_image(
		self,
		image_bytes: bytes,
		*,
		page_number: int | None = None,
		hint: str = "",
	) -> str:
		return ""


class OpenAICompatibleVlmAdapter:
	"""可选：走现有 OpenAI-compatible chat（多模态模型时才有意义）。"""

	def __init__(self, *, api_key: str, base_url: str, model: str) -> None:
		self.api_key = api_key
		self.base_url = base_url.rstrip("/")
		self.model = model

	def describe_image(
		self,
		image_bytes: bytes,
		*,
		page_number: int | None = None,
		hint: str = "",
	) -> str:
		import httpx

		b64 = base64.b64encode(image_bytes).decode("ascii")
		prompt = (
			"用中文简要描述此文档页中的表格、流程图或关键文字要点，便于检索。"
			f" {hint}".strip()
		)
		payload = {
			"model": self.model,
			"messages": [
				{
					"role": "user",
					"content": [
						{"type": "text", "text": prompt},
						{
							"type": "image_url",
							"image_url": {"url": f"data:image/png;base64,{b64}"},
						},
					],
				}
			],
			"max_tokens": 512,
		}
		headers = {
			"Authorization": f"Bearer {self.api_key}",
			"Content-Type": "application/json",
		}
		with httpx.Client(timeout=60.0) as client:
			resp = client.post(f"{self.base_url}/chat/completions", json=payload, headers=headers)
			resp.raise_for_status()
			data = resp.json()
		try:
			return str(data["choices"][0]["message"]["content"]).strip()
		except (KeyError, IndexError, TypeError) as exc:
			raise RuntimeError(f"unexpected VLM response: {exc}") from exc


def get_vlm_adapter(
	*,
	enabled: bool,
	api_key: str = "",
	base_url: str = "",
	model: str = "",
) -> VlmAdapter | None:
	if not enabled:
		return None
	if not (api_key or "").strip():
		logger.info("vlm.disabled reason=missing_api_key")
		return NoOpVlmAdapter()
	return OpenAICompatibleVlmAdapter(
		api_key=api_key.strip(),
		base_url=base_url or "https://dashscope.aliyuncs.com/compatible-mode/v1",
		model=model or "qwen-vl-plus",
	)
