"""Shared AskGraph node helpers (debug merge, labels, citation indexes)."""

from __future__ import annotations

from typing import Any

from app.graph.state import AskState


def _merge_debug(state: AskState, **extra: Any) -> dict[str, Any]:
	debug = dict(state.get("retrieval_debug") or {})
	debug.update(extra)
	return debug


def _library_label(library_id: str | None) -> str:
	if not library_id:
		return "当前知识库"
	return library_id


def _renumber_citation_indexes(
	citations: list[dict[str, Any]],
) -> list[dict[str, Any]]:
	"""合并多路命中后重新编号为稳定唯一的 1..N（各路 retrieve 各自从 1 起编）。"""
	for index, item in enumerate(citations, start=1):
		item["index"] = index
	return citations
