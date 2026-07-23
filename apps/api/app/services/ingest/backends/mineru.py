"""MinerU 独立服务客户端：timeout / retry / 显式失败；禁止静默空文档。

环境变量见 Settings：MINERU_ENABLED / MINERU_URL / MINERU_TIMEOUT_S / MINERU_MAX_RETRIES。
本地无服务时用 FakeMinerUBackend 跑单测；指向真实服务时设 MINERU_URL。
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.services.ingest.adapters.mineru_ir import mineru_json_to_ir
from app.services.ingest.backends.base import ParseRequest
from app.services.ingest.ir import DocumentIR

logger = logging.getLogger(__name__)

DEFAULT_MINERU_VERSION = "2.x"
# Fake 默认 OCR 文案：与 leave-scanned 语义对齐（扫描请假制度）
_FAKE_SCANNED_TEXT = (
	"病假须于返岗后三个工作日内补交证明材料。"
	"逾期未交按事假处理。"
)


class MinerUClientError(RuntimeError):
	"""MinerU 服务调用失败（超时 / HTTP / 空结果）。"""


def _post_multipart(
	url: str,
	*,
	filename: str,
	content: bytes,
	timeout_s: float,
	extra_fields: dict[str, str] | None = None,
) -> bytes:
	"""最小 multipart 上传，避免强制依赖 httpx（urllib 足够）。"""
	boundary = f"----MeriKnowMinerU{int(time.time() * 1000)}"
	body = bytearray()
	fields = {"return_content_list": "true", **(extra_fields or {})}
	for key, value in fields.items():
		body.extend(f"--{boundary}\r\n".encode())
		body.extend(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode())
		body.extend(f"{value}\r\n".encode())
	body.extend(f"--{boundary}\r\n".encode())
	body.extend(
		(
			f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
			"Content-Type: application/pdf\r\n\r\n"
		).encode()
	)
	body.extend(content)
	body.extend(b"\r\n")
	body.extend(f"--{boundary}--\r\n".encode())

	req = Request(
		url,
		data=bytes(body),
		method="POST",
		headers={
			"Content-Type": f"multipart/form-data; boundary={boundary}",
			"Accept": "application/json",
		},
	)
	try:
		with urlopen(req, timeout=timeout_s) as resp:
			return resp.read()
	except HTTPError as exc:
		detail = exc.read().decode("utf-8", errors="replace")[:500]
		raise MinerUClientError(f"MinerU HTTP {exc.code}: {detail}") from exc
	except URLError as exc:
		raise MinerUClientError(f"MinerU unreachable: {exc.reason}") from exc
	except TimeoutError as exc:
		raise MinerUClientError(f"MinerU timeout after {timeout_s}s") from exc


class MinerUBackend:
	"""HTTP 调用独立 MinerU 服务，再经 content_list → DocumentIR。"""

	def __init__(
		self,
		*,
		base_url: str,
		timeout_s: float = 120.0,
		max_retries: int = 2,
		parse_path: str = "/parse",
		version: str = DEFAULT_MINERU_VERSION,
		post_fn: Callable[..., bytes] | None = None,
	) -> None:
		self.base_url = base_url.rstrip("/")
		self.timeout_s = timeout_s
		self.max_retries = max(0, int(max_retries))
		self.parse_path = parse_path if parse_path.startswith("/") else f"/{parse_path}"
		self._version = version
		self._post_fn = post_fn or _post_multipart

	@property
	def name(self) -> str:
		return "mineru"

	@property
	def version(self) -> str:
		return self._version

	def parse(self, request: ParseRequest) -> DocumentIR:
		url = f"{self.base_url}{self.parse_path}"
		last_exc: Exception | None = None
		attempts = self.max_retries + 1
		t0 = time.perf_counter()
		raw: bytes | None = None
		for attempt in range(1, attempts + 1):
			try:
				raw = self._post_fn(
					url,
					filename=request.filename,
					content=request.content,
					timeout_s=self.timeout_s,
				)
				break
			except MinerUClientError as exc:
				last_exc = exc
				logger.warning(
					"mineru.parse.retry attempt=%s/%s err=%s",
					attempt,
					attempts,
					exc,
				)
				if attempt >= attempts:
					raise
				time.sleep(min(0.5 * attempt, 2.0))
		if raw is None:
			raise MinerUClientError(str(last_exc or "MinerU request failed"))

		try:
			payload = json.loads(raw.decode("utf-8"))
		except (UnicodeDecodeError, json.JSONDecodeError) as exc:
			raise MinerUClientError("MinerU response is not valid JSON") from exc
		if not isinstance(payload, dict):
			raise MinerUClientError("MinerU response JSON must be an object")

		latency_ms = (time.perf_counter() - t0) * 1000.0
		return mineru_json_to_ir(
			payload=payload,
			filename=request.filename,
			title=request.title,
			content=request.content,
			doc_id=request.doc_id,
			library_id=request.library_id,
			parser_version=str(payload.get("version") or self.version),
			latency_ms=latency_ms,
		)


class FakeMinerUBackend:
	"""单测 / 本地无服务：按文件名返回可控 content_list，不走网络。"""

	def __init__(
		self,
		*,
		fixture_loader: Callable[[str], dict[str, Any]] | None = None,
		version: str = "fake-1.0",
		fail: bool = False,
	) -> None:
		self._fixture_loader = fixture_loader
		self._version = version
		self._fail = fail

	@property
	def name(self) -> str:
		return "mineru"

	@property
	def version(self) -> str:
		return self._version

	def parse(self, request: ParseRequest) -> DocumentIR:
		if self._fail:
			raise MinerUClientError("FakeMinerUBackend forced failure")
		t0 = time.perf_counter()
		if self._fixture_loader is not None:
			payload = self._fixture_loader(request.filename)
		else:
			payload = self._default_payload(request.filename)
		latency_ms = (time.perf_counter() - t0) * 1000.0
		return mineru_json_to_ir(
			payload=payload,
			filename=request.filename,
			title=request.title,
			content=request.content,
			doc_id=request.doc_id,
			library_id=request.library_id,
			parser_version=self.version,
			latency_ms=latency_ms,
		)

	def _default_payload(self, filename: str) -> dict[str, Any]:
		name = (filename or "").lower()
		if "scanned" in name or "scan" in name:
			return {
				"version": self.version,
				"content_list": [
					{
						"type": "text",
						"text": "请假制度（扫描件 OCR）",
						"text_level": 1,
						"page_idx": 0,
						"bbox": [100, 80, 900, 140],
					},
					{
						"type": "text",
						"text": _FAKE_SCANNED_TEXT,
						"page_idx": 0,
						"bbox": [100, 160, 900, 400],
					},
				],
			}
		if "dual" in name or "column" in name:
			return {
				"version": self.version,
				"content_list": [
					{
						"type": "text",
						"text": "双栏版式左栏：考勤须知",
						"text_level": 2,
						"page_idx": 0,
						"bbox": [50, 80, 480, 140],
					},
					{
						"type": "text",
						"text": "左栏正文：打卡不得代打。",
						"page_idx": 0,
						"bbox": [50, 160, 480, 400],
					},
					{
						"type": "text",
						"text": "双栏版式右栏：出差报销",
						"text_level": 2,
						"page_idx": 0,
						"bbox": [520, 80, 950, 140],
					},
					{
						"type": "text",
						"text": "右栏正文：报销须附行程单。",
						"page_idx": 0,
						"bbox": [520, 160, 950, 400],
					},
				],
			}
		# 默认：跨页表 + 公式 + 图注
		return {
			"version": self.version,
			"content_list": [
				{
					"type": "text",
					"text": "复杂文档样例",
					"text_level": 1,
					"page_idx": 0,
					"bbox": [100, 60, 800, 120],
				},
				{
					"type": "table",
					"table_caption": ["跨页供应商报价表（续）"],
					"table_body": (
						"<table><tr><th>供应商</th><th>报价</th></tr>"
						"<tr><td>甲公司</td><td>120000</td></tr>"
						"<tr><td>乙公司</td><td>80000</td></tr></table>"
					),
					"page_idx": 0,
					"bbox": [80, 140, 920, 420],
				},
				{
					"type": "table",
					"table_caption": ["跨页供应商报价表（第2页）"],
					"table_body": (
						"<table><tr><th>供应商</th><th>报价</th></tr>"
						"<tr><td>丙公司</td><td>95000</td></tr></table>"
					),
					"page_idx": 1,
					"bbox": [80, 100, 920, 300],
				},
				{
					"type": "equation",
					"text": "E = mc^2",
					"text_format": "latex",
					"page_idx": 1,
					"bbox": [120, 340, 400, 400],
				},
				{
					"type": "image",
					"img_caption": ["图1 设备须断电后再检修"],
					"page_idx": 1,
					"bbox": [120, 420, 700, 780],
				},
			],
		}


def get_mineru_backend(
	*,
	enabled: bool,
	base_url: str,
	timeout_s: float = 120.0,
	max_retries: int = 2,
	parse_path: str = "/parse",
	use_fake: bool = False,
	fake_backend: FakeMinerUBackend | None = None,
) -> MinerUBackend | FakeMinerUBackend | None:
	if not enabled:
		return None
	if use_fake or fake_backend is not None:
		return fake_backend or FakeMinerUBackend()
	url = (base_url or "").strip()
	if not url:
		return None
	return MinerUBackend(
		base_url=url,
		timeout_s=timeout_s,
		max_retries=max_retries,
		parse_path=parse_path,
	)
