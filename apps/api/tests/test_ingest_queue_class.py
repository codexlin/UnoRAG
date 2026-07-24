"""Ingest queue_class slotting helpers + claim filter contract."""

from __future__ import annotations

from app.services.ingest.queue_class import (
	infer_queue_class,
	resolve_queue_class_after_probe,
)


def test_infer_queue_class_pdf_auto_else_local() -> None:
	assert infer_queue_class("quote.docx") == "local"
	assert infer_queue_class("notes.md", "text/markdown") == "local"
	assert infer_queue_class("scan.pdf") == "auto"
	assert infer_queue_class("x.bin", "application/pdf") == "auto"


def test_resolve_queue_class_respects_mineru_disabled(monkeypatch) -> None:
	def _boom(_content: bytes) -> bool:
		raise AssertionError("probe should not run when mineru disabled")

	monkeypatch.setattr(
		"app.services.ingest.parsers.pdf_route.probe_needs_mineru",
		_boom,
	)
	assert (
		resolve_queue_class_after_probe(
			filename="a.pdf",
			content_type="application/pdf",
			content=b"%PDF",
			mineru_enabled=False,
		)
		== "local"
	)


def test_resolve_queue_class_promotes_auto_to_mineru(monkeypatch) -> None:
	monkeypatch.setattr(
		"app.services.ingest.parsers.pdf_route.probe_needs_mineru",
		lambda _content: True,
	)
	assert (
		resolve_queue_class_after_probe(
			filename="ruled.pdf",
			content_type="application/pdf",
			content=b"%PDF",
			mineru_enabled=True,
		)
		== "mineru"
	)
	monkeypatch.setattr(
		"app.services.ingest.parsers.pdf_route.probe_needs_mineru",
		lambda _content: False,
	)
	assert (
		resolve_queue_class_after_probe(
			filename="simple.pdf",
			content_type="application/pdf",
			content=b"%PDF",
			mineru_enabled=True,
		)
		== "local"
	)
