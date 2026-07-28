#!/usr/bin/env python3
"""Deterministic scan-policy smoke with a real unreachable MinerU HTTP route."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import fitz

from app.services.ingest.adapters.ocr import StubOcrAdapter
from app.services.ingest.backends.base import ParseRequest
from app.services.ingest.backends.mineru import MinerUClientError
from app.services.ingest.backends.mineru_circuit import reset_mineru_circuit
from app.services.ingest.parsers.pdf import PdfParseOptions
from app.services.ingest.parsers.pdf_route import parse_pdf_routed, probe_needs_mineru
from app.services.policy_profiles import resolve_document_policy
from app.settings import Settings


ROOT = Path(__file__).resolve().parents[2]


class ForbiddenMinerU:
	"""Fail immediately if strict text-only routing ever touches MinerU."""

	name = "forbidden-mineru"
	version = "smoke"

	def parse(self, request: ParseRequest) -> Any:
		raise AssertionError(
			f"scan_handling=disabled attempted MinerU for {request.filename}"
		)


def _git(*args: str) -> str:
	result = subprocess.run(
		["git", "-C", str(ROOT), *args],
		check=True,
		capture_output=True,
		text=True,
	)
	return result.stdout.strip()


def _closed_loopback_url() -> str:
	"""Reserve then release an ephemeral port so the next request is refused."""
	with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
		sock.bind(("127.0.0.1", 0))
		port = int(sock.getsockname()[1])
	return f"http://127.0.0.1:{port}"


def _make_pdf(*, text_page: bool, scan_page: bool) -> bytes:
	document = fitz.open()
	try:
		if text_page:
			page = document.new_page()
			page.insert_textbox(
				fitz.Rect(50, 50, 540, 780),
				"Extractable policy text. " * 20,
				fontsize=11,
			)
		if scan_page:
			page = document.new_page()
			pixmap = fitz.Pixmap(
				fitz.csRGB,
				fitz.IRect(0, 0, 500, 700),
				False,
			)
			pixmap.clear_with(225)
			page.insert_image(page.rect, pixmap=pixmap)
		return document.tobytes()
	finally:
		document.close()


def _settings(mineru_url: str) -> Settings:
	return Settings(
		ask_mode="stub",
		metadata_backend="json",
		ocr_enabled=False,
		vlm_enabled=False,
		mineru_enabled=True,
		mineru_url=mineru_url,
		mineru_mode="auto",
		mineru_timeout_s=0.5,
		mineru_soft_timeout_s=0,
		mineru_max_retries=0,
		mineru_circuit_failure_threshold=99,
	)


def _error_report(error: MinerUClientError) -> dict[str, Any]:
	report = error.parser_report or {}
	metrics = report.get("metrics") or {}
	return {
		"outcome": "explicit_failure",
		"code": error.code,
		"route": metrics.get("route"),
		"warnings": report.get("warnings") or [],
	}


def run_smoke(results: dict[str, Any]) -> None:
	mineru_url = _closed_loopback_url()
	settings = _settings(mineru_url)
	mixed = _make_pdf(text_page=True, scan_page=True)
	scanned = _make_pdf(text_page=False, scan_page=True)

	results["fault_target"] = {
		"kind": "released_ephemeral_loopback_port",
		"url": mineru_url,
	}
	results["probe"] = {
		"mixed_needs_enhanced_parser": probe_needs_mineru(mixed),
		"scan_needs_enhanced_parser": probe_needs_mineru(scanned),
	}
	assert all(results["probe"].values())

	reset_mineru_circuit(failure_threshold=99)
	auto_mixed = parse_pdf_routed(
		content=mixed,
		filename="mixed.pdf",
		title="mixed",
		settings=settings,
		options=PdfParseOptions(ocr_enabled=False, vlm_enabled=False),
	)
	results["auto_mixed_unreachable"] = {
		"outcome": "partial_success",
		"nodes": len(auto_mixed.nodes),
		"partial": auto_mixed.parser_report.partial,
		"route": auto_mixed.parser_report.metrics.get("route"),
		"mineru_error_code": auto_mixed.parser_report.metrics.get(
			"mineru_error_code"
		),
	}
	assert results["auto_mixed_unreachable"] == {
		"outcome": "partial_success",
		"nodes": 1,
		"partial": True,
		"route": "pymupdf_degrade",
		"mineru_error_code": "mineru_unreachable",
	}

	reset_mineru_circuit(failure_threshold=99)
	try:
		parse_pdf_routed(
			content=scanned,
			filename="scan.pdf",
			title="scan",
			settings=settings,
			options=PdfParseOptions(ocr_enabled=False, vlm_enabled=False),
		)
	except MinerUClientError as error:
		results["auto_scan_unreachable"] = _error_report(error)
	else:
		raise AssertionError("pure scanned auto ingest unexpectedly succeeded")
	assert results["auto_scan_unreachable"]["code"] == "mineru_unreachable"
	assert results["auto_scan_unreachable"]["route"] == "mineru_failed"

	disabled_mixed = parse_pdf_routed(
		content=mixed,
		filename="mixed.pdf",
		title="mixed",
		settings=settings,
		options=PdfParseOptions(ocr_enabled=False, vlm_enabled=False),
		mineru_backend=ForbiddenMinerU(),
		enhanced_parser_allowed=False,
	)
	results["disabled_mixed"] = {
		"outcome": "partial_text_only",
		"nodes": len(disabled_mixed.nodes),
		"partial": disabled_mixed.parser_report.partial,
		"route": disabled_mixed.parser_report.metrics.get("route"),
		"scan_handling": disabled_mixed.parser_report.metrics.get(
			"scan_handling"
		),
	}
	assert results["disabled_mixed"] == {
		"outcome": "partial_text_only",
		"nodes": 1,
		"partial": True,
		"route": "pymupdf_text_only",
		"scan_handling": "disabled",
	}

	try:
		parse_pdf_routed(
			content=scanned,
			filename="scan.pdf",
			title="scan",
			settings=settings,
			options=PdfParseOptions(ocr_enabled=False, vlm_enabled=False),
			mineru_backend=ForbiddenMinerU(),
			enhanced_parser_allowed=False,
		)
	except ValueError as error:
		results["disabled_scan"] = {
			"outcome": "explicit_failure",
			"message": str(error),
		}
	else:
		raise AssertionError("pure scanned text-only ingest unexpectedly succeeded")
	assert "scan recognition is disabled by library policy" in results[
		"disabled_scan"
	]["message"]

	reset_mineru_circuit(failure_threshold=99)
	try:
		parse_pdf_routed(
			content=scanned,
			filename="scan.pdf",
			title="scan",
			settings=settings,
			options=PdfParseOptions(
				ocr_enabled=True,
				vlm_enabled=False,
				ocr_adapter=StubOcrAdapter(),
			),
		)
	except MinerUClientError as error:
		results["force_ocr_without_local_or_mineru"] = _error_report(error)
	else:
		raise AssertionError("force_ocr scan unexpectedly succeeded without an OCR backend")
	assert results["force_ocr_without_local_or_mineru"]["code"] == "mineru_unreachable"
	assert results["force_ocr_without_local_or_mineru"]["route"] == "mineru_failed"
	assert any(
		"OCR failed" in warning
		for warning in results["force_ocr_without_local_or_mineru"]["warnings"]
	)

	results["resolved_policy"] = {
		name: resolve_document_policy(scan_handling=name).as_dict()
		for name in ("auto", "disabled", "force_ocr")
	}
	assert results["resolved_policy"]["disabled"]["ocr_enabled"] is False
	assert (
		results["resolved_policy"]["disabled"]["enhanced_parser_allowed"] is False
	)
	assert results["resolved_policy"]["force_ocr"]["ocr_enabled"] is True


def _write_report(path: Path, payload: dict[str, Any]) -> str:
	path.parent.mkdir(parents=True, exist_ok=True)
	text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
	path.write_text(text, encoding="utf-8")
	path.chmod(0o600)
	digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
	checksum_path = Path(f"{path}.sha256")
	checksum_path.write_text(f"{digest}  {path.name}\n", encoding="utf-8")
	checksum_path.chmod(0o600)
	return digest


def main() -> int:
	parser = argparse.ArgumentParser()
	parser.add_argument(
		"--report",
		type=Path,
		default=ROOT / "scripts/acceptance/.ocr_policy_last_run.json",
	)
	args = parser.parse_args()

	results: dict[str, Any] = {}
	status = "PASS"
	detail = "all scan-policy and MinerU-unavailable assertions passed"
	try:
		run_smoke(results)
	except Exception as error:
		status = "FAIL"
		detail = f"{type(error).__name__}: {error}"

	script_bytes = Path(__file__).read_bytes()
	payload = {
		"suite": "OCR policy + MinerU unavailable smoke",
		"status": status,
		"detail": detail,
		"rc_sha": os.getenv("UNORAG_RC_SHA") or _git("rev-parse", "HEAD"),
		"git_head": _git("rev-parse", "HEAD"),
		"git_status_porcelain": _git("status", "--porcelain"),
		"script_sha256": hashlib.sha256(script_bytes).hexdigest(),
		"results": results,
		"finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
	}
	digest = _write_report(args.report, payload)
	print(f"report → {args.report}")
	print(f"sha256 → {digest}")
	print(f"status → {status}: {detail}")
	return 0 if status == "PASS" else 1


if __name__ == "__main__":
	sys.exit(main())
