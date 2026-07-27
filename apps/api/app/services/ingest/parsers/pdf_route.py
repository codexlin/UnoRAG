"""PDF 解析路由：数字 PDF → PyMuPDF；扫描/复杂 → MinerU。

不替换现有 PyMuPDF 解析器；MinerU 为补充路径。不可用时显式 degrade / fail，禁止静默空文档。
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable, Literal

from app.services.ingest.backends.base import ParseRequest
from app.services.ingest.backends.mineru import MinerUClientError, get_mineru_backend
from app.services.ingest.backends.mineru_circuit import get_mineru_circuit
from app.services.ingest.backends.pymupdf import PyMuPDFBackend
from app.services.ingest.ir import CancelCheck, DocumentIR, ParseProgressCallback
from app.services.ingest.parsers.pdf import PdfParseOptions, classify_page
from app.settings import Settings

logger = logging.getLogger(__name__)

PdfRouteMode = Literal["auto", "pymupdf", "mineru"]

# Soft-timeout / 429：必须上抛以便 worker 还 MinerU 槽并做长退避。
# 其余 MinerU 错误在 auto 模式且已有 PyMuPDF 节点时按 ADR degrade，禁止重试死循环。
_MINERU_SLOT_RETRY_CODES = frozenset(
	{"mineru_pending", "mineru_soft_timeout", "mineru_rate_limited"}
)
_DEGRADE_WARNING = "MinerU 不可用，已用基础解析（PyMuPDF）"


def should_upgrade_to_mineru(ir: DocumentIR) -> bool:
	"""PyMuPDF 结果含扫描/失败/VLM 待处理页，或完全无节点时，应尝试 MinerU。"""
	report = ir.parser_report
	if not ir.nodes:
		return True
	if report.needs_ocr_pages or report.failed_pages:
		return True
	if report.vlm_pending_pages and not report.vlm_pages:
		return True
	# 启发式：复杂页占比高（仅 complex meta）
	complex_pages = [
		n
		for n in ir.nodes
		if (n.meta or {}).get("page_kind") == "complex"
	]
	if complex_pages and len(complex_pages) >= max(1, len(ir.nodes) // 2):
		return True
	return False


def probe_needs_mineru(content: bytes) -> bool:
	"""轻量页信号：扫描 / 复杂 / 疑似双栏 → 建议 MinerU。"""
	try:
		import fitz
	except ImportError:
		return False
	document = fitz.open(stream=content, filetype="pdf")
	try:
		for page in document:
			raw = (page.get_text("text") or "").strip()
			import re

			char_count = len(re.sub(r"\s+", "", raw))
			images = page.get_images(full=True) or []
			image_count = len(images)
			page_rect = page.rect
			page_area = max(float(page_rect.width * page_rect.height), 1.0)
			image_area = 0.0
			blocks = []
			try:
				blocks = page.get_text("dict").get("blocks", [])
				for block in blocks:
					if block.get("type") == 1:
						bbox = block.get("bbox") or [0, 0, 0, 0]
						image_area += abs((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
			except Exception:
				image_area = page_area * min(0.9, 0.2 * image_count)
			if image_area <= 0 and image_count:
				image_area = page_area * min(0.9, 0.2 * image_count)
			ratio = min(1.0, image_area / page_area)
			kind = classify_page(
				char_count=char_count,
				image_area_ratio=ratio,
				image_count=image_count,
			)
			if kind in {"suspect_scan", "complex"}:
				return True
			if _looks_multi_column(blocks, page_width=float(page_rect.width)):
				return True
			if _looks_like_ruled_table(page, word_count=len(page.get_text("words") or [])):
				return True
	finally:
		document.close()
	return False


def _looks_like_ruled_table(page: Any, *, word_count: int) -> bool:
	"""Detect a substantial ruled table without upgrading decorative PDFs."""
	if word_count < 12:
		return False
	try:
		drawings = page.get_drawings() or []
	except Exception:
		return False
	horizontal = 0
	vertical = 0
	for drawing in drawings:
		for item in drawing.get("items") or []:
			kind = item[0] if item else None
			if kind == "l" and len(item) >= 3:
				start, end = item[1], item[2]
				dx = abs(float(end.x) - float(start.x))
				dy = abs(float(end.y) - float(start.y))
				if dx >= dy * 4 and dx >= 20:
					horizontal += 1
				elif dy >= dx * 4 and dy >= 20:
					vertical += 1
			elif kind == "re":
				# One rectangle contributes two horizontal and two vertical edges.
				horizontal += 2
				vertical += 2
	return horizontal >= 8 and vertical >= 6


def _looks_multi_column(blocks: list[dict[str, Any]], *, page_width: float) -> bool:
	"""粗检双栏：左右各有文本块且中间有明显空隙。"""
	text_blocks = [b for b in blocks if b.get("type") == 0 and b.get("bbox")]
	if len(text_blocks) < 4 or page_width <= 0:
		return False
	mid = page_width / 2
	left = 0
	right = 0
	for block in text_blocks:
		bbox = block.get("bbox") or [0, 0, 0, 0]
		x0, x1 = float(bbox[0]), float(bbox[2])
		cx = (x0 + x1) / 2
		if x1 < mid - page_width * 0.05:
			left += 1
		elif x0 > mid + page_width * 0.05:
			right += 1
	return left >= 2 and right >= 2


def parse_pdf_routed(
	*,
	content: bytes,
	filename: str,
	title: str,
	settings: Settings,
	doc_id: str | None = None,
	library_id: str = "",
	options: PdfParseOptions | None = None,
	mineru_backend: Any | None = None,
	progress_callback: ParseProgressCallback | None = None,
	cancel_check: CancelCheck | None = None,
	enhanced_parser_allowed: bool = True,
	provider_state: dict[str, Any] | None = None,
	provider_state_callback: Callable[[dict[str, Any]], None] | None = None,
	job_id: str | None = None,
	trace_id: str | None = None,
) -> DocumentIR:
	"""路由入口：保持 PyMuPDF 默认；策略允许时按需升级 MinerU。"""
	t0 = time.perf_counter()
	opts = options or PdfParseOptions()
	route_mode: PdfRouteMode = (settings.mineru_mode or "auto").strip().lower()  # type: ignore[assignment]
	if route_mode not in {"auto", "pymupdf", "mineru"}:
		route_mode = "auto"

	backend = mineru_backend if enhanced_parser_allowed else None
	if backend is None and enhanced_parser_allowed:
		backend = get_mineru_backend(
			enabled=settings.mineru_enabled,
			base_url=settings.resolved_mineru_self_hosted_url,
			provider=settings.resolved_mineru_provider,
			timeout_s=settings.mineru_timeout_s,
			soft_timeout_s=settings.mineru_soft_timeout_s,
			max_retries=settings.mineru_max_retries,
			parse_path=settings.mineru_parse_path,
			api_key_302=settings.mineru_302_api_key,
			external_parser_allowed=settings.external_parser_allowed,
			base_url_302=settings.mineru_302_base_url,
			upload_path_302=settings.mineru_302_upload_path,
			task_path_302=settings.mineru_302_task_path,
			poll_interval_s_302=settings.mineru_302_poll_interval_s,
			max_wait_s_302=settings.mineru_302_max_wait_s,
			cost_per_page_302=settings.mineru_302_cost_per_page,
			daily_budget_302=settings.mineru_302_daily_budget,
			budget_warn_ratio_302=settings.mineru_302_budget_warn_ratio,
			long_pending_s_302=settings.mineru_302_long_pending_s,
			parse_method=settings.mineru_parse_method,
			version=settings.mineru_version,
			use_fake=settings.mineru_use_fake,
		)

	# 全局强制 MinerU 不能覆盖知识库 text-only 策略。
	if route_mode == "mineru" and enhanced_parser_allowed:
		return _parse_mineru_or_fail(
			content=content,
			filename=filename,
			title=title,
			doc_id=doc_id,
			library_id=library_id,
			backend=backend,
			started=t0,
			pymupdf_ir=None,
			settings=settings,
			progress_callback=progress_callback,
			cancel_check=cancel_check,
			provider_state=provider_state,
			provider_state_callback=provider_state_callback,
			job_id=job_id,
			trace_id=trace_id,
		)

	# PyMuPDF 先跑（allow_empty 以便 MinerU 救援）
	pymupdf_opts = PdfParseOptions(
		scan_strategy=opts.scan_strategy,
		ocr_enabled=opts.ocr_enabled,
		vlm_enabled=opts.vlm_enabled,
		ocr_adapter=opts.ocr_adapter,
		vlm_adapter=opts.vlm_adapter,
		allow_empty=True,
		progress_callback=progress_callback,
		cancel_check=cancel_check,
	)
	pymupdf_ir = PyMuPDFBackend().parse(
		ParseRequest(
			content=content,
			filename=filename,
			title=title,
			doc_id=doc_id,
			library_id=library_id,
			options=pymupdf_opts,
		)
	)
	_stamp_latency(pymupdf_ir, t0)

	if not enhanced_parser_allowed:
		return _finalize_text_only(pymupdf_ir)

	if route_mode == "pymupdf":
		return _finalize_pymupdf(pymupdf_ir, settings=settings)

	# auto：正常数字 PDF 不升级
	upgrade = should_upgrade_to_mineru(pymupdf_ir) or probe_needs_mineru(content)
	if not upgrade:
		pymupdf_ir.parser_report.mode = "text"
		pymupdf_ir.parser_report.metrics["route"] = "pymupdf"
		return pymupdf_ir

	if backend is None:
		return _degrade_without_mineru(pymupdf_ir, settings=settings)

	try:
		mineru_ir = _call_mineru_with_circuit(
			backend=backend,
			content=content,
			filename=filename,
			title=title,
			doc_id=doc_id or pymupdf_ir.id,
			library_id=library_id,
			settings=settings,
			progress_callback=progress_callback,
			cancel_check=cancel_check,
			provider_state=provider_state,
			provider_state_callback=provider_state_callback,
			job_id=job_id,
			trace_id=trace_id,
		)
		_stamp_latency(mineru_ir, t0)
		mineru_ir.parser_report.metrics["route"] = "mineru"
		mineru_ir.parser_report.metrics["pymupdf_partial"] = bool(
			pymupdf_ir.parser_report.partial
		)
		# 归档解析器版本到 meta
		mineru_ir.meta["parser_backend"] = mineru_ir.parser_report.backend or "mineru"
		mineru_ir.meta["parser_version"] = mineru_ir.parser_report.parser_version
		return mineru_ir
	except MinerUClientError as exc:
		logger.warning(
			"mineru.degrade filename=%s err=%s code=%s retryable=%s nodes=%s",
			filename,
			exc,
			exc.code,
			exc.retryable,
			len(pymupdf_ir.nodes),
		)
		_attach_parser_report(exc, pymupdf_ir)
		# 临时容量压力：还槽 + job 级重试（即使已有 PyMuPDF 节点）。
		if exc.code in _MINERU_SLOT_RETRY_CODES:
			raise
		# ADR 0002：有 PyMuPDF 节点 → partial degrade；无节点 → 上抛（由 job 收尾）。
		if pymupdf_ir.nodes:
			return _apply_pymupdf_degrade(pymupdf_ir, exc=exc, started=t0)
		raise
	except ValueError as exc:
		wrapped = MinerUClientError(
			f"MinerU response could not be converted: {exc}",
			code="mineru_invalid_response",
		)
		_attach_parser_report(wrapped, pymupdf_ir)
		raise wrapped from exc


def _parse_mineru_or_fail(
	*,
	content: bytes,
	filename: str,
	title: str,
	doc_id: str | None,
	library_id: str,
	backend: Any | None,
	started: float,
	pymupdf_ir: DocumentIR | None,
	progress_callback: ParseProgressCallback | None,
	cancel_check: CancelCheck | None,
	settings: Settings | None = None,
	provider_state: dict[str, Any] | None = None,
	provider_state_callback: Callable[[dict[str, Any]], None] | None = None,
	job_id: str | None = None,
	trace_id: str | None = None,
) -> DocumentIR:
	if backend is None:
		raise MinerUClientError(
			"MINERU_MODE=mineru but MinerU is not configured "
			"(set MINERU_ENABLED=true and MINERU_URL, or MINERU_USE_FAKE=true for tests)",
			code="mineru_not_configured",
			retryable=False,
		)
	try:
		ir = _call_mineru_with_circuit(
			backend=backend,
			content=content,
			filename=filename,
			title=title,
			doc_id=doc_id,
			library_id=library_id,
			settings=settings,
			progress_callback=progress_callback,
			cancel_check=cancel_check,
			provider_state=provider_state,
			provider_state_callback=provider_state_callback,
			job_id=job_id,
			trace_id=trace_id,
		)
	except MinerUClientError:
		raise
	except ValueError as exc:
		if pymupdf_ir and pymupdf_ir.nodes:
			pymupdf_ir.parser_report.warnings.append(f"MinerU forced mode failed: {exc}")
			return _finalize_pymupdf(pymupdf_ir, settings=None)
		raise MinerUClientError(
			f"MinerU parse failed: {exc}",
			code="mineru_invalid_response",
		) from exc
	_stamp_latency(ir, started)
	ir.parser_report.metrics["route"] = "mineru_forced"
	return ir


def _call_mineru_with_circuit(
	*,
	backend: Any,
	content: bytes,
	filename: str,
	title: str,
	doc_id: str | None,
	library_id: str,
	settings: Settings | None,
	progress_callback: ParseProgressCallback | None,
	cancel_check: CancelCheck | None,
	provider_state: dict[str, Any] | None = None,
	provider_state_callback: Callable[[dict[str, Any]], None] | None = None,
	job_id: str | None = None,
	trace_id: str | None = None,
) -> DocumentIR:
	"""熔断检查 → 真实 HTTP/Fake；成功重置；unreachable 计入短窗。"""
	circuit = get_mineru_circuit()
	if settings is not None:
		circuit.configure(
			failure_threshold=settings.mineru_circuit_failure_threshold,
			open_seconds=settings.mineru_circuit_open_seconds,
		)
	if not circuit.allow_request():
		logger.info(
			"mineru.circuit_skip filename=%s state=%s",
			filename,
			circuit.state,
		)
		raise MinerUClientError(
			"MinerU circuit open: skipping HTTP after consecutive connection failures",
			code="mineru_circuit_open",
			retryable=False,
		)
	try:
		ir = backend.parse(
			ParseRequest(
				content=content,
				filename=filename,
				title=title,
				doc_id=doc_id,
				library_id=library_id,
				progress_callback=progress_callback,
				cancel_check=cancel_check,
				provider_state=provider_state,
				provider_state_callback=provider_state_callback,
				job_id=job_id,
				trace_id=trace_id,
			)
		)
	except MinerUClientError as exc:
		circuit.record_failure(exc.code)
		raise
	except BaseException:
		circuit.release_probe()
		raise
	circuit.record_success()
	return ir


def _apply_pymupdf_degrade(
	pymupdf_ir: DocumentIR,
	*,
	exc: MinerUClientError,
	started: float,
) -> DocumentIR:
	report = pymupdf_ir.parser_report
	report.partial = True
	if exc.code == "mineru_circuit_open":
		warning = f"{_DEGRADE_WARNING}（短窗熔断）"
	else:
		warning = f"{_DEGRADE_WARNING}: {exc}"
	report.warnings.append(warning)
	report.notes = (report.notes or "") + f"; mineru_degrade={exc}"
	report.metrics["route"] = "pymupdf_degrade"
	report.metrics["mineru_error"] = str(exc)
	report.metrics["mineru_error_code"] = exc.code
	if exc.code == "mineru_circuit_open":
		report.metrics["mineru_circuit"] = "open"
	_stamp_latency(pymupdf_ir, started)
	return pymupdf_ir


def _finalize_pymupdf(ir: DocumentIR, *, settings: Settings | None) -> DocumentIR:
	if not ir.nodes:
		raise ValueError(
			"PDF has no extractable text (possibly scanned); "
			"enable MinerU (MINERU_ENABLED + MINERU_URL) or OCR"
		)
	ir.parser_report.metrics["route"] = "pymupdf"
	if settings is not None and (
		ir.parser_report.needs_ocr_pages or ir.parser_report.failed_pages
	):
		ir.parser_report.warnings.append(
			"complex/scan pages present; MinerU disabled — partial PyMuPDF result"
		)
	return ir


def _finalize_text_only(ir: DocumentIR) -> DocumentIR:
	"""Strict scan_handling=disabled result: never call OCR or MinerU."""
	report = ir.parser_report
	report.metrics["route"] = "pymupdf_text_only"
	report.metrics["scan_handling"] = "disabled"
	if not ir.nodes:
		raise ValueError(
			"PDF has no extractable text (possibly scanned); "
			"scan recognition is disabled by library policy"
		)
	if report.needs_ocr_pages or report.failed_pages:
		report.partial = True
		report.warnings.append(
			"scan/complex pages skipped because scan recognition is disabled "
			"by library policy"
		)
	return ir


def _degrade_without_mineru(ir: DocumentIR, *, settings: Settings) -> DocumentIR:
	if ir.nodes:
		ir.parser_report.partial = True
		ir.parser_report.warnings.append(
			"MinerU not configured; keeping PyMuPDF partial "
			"(set MINERU_ENABLED=true and MINERU_URL)"
		)
		ir.parser_report.metrics["route"] = "pymupdf_no_mineru"
		return ir
	strategy = (settings.pdf_scan_strategy or "partial").strip().lower()
	msg = (
		"PDF has no extractable text (possibly scanned); "
		"enable MinerU (MINERU_ENABLED + MINERU_URL) or OCR"
	)
	if strategy == "fail" or not ir.nodes:
		raise ValueError(msg)
	raise ValueError(msg)


def _stamp_latency(ir: DocumentIR, started: float) -> None:
	ir.parser_report.latency_ms = round((time.perf_counter() - started) * 1000.0, 2)


def _attach_parser_report(error: MinerUClientError, ir: DocumentIR) -> None:
	report = ir.parser_report
	report.partial = True
	report.metrics["route"] = "mineru_failed"
	report.metrics["mineru_error_code"] = error.code
	report.metrics["mineru_status_code"] = error.status_code
	report.warnings.append(str(error))
	error.parser_report = report.to_public_dict()
